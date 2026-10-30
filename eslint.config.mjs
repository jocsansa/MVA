// Lint do projeto (npm run lint). Uma configuração só: o projeto é pequeno, então as regras com
// tipos (promessas esquecidas) rodam junto com as outras sem pesar.
// Regras com violações antigas começam em "warn" com contagem em docs/quality.md; quando a
// contagem zerar, passam para "error". Não use ignores amplos para esconder avisos.
import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

import quality from "./eslint-rules/index.cjs";

export default defineConfig([
  // eslint-rules/ é cópia do toolkit (atualizar copiando de novo, não editar aqui).
  globalIgnores(["node_modules/", "data/", "eslint-rules/", "**/*.d.ts"]),
  js.configs.recommended,
  {
    files: ["**/*.{js,mjs,cjs,ts}"],
    plugins: { quality },
    rules: {
      "no-empty": ["error", { allowEmptyCatch: true }],
      // Orçamento de tamanho do toolkit (350 linhas). Há arquivos antigos acima: fica em warn.
      "quality/max-lines": "warn",
    },
  },
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
    extends: [tseslint.configs.recommended],
    languageOptions: {
      globals: globals.node,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      // Promessa sem await nem catch some com o erro; no servidor isso derruba o processo.
      // test() do node:test devolve promessa, mas o próprio runner a aguarda.
      "@typescript-eslint/no-floating-promises": ["error", {
        allowForKnownSafeCalls: [{ from: "package", name: ["test", "describe", "it"], package: "node:test" }],
      }],
      "@typescript-eslint/no-misused-promises": "error",
    },
  },
  {
    files: ["test/**/*.ts"],
    rules: { "quality/max-lines": ["warn", { includeTests: true }] },
  },
  {
    files: ["scripts/**/*.mjs", "*.mjs"],
    languageOptions: { globals: globals.node },
  },
  {
    // Página: script clássico que usa MixerLib, definido no bloco mixer-lib do index.html.
    files: ["public/app.js"],
    languageOptions: { sourceType: "script", globals: { ...globals.browser, MixerLib: "readonly" } },
  },
  {
    files: ["public/eq-curve.js"],
    languageOptions: { sourceType: "module", globals: globals.browser },
  },
]);
