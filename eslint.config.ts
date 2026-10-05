import js from "@eslint/js";
import type { Linter } from "eslint";
import { defineConfig, globalIgnores } from "eslint/config";
import importX from "eslint-plugin-import-x";
import simpleImportSort from "eslint-plugin-simple-import-sort";
import unicorn from "eslint-plugin-unicorn";
import unusedImports from "eslint-plugin-unused-imports";
import tseslint from "typescript-eslint";

/** Size budgets. */
const BUDGET = { fileLines: 250, functionLines: 40 } as const;

const eslintConfig: Linter.Config[] = defineConfig(
  globalIgnores(["node_modules/**", "coverage/**"]),
  { linterOptions: { reportUnusedDisableDirectives: "error" } },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  unicorn.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: [] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "import-x": importX,
      "simple-import-sort": simpleImportSort,
      "unused-imports": unusedImports,
    },
    rules: {
      "simple-import-sort/imports": "error",
      "simple-import-sort/exports": "error",
      "import-x/no-duplicates": "error",
      "import-x/no-cycle": "error",
      "import-x/no-self-import": "error",
      "import-x/first": "error",
      "import-x/newline-after-import": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/consistent-type-exports": "error",
      "@typescript-eslint/no-import-type-side-effects": "error",
      "@typescript-eslint/no-unused-vars": "off",
      "unused-imports/no-unused-imports": "error",
      "unused-imports/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/prefer-readonly": "error",
      eqeqeq: "error",
      "no-console": "error",
      "no-nested-ternary": "error",
      "prefer-template": "error",
      "object-shorthand": "error",
      "max-lines": [
        "error",
        { max: BUDGET.fileLines, skipBlankLines: true, skipComments: true },
      ],
      "max-lines-per-function": [
        "error",
        { max: BUDGET.functionLines, skipBlankLines: true, skipComments: true },
      ],
      "unicorn/filename-case": ["error", { case: "kebabCase" }],
      "unicorn/no-null": "off",
      // Stylistic rewrites of code that Codex already reviewed round by round.
      "unicorn/prefer-ternary": "off",
      "unicorn/prefer-combined-guards": "off",
      "unicorn/prefer-default-parameters": "off",
      // Both conflict with JSDoc's own `*`-prefixed block style, which Prettier keeps.
      "unicorn/no-asterisk-prefix-in-documentation-comments": "off",
      "unicorn/single-line-block-comment-style": "off",
    },
  },
  {
    files: ["test/**/*.ts"],
    rules: {
      "max-lines": "off",
      "max-lines-per-function": "off",
    },
  },
  {
    // ponytail: проверенный раундами Codex код, делить только при правке
    files: ["src/watchdog.ts"],
    rules: {
      "max-lines": "off",
      "max-lines-per-function": "off",
      // the output filter strips control characters on purpose
      "no-control-regex": "off",
    },
  },
  {
    // ponytail: проверенный раундами Codex код, делить только при правке
    files: ["src/hooks/wrap-runner-command.ts"],
    rules: { "max-lines-per-function": "off" },
  },
);

export default eslintConfig;
