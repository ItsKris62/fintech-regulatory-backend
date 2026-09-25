const fs = require("fs");
const path = require("path");
const ts = require("@typescript-eslint/eslint-plugin");
const tsParser = require("@typescript-eslint/parser");

/**
 * Dynamically derives tenant models from TENANT_MODEL_FIELD_MAP at lint time
 * to prevent drift between the Prisma extension and ESLint rules.
 */
function getTenantModelsPattern() {
  const extensionPath = path.resolve(__dirname, "src/lib/prisma/tenant-scope.extension.ts");
  const content = fs.readFileSync(extensionPath, "utf-8");
  const match = content.match(/export const TENANT_MODEL_FIELD_MAP[^{]*\{([^}]+)\}/s);
  if (!match) {
    throw new Error("Could not find TENANT_MODEL_FIELD_MAP in tenant-scope.extension.ts");
  }
  const lines = match[1].split("\n");
  const models = [];
  for (const line of lines) {
    const m = line.match(/^\s*([A-Za-z0-9]+)\s*:/);
    if (m) {
      const modelName = m[1];
      const camel = modelName.charAt(0).toLowerCase() + modelName.slice(1);
      models.push(camel);
    }
  }
  return models.join("|");
}

const tenantModelsPattern = getTenantModelsPattern();

module.exports = [
  {
    ignores: ["dist/**", "node_modules/**"],
  },
  {
    files: ["src/**/*.ts", "src/**/*.tsx"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": ts,
    },
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "MemberExpression[property.name='$queryRawUnsafe']",
          message: "Do not use $queryRawUnsafe. Use $queryRaw with Tagged Template Literals instead for SQL injection prevention.",
        },
        {
          selector: "MemberExpression[property.name='$executeRawUnsafe']",
          message: "Do not use $executeRawUnsafe. Use $executeRaw with Tagged Template Literals instead for SQL injection prevention.",
        },
        {
          selector: "Identifier[name='executeRawQuery']",
          message: "Do not use executeRawQuery. It has been deleted due to SQL injection vulnerability.",
        }
      ],
    },
  },
  {
    files: ["src/server/routers/**/*.ts"],
    // Auth and user-management routers operate on User records before/outside org selection. All other routers must use ctx.tenantPrisma.user.
    ignores: [
      "src/server/routers/admin.router.ts",
      "src/server/routers/admin-*.ts",
      "src/server/routers/auth.router.ts",
      "src/server/routers/user.router.ts",
      "src/server/routers/**/*.test.ts",
      "src/server/routers/**/__tests__/**",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "MemberExpression[property.name='$queryRawUnsafe']",
          message: "Do not use $queryRawUnsafe. Use $queryRaw with Tagged Template Literals instead for SQL injection prevention.",
        },
        {
          selector: "MemberExpression[property.name='$executeRawUnsafe']",
          message: "Do not use $executeRawUnsafe. Use $executeRaw with Tagged Template Literals instead for SQL injection prevention.",
        },
        {
          selector: "Identifier[name='executeRawQuery']",
          message: "Do not use executeRawQuery. It has been deleted due to SQL injection vulnerability.",
        },
        {
          selector: `MemberExpression[object.object.name='ctx'][object.property.name='prisma'][property.name=/^(${tenantModelsPattern})$/]`,
          message: "F-03 Tenant Isolation: Do not use ctx.prisma.<tenantModel> in non-admin routers. Use ctx.tenantPrisma instead to prevent cross-tenant data leakage.",
        },
      ],
    },
  },
];
