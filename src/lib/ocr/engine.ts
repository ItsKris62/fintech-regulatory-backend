import { spawn } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import type { OcrConfig } from './config';

export interface OcrEngineResult {
  engine: 'ocrmypdf';
  engineVersion: string | null;
  text: string;
  durationMs: number;
}

interface SpawnResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function runCommand(command: string, args: string[], timeoutMs: number, pathPrefix?: string): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
      env: {
        ...process.env,
        ...(pathPrefix
          ? { PATH: `${pathPrefix}${path.delimiter}${process.env.PATH ?? ''}` }
          : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, signal, stdout, stderr, timedOut });
    });
  });
}

export async function getOcrEngineVersion(timeoutMs = 5_000): Promise<string | null> {
  const command = process.env.OCR_COMMAND?.trim() || 'ocrmypdf';
  const commandArgs = command === 'py' ? ['-m', 'ocrmypdf'] : [];
  const pathPrefix = process.env.OCR_PATH_PREFIX?.trim() || undefined;
  try {
    const result = await runCommand(command, [...commandArgs, '--version'], timeoutMs, pathPrefix);
    if (result.exitCode !== 0) return null;
    return result.stdout.trim() || result.stderr.trim() || null;
  } catch {
    return null;
  }
}

export async function runOcrMyPdf(buffer: Buffer, config: OcrConfig): Promise<OcrEngineResult> {
  const engineVersion = await getOcrEngineVersion(config.versionTimeoutMs);
  if (!engineVersion) {
    throw new Error('OCR engine unavailable: ocrmypdf was not found on PATH or did not return a version.');
  }

  const startedAt = Date.now();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sheriabot-ocr-'));
  const inputPath = path.join(tempDir, 'source.pdf');
  const outputPath = path.join(tempDir, 'ocr-output.pdf');
  const sidecarPath = path.join(tempDir, 'ocr-output.txt');

  try {
    await fs.writeFile(inputPath, buffer);

    const result = await runCommand(
      config.command,
      [
        ...config.commandArgs,
        '--output-type',
        'pdf',
        '--rasterizer',
        'pypdfium',
        '--skip-text',
        '--sidecar',
        sidecarPath,
        '--jobs',
        '1',
        '--tesseract-timeout',
        String(Math.max(1, Math.ceil(config.timeoutMs / 1000))),
        inputPath,
        outputPath,
      ],
      config.timeoutMs,
      config.pathPrefix,
    );

    if (result.timedOut) {
      throw new Error(`OCR timed out after ${config.timeoutMs}ms`);
    }
    if (result.exitCode !== 0) {
      const message = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
      throw new Error(`OCR failed: ${message.slice(0, 500)}`);
    }

    const text = await fs.readFile(sidecarPath, 'utf-8');
    return {
      engine: 'ocrmypdf',
      engineVersion,
      text,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}
