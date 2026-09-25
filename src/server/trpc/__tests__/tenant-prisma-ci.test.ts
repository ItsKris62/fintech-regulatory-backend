import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import ts from 'typescript';
import { TENANT_MODEL_FIELD_MAP } from '@/lib/prisma/tenant-scope.extension';

export interface AstViolation {
  file: string;
  line: number;
  type: 'direct_prisma_import' | 'destructured_prisma' | 'raw_prisma_model_access';
  detail: string;
}

export function scanRouterAst(filePath: string, code: string, tenantModels: Set<string>): AstViolation[] {
  const violations: AstViolation[] = [];
  const sourceFile = ts.createSourceFile(filePath, code, ts.ScriptTarget.Latest, true);

  const ctxAliases = new Set<string>(['ctx']);
  const directPrismaIdentifiers = new Set<string>();

  function getLine(pos: number): number {
    return sourceFile.getLineAndCharacterOfPosition(pos).line + 1;
  }

  ts.forEachChild(sourceFile, function visit(node: ts.Node) {
    // 1. Detect direct import of prisma instance into user-facing routers
    if (ts.isImportDeclaration(node)) {
      const moduleSpecifier = node.moduleSpecifier.getText(sourceFile).replace(/['"]/g, '');
      if (moduleSpecifier.includes('/prisma/client') || moduleSpecifier === '@prisma/client') {
        if (node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
          for (const element of node.importClause.namedBindings.elements) {
            const importName = element.propertyName ? element.propertyName.text : element.name.text;
            if (importName === 'prisma') {
              violations.push({
                file: filePath,
                line: getLine(element.getStart(sourceFile)),
                type: 'direct_prisma_import',
                detail: `Direct import of raw prisma instance from "${moduleSpecifier}". User-facing routers must only use ctx.tenantPrisma.`,
              });
              directPrismaIdentifiers.add(element.name.text);
            }
          }
        }
      }
    }

    // 2. Variable declarations that alias ctx or destructure prisma from ctx
    if (ts.isVariableDeclaration(node)) {
      if (node.initializer) {
        const initText = node.initializer.getText(sourceFile);
        if (ctxAliases.has(initText) || initText.endsWith('.ctx')) {
          if (ts.isObjectBindingPattern(node.name)) {
            for (const element of node.name.elements) {
              const propName = element.propertyName ? element.propertyName.getText(sourceFile) : element.name.getText(sourceFile);
              if (propName === 'prisma') {
                violations.push({
                  file: filePath,
                  line: getLine(element.getStart(sourceFile)),
                  type: 'destructured_prisma',
                  detail: `Destructured raw "prisma" from ctx. User-facing routers must use ctx.tenantPrisma.`,
                });
                directPrismaIdentifiers.add(element.name.getText(sourceFile));
              }
            }
          } else if (ts.isIdentifier(node.name)) {
            ctxAliases.add(node.name.text);
          }
        }
      }
    }

    // 3. Parameter destructuring: ({ ctx: { prisma } })
    if (ts.isParameter(node)) {
      if (node.name && ts.isObjectBindingPattern(node.name)) {
        for (const el of node.name.elements) {
          const propName = el.propertyName ? el.propertyName.getText(sourceFile) : el.name.getText(sourceFile);
          if (propName === 'ctx' && el.name && ts.isObjectBindingPattern(el.name)) {
            for (const subEl of el.name.elements) {
              const subProp = subEl.propertyName ? subEl.propertyName.getText(sourceFile) : subEl.name.getText(sourceFile);
              if (subProp === 'prisma') {
                violations.push({
                  file: filePath,
                  line: getLine(subEl.getStart(sourceFile)),
                  type: 'destructured_prisma',
                  detail: `Destructured raw "prisma" from ctx parameter. User-facing routers must use ctx.tenantPrisma.`,
                });
                directPrismaIdentifiers.add(subEl.name.getText(sourceFile));
              }
            }
          }
        }
      }
    }

    // 4. Property access expression: handles multi-line chains, aliased ctx, direct prisma
    if (ts.isPropertyAccessExpression(node)) {
      const modelName = node.name.text;
      if (tenantModels.has(modelName)) {
        const targetExpr = node.expression;
        let isViolation = false;
        let detail = '';

        if (ts.isPropertyAccessExpression(targetExpr)) {
          const objText = targetExpr.expression.getText(sourceFile);
          const propText = targetExpr.name.text;

          if (ctxAliases.has(objText) && propText === 'prisma') {
            isViolation = true;
            detail = `Direct query on tenant model "${modelName}" via "${objText}.prisma" instead of "ctx.tenantPrisma".`;
          }
        } else if (ts.isIdentifier(targetExpr)) {
          if (directPrismaIdentifiers.has(targetExpr.text) || targetExpr.text === 'prisma') {
            isViolation = true;
            detail = `Direct query on tenant model "${modelName}" via raw "${targetExpr.text}" instead of "ctx.tenantPrisma".`;
          }
        }

        if (isViolation) {
          violations.push({
            file: filePath,
            line: getLine(node.getStart(sourceFile)),
            type: 'raw_prisma_model_access',
            detail,
          });
        }
      }
    }

    ts.forEachChild(node, visit);
  });

  return violations;
}

describe('CI Tenant Isolation Guard: TypeScript AST Compiler API (audit SEC-12)', () => {
  const routersDir = resolve(__dirname, '../../routers');
  const routerFiles = readdirSync(routersDir).filter(
    (f) => f.endsWith('.router.ts') && !f.includes('admin') && !f.includes('.test.')
  );

  // Convert PascalCase model names from TENANT_MODEL_FIELD_MAP to camelCase Prisma model accessors (excluding User)
  const tenantModelAccessors = new Set(
    Object.keys(TENANT_MODEL_FIELD_MAP)
      .map((m) => m.charAt(0).toLowerCase() + m.slice(1))
      .filter((m) => m !== 'user')
  );

  it('scans all user-facing routers using TypeScript AST parser and fails if any tenant-scoped model is accessed via raw prisma', () => {
    const allViolations: AstViolation[] = [];

    for (const file of routerFiles) {
      const fullPath = join(routersDir, file);
      const code = readFileSync(fullPath, 'utf8');
      const violations = scanRouterAst(file, code, tenantModelAccessors);
      allViolations.push(...violations);
    }

    if (allViolations.length > 0) {
      const formatted = allViolations
        .map((v) => `  [VIOLATION] ${v.file}:${v.line} (${v.type}):\n    ${v.detail}`)
        .join('\n\n');

      expect.fail(
        `Found ${allViolations.length} tenant isolation violations in user-facing routers.\n` +
        `User-facing procedures must exclusively use ctx.tenantPrisma to prevent cross-tenant data leaks.\n\n` +
        formatted
      );
    }

    expect(allViolations).toHaveLength(0);
  }, 30000);

  it('proves AST analysis catches multi-line property chains that regex misses', () => {
    const multiLineBadCode = `
      export async function testHandler(ctx: any) {
        return await ctx
          .prisma
          .legalDocument
          .findMany({});
      }
    `;

    const violations = scanRouterAst('synthetic-multiline.ts', multiLineBadCode, tenantModelAccessors);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0].type).toBe('raw_prisma_model_access');
    expect(violations[0].detail).toContain('legalDocument');
  });

  it('proves AST analysis catches aliased ctx that regex misses', () => {
    const aliasedCtxCode = `
      export async function testHandler(ctx: any) {
        const c = ctx;
        return await c.prisma.policy.findMany({});
      }
    `;

    const violations = scanRouterAst('synthetic-aliased.ts', aliasedCtxCode, tenantModelAccessors);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0].type).toBe('raw_prisma_model_access');
    expect(violations[0].detail).toContain('policy');
  });

  it('proves AST analysis catches destructured prisma that regex misses', () => {
    const destructuredCode = `
      export async function testHandler(ctx: any) {
        const { prisma } = ctx;
        return await prisma.complianceQuery.findMany({});
      }
    `;

    const violations = scanRouterAst('synthetic-destructured.ts', destructuredCode, tenantModelAccessors);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.type === 'destructured_prisma')).toBe(true);
    expect(violations.some((v) => v.type === 'raw_prisma_model_access')).toBe(true);
  });

  it('proves AST analysis catches direct imports of prisma from @/lib/prisma/client', () => {
    const directImportCode = `
      import { prisma } from '@/lib/prisma/client';
      export async function testHandler() {
        return await prisma.regulatoryApplication.findMany({});
      }
    `;

    const violations = scanRouterAst('synthetic-import.ts', directImportCode, tenantModelAccessors);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.type === 'direct_prisma_import')).toBe(true);
  });

  it('proves AST analysis catches ctx.prisma.payment (tenant model Payment with orgId)', () => {
    const paymentViolationCode = `
      export async function testPaymentHandler(ctx: any) {
        return await ctx.prisma.payment.findMany({});
      }
    `;

    const violations = scanRouterAst('synthetic-payment.ts', paymentViolationCode, tenantModelAccessors);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.type === 'raw_prisma_model_access')).toBe(true);
    expect(violations[0].detail).toContain('payment');
  });

  it('proves ESLint fails on test fixture accessing ctx.prisma.payment derived from TENANT_MODEL_FIELD_MAP', async () => {
    const { ESLint } = await import('eslint');
    const eslint = new ESLint();
    const paymentViolationCode = `
      export async function testPaymentHandler(ctx: any) {
        return await ctx.prisma.payment.findMany({});
      }
    `;

    const results = await eslint.lintText(paymentViolationCode, {
      filePath: resolve(__dirname, '../../routers/synthetic-payment.router.ts'),
    });

    expect(results).toHaveLength(1);
    const messages = results[0].messages;
    const ruleViolation = messages.find(
      (m) =>
        m.ruleId === 'no-restricted-syntax' &&
        m.message.includes('F-03 Tenant Isolation') &&
        m.message.includes('ctx.tenantPrisma')
    );

    expect(ruleViolation).toBeDefined();
    expect(results[0].errorCount).toBeGreaterThan(0);
  }, 30000);

  it('proves ESLint fails on fixture router accessing ctx.prisma.user and passes on auth.router.ts (P1.1-A)', async () => {
    const { ESLint } = await import('eslint');
    const eslint = new ESLint();
    const userViolationCode = `
      export async function testUserHandler(ctx: any) {
        return await ctx.prisma.user.findMany({});
      }
    `;

    // Fixture in a generic router should trigger the rule
    const genericResults = await eslint.lintText(userViolationCode, {
      filePath: resolve(__dirname, '../../routers/synthetic-user.router.ts'),
    });
    expect(genericResults).toHaveLength(1);
    const userViolation = genericResults[0].messages.find(
      (m) =>
        m.ruleId === 'no-restricted-syntax' &&
        m.message.includes('F-03 Tenant Isolation') &&
        m.message.includes('ctx.tenantPrisma')
    );
    expect(userViolation).toBeDefined();

    // Fixture in auth.router.ts should be ignored and pass without violation
    const authResults = await eslint.lintText(userViolationCode, {
      filePath: resolve(__dirname, '../../routers/auth.router.ts'),
    });
    expect(authResults).toHaveLength(1);
    const authViolation = authResults[0].messages.find(
      (m) =>
        m.ruleId === 'no-restricted-syntax' &&
        m.message.includes('F-03 Tenant Isolation')
    );
    expect(authViolation).toBeUndefined();
  }, 30000);
});
