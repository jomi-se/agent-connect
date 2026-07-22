import eslint from "@eslint/js";
import sonarjs from "eslint-plugin-sonarjs";
import globals from "globals";
import tseslint from "typescript-eslint";

const javascriptFiles = ["**/*.{js,mjs,cjs}"];
const typescriptFiles = ["**/*.{ts,tsx,mts,cts}"];
const productionFiles = [
  "apps/*/src/**/*.{ts,tsx,js,mjs,cjs}",
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
      "**/coverage/**",
      "**/node_modules/**",
      ".agents/**",
      ".claude/**",
      ".codex/**",
      ".gemini/**",
      ".omnigent-spike/**",
      "submission-assets/**",
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
    files: ["scripts/capture-architecture-story.mjs"],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
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
