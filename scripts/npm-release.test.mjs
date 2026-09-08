import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  publishPreparedPackages,
  registryVersionState,
} from "./publish-npm-release.mjs";

const sdk = {
  name: "@open-agent-connect/web",
  version: "0.0.4",
  filename: "open-agent-connect-web-0.0.4.tgz",
  sha256: "sdk-digest",
};
const plugin = {
  name: "@open-agent-connect/openclaw-plugin",
  version: "0.0.1",
  filename: "open-agent-connect-openclaw-plugin-0.0.1.tgz",
  sha256: "plugin-digest",
};

test("registry lookup recognizes an exact published version", () => {
  assert.equal(
    registryVersionState(sdk, () => ({
      status: 0,
      stdout: '"0.0.4"\n',
      stderr: "",
    })),
    "published",
  );
});

test("registry lookup recognizes only a real npm 404 as unpublished", () => {
  assert.equal(
    registryVersionState(plugin, () => ({
      status: 1,
      stdout: "",
      stderr: "npm error code E404\nnpm error 404 Not Found",
    })),
    "unpublished",
  );
  assert.throws(
    () =>
      registryVersionState(plugin, () => ({
        status: 1,
        stdout: "",
        stderr: "npm error code EAI_AGAIN registry unavailable",
      })),
    /Registry lookup failed/,
  );
});

test("partial rerun skips the published package and publishes the other tarball", () => {
  const calls = [];
  const messages = [];
  const outcomes = publishPreparedPackages(
    [sdk, plugin],
    (args) => {
      calls.push(args);
      if (args[0] === "view" && args[1] === `${sdk.name}@${sdk.version}`) {
        return { status: 0, stdout: '"0.0.4"', stderr: "" };
      }
      if (args[0] === "view") {
        return { status: 1, stdout: "", stderr: "npm error code E404" };
      }
      return { status: 0, stdout: "+ published", stderr: "" };
    },
    (message) => messages.push(message),
  );

  assert.deepEqual(
    outcomes.map(({ name, outcome }) => ({ name, outcome })),
    [
      { name: sdk.name, outcome: "skipped" },
      { name: plugin.name, outcome: "published" },
    ],
  );
  assert.equal(calls.filter(([command]) => command === "publish").length, 1);
  assert.match(
    calls.at(-1)[1],
    /open-agent-connect-openclaw-plugin-0\.0\.1\.tgz$/,
  );
  assert.match(messages.join("\n"), /SKIP.*PUBLISHED/s);
});

test("only a successful main push can enter the publication job", () => {
  const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
  assert.match(workflow, /publish:\n[\s\S]*needs: checks/);
  assert.match(
    workflow,
    /github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/,
  );
  assert.doesNotMatch(workflow, /publish:[\s\S]*workflow_dispatch ==/);
});
