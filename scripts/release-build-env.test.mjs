import assert from "node:assert/strict";
import { test } from "node:test";
import { encodedReleaseRustflags } from "./release-build-env.mjs";
const paths = { CARGO_HOME: "/example/cargo", RUSTUP_HOME: "/example/rustup" };
test("release flags preserve compiler options and remap repository and dependency locations", () => {
  assert.deepEqual(
    encodedReleaseRustflags(
      { ...paths, RUSTFLAGS: "-C opt-level=2" },
      "/example/repository with spaces",
    ).split("\x1f"),
    [
      "-C",
      "opt-level=2",
      "--remap-path-prefix=/example/repository with spaces=/agent-connect",
      "--remap-path-prefix=/example/cargo=/cargo",
      "--remap-path-prefix=/example/rustup=/rustup",
    ],
  );
});
test("encoded flags take precedence over plain flags, including an explicitly empty value", () => {
  assert.equal(
    encodedReleaseRustflags(
      {
        ...paths,
        CARGO_ENCODED_RUSTFLAGS: "-C\x1flink-arg=path with spaces",
        RUSTFLAGS: "ignored",
      },
      "/example/repository",
    ).split("\x1f")[1],
    "link-arg=path with spaces",
  );
  assert.ok(
    !encodedReleaseRustflags(
      { ...paths, CARGO_ENCODED_RUSTFLAGS: "", RUSTFLAGS: "ignored" },
      "/example/repository",
    ).includes("ignored"),
  );
});
