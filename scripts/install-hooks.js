const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const gitHooksDir = path.join(repoRoot, '.git', 'hooks');
const sourceHook = path.join(__dirname, 'hooks', 'pre-push');
const targetHook = path.join(gitHooksDir, 'pre-push');

if (!fs.existsSync(sourceHook)) {
  console.error(`Error: Source hook not found at ${sourceHook}`);
  process.exit(1);
}

if (!fs.existsSync(gitHooksDir)) {
  fs.mkdirSync(gitHooksDir, { recursive: true });
}

fs.copyFileSync(sourceHook, targetHook);

try {
  fs.chmodSync(targetHook, 0o755);
} catch (err) {
  // chmod may not apply on native Windows filesystems
}

console.log(`Successfully installed git hook to ${targetHook}`);
