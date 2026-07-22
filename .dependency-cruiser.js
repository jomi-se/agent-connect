/** @type {import("dependency-cruiser").IConfiguration} */
export default {
  forbidden: [
    {
      name: "no-circular-dependencies",
      severity: "warn",
      comment: "Cycles make module ownership and safe refactoring harder.",
      from: {},
      to: { circular: true },
    },
    {
      name: "no-unresolved-imports",
      severity: "error",
      comment: "Every statically imported module must resolve.",
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: "packages-do-not-import-apps",
      severity: "error",
      comment: "Reusable packages must not depend on deployable demo apps.",
      from: { path: "^packages/" },
      to: { path: "^apps/" },
    },
    {
      name: "browser-nonce-does-not-import-other-apps",
      severity: "error",
      comment: "Applications may consume packages, but not another app.",
      from: { path: "^apps/browser-nonce/" },
      to: { path: "^apps/(?!browser-nonce/)" },
    },
    {
      name: "firebase-canvas-does-not-import-other-apps",
      severity: "error",
      comment: "Applications may consume packages, but not another app.",
      from: { path: "^apps/firebase-canvas/" },
      to: { path: "^apps/(?!firebase-canvas/)" },
    },
    {
      name: "production-does-not-import-tests",
      severity: "error",
      comment: "Production source must not depend on test or end-to-end code.",
      from: { path: "/src/" },
      to: { path: "/(?:test|e2e)/" },
    },
    {
      name: "web-sdk-does-not-import-gateway",
      severity: "error",
      comment:
        "The application-facing SDK must remain independent of the gateway implementation.",
      from: { path: "^packages/web-sdk/" },
      to: { path: "^packages/gateway/" },
    },
    {
      name: "web-sdk-does-not-import-node-builtins",
      severity: "error",
      comment:
        "The browser SDK must remain usable without Node.js runtime APIs.",
      from: { path: "^packages/web-sdk/" },
      to: { dependencyTypes: ["core"] },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "(^|/)(?:dist|coverage|node_modules)/" },
    includeOnly: ["^(?:apps|packages)/"],
    tsConfig: { fileName: "tsconfig.base.json" },
    enhancedResolveOptions: {
      extensions: [".js", ".mjs", ".cjs", ".ts", ".tsx", ".d.ts"],
    },
    reporterOptions: {
      dot: { collapsePattern: "node_modules/[^/]+" },
    },
  },
};
