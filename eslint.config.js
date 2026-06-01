const ts = require("@typescript-eslint/eslint-plugin");
const tsParser = require("@typescript-eslint/parser");

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
];
