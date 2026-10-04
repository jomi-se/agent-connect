import eslint from "@eslint/js";
import sonarjs from "eslint-plugin-sonarjs";
import globals from "globals";
import tseslint from "typescript-eslint";

const javascriptFiles = ["**/*.{js,mjs,cjs}"];
const typescriptFiles = ["**/*.{ts,tsx,mts,cts}"];
const productionFiles = [
  "packages/*/src/**/*.{ts,tsx,js,mjs,cjs}",
  "scripts/**/*.{ts,tsx,js,mjs,cjs}",
];

function rulesAsWarnings(rules = {}) {
  return Object.fromEntries(
    Object.entries(rules).map(([name, value]) => {
      const severity = Array.isArray(value) ? value[0] : value;
      const disabled = severity === "off" || severity === 0;
      return [
        name,
        disabled
          ? "off"
          : Array.isArray(value)
            ? ["warn", ...value.slice(1)]
            : "warn",
      ];
    }),
  );
}

const eslintRecommendedWarnings = {
  ...eslint.configs.recommended,
  rules: rulesAsWarnings(eslint.configs.recommended.rules),
};

const typescriptRecommendedWarnings = tseslint.configs.recommended.map(
  (config) => ({
    ...config,
    rules: rulesAsWarnings(config.rules),
  }),
);

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "target/**",
      "**/coverage/**",
      "**/node_modules/**",
      ".agents/**",
      ".agent-connect/**",
      ".claude/**",
      ".codex/**",
      ".gemini/**",
    ],
  },
  {
    files: javascriptFiles,
    extends: [eslintRecommendedWarnings],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: typescriptFiles,
    extends: [eslintRecommendedWarnings, ...typescriptRecommendedWarnings],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    files: productionFiles,
    plugins: { sonarjs },
    rules: {
      complexity: ["warn", 15],
      "max-depth": ["warn", 4],
      "max-lines": [
        "warn",
        { max: 500, skipBlankLines: true, skipComments: true },
      ],
      "max-lines-per-function": [
        "warn",
        { max: 100, skipBlankLines: true, skipComments: true, IIFEs: true },
      ],
      "max-params": ["warn", 5],
      "max-statements": ["warn", 50],
      "sonarjs/cognitive-complexity": ["warn", 20],
    },
  },
);
