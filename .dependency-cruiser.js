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
      name: "packages-do-not-import-sample",
      severity: "error",
      comment: "Production packages must not depend on the standalone sample.",
      from: { path: "^packages/", pathNot: "/(?:test|e2e)/" },
      to: { path: "^examples/" },
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
      to: { path: "^(?:crates/gateway|deploy/gateway|packages/gateway-npm)/" },
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
    includeOnly: ["^(?:examples|packages|deploy/gateway)/"],
    tsConfig: { fileName: "tsconfig.base.json" },
    enhancedResolveOptions: {
      extensions: [".js", ".mjs", ".cjs", ".ts", ".tsx", ".d.ts"],
    },
    reporterOptions: {
      dot: { collapsePattern: "node_modules/[^/]+" },
    },
  },
};
