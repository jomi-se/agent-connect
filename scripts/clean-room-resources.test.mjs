import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanupSessionResources } from "./clean-room-resources.mjs";
const own = "11111111-1111-1111-1111-111111111111";
const other = "22222222-2222-2222-2222-222222222222";
const model = "acp-clean-model-owned";
const egress = "acp-clean-egress-owned";
const containerId = "a".repeat(64);
const networkId = "b".repeat(64);
const foreignId = "c".repeat(64);
const modelId = "d".repeat(64);
const egressId = "e".repeat(64);
const labels = (id) => ({
  "org.agent-connect.component": "acp-session",
  "org.agent-connect.session": id,
});
function graph({
  foreign = false,
  extraNetwork = false,
  wrongContainer = false,
  wrongNetwork = false,
  inspectFailure = false,
} = {}) {
  const calls = [];
  const containers = new Map([
    [
      `acp-sess-${own}`,
      {
        Id: containerId,
        Name: `/acp-sess-${own}`,
        Config: { Labels: labels(wrongContainer ? other : own) },
      },
    ],
    [
      model,
      {
        Id: modelId,
        Name: `/${model}`,
        NetworkSettings: {
          Networks: {
            [`acp-sess-net-${own}`]: {},
            ...(extraNetwork ? { [`acp-sess-net-${other}`]: {} } : {}),
          },
        },
      },
    ],
  ]);
  const network = {
    Id: networkId,
    Name: `acp-sess-net-${own}`,
    Labels: labels(wrongNetwork ? other : own),
    Containers: {
      [containerId]: { Name: `acp-sess-${own}` },
      [modelId]: { Name: model },
      [egressId]: { Name: egress },
      ...(foreign ? { [foreignId]: { Name: `acp-sess-${other}` } } : {}),
    },
  };
  const docker = async (args) => {
    calls.push(args);
    if (args[0] === "inspect") {
      if (inspectFailure) throw new Error("Docker daemon is unavailable");
      const value = args[2] === "container" ? containers.get(args[3]) : network;
      if (!value) throw new Error(`No such ${args[2]}: ${args[3]}`);
      return JSON.stringify([value]);
    }
    if (args[0] === "rm") {
      assert.equal(
        args[2],
        containerId,
        "Only the verified run-owned immutable ID may be removed",
      );
      containers.delete(`acp-sess-${own}`);
      delete network.Containers[containerId];
    } else if (args[1] === "disconnect") {
      assert.equal(args[3], networkId);
      assert.ok([modelId, egressId].includes(args[4]));
      delete network.Containers[args[4]];
    } else if (args[1] === "rm") {
      assert.equal(args[2], networkId);
      assert.deepEqual(network.Containers, {});
    } else throw new Error("Unexpected fake Docker operation");
    return "";
  };
  return { calls, docker, network };
}
const clean = (fixture, ids = [own]) =>
  cleanupSessionResources({
    sessionIds: ids,
    model,
    egress,
    docker: fixture.docker,
  });
test("cleanup preserves unrelated session-prefix peers and their occupied network", async () => {
  const fixture = graph({ foreign: true });
  await assert.rejects(clean(fixture), AggregateError);
  assert.ok(fixture.network.Containers[foreignId]);
  assert.deepEqual(
    fixture.calls.filter((args) => args[0] === "rm"),
    [["rm", "--force", containerId]],
  );
  assert.ok(
    !fixture.calls.some((args) => args[0] === "network" && args[1] === "rm"),
  );
});
test("cleanup removes only labelled run-owned immutable resources and disconnects its shared peers", async () => {
  const fixture = graph();
  await clean(fixture);
  assert.ok(
    fixture.calls.some((args) => args.join(" ") === `network rm ${networkId}`),
  );
});
test("model attachment alone never grants authority over another session network", async () => {
  const fixture = graph({ extraNetwork: true });
  await assert.rejects(clean(fixture), AggregateError);
  assert.ok(
    !fixture.calls.some((args) => args.includes(`acp-sess-net-${other}`)),
  );
  assert.ok(
    fixture.calls.some((args) => args.join(" ") === `network rm ${networkId}`),
  );
});
for (const option of ["wrongContainer", "wrongNetwork", "inspectFailure"]) {
  test(`cleanup fails closed on ${option}`, async () => {
    const fixture = graph({ [option]: true });
    await assert.rejects(clean(fixture), AggregateError);
    if (option !== "wrongNetwork")
      assert.ok(!fixture.calls.some((args) => args[0] === "rm"));
    assert.ok(
      !fixture.calls.some((args) => args[0] === "network" && args[1] === "rm"),
    );
  });
}
test("invalid private session identifiers cannot become Docker resource names", async () => {
  const fixture = graph();
  await assert.rejects(
    clean(fixture, ["../escape", own + "/bad"]),
    AggregateError,
  );
  assert.deepEqual(fixture.calls, [["inspect", "--type", "container", model]]);
});
test("actual driver cleanup reports preserved peers after attempting other owned cleanup", async () => {
  const source = await readFile(
    new URL("./clean-room.mjs", import.meta.url),
    "utf8",
  );
  const body = source.slice(
    source.indexOf("let cleaning;"),
    source.indexOf("for (const signal"),
  );
  const fixture = graph({ foreign: true });
  const removedImages = [];
  const command = async (binary, args) => {
    assert.equal(binary, "docker");
    if (args.join(" ") === "rm -f driver") return "";
    return fixture.docker(args);
  };
  const cleanup = new Function(
    "command",
    "readFile",
    "readdir",
    "join",
    "run",
    "suffix",
    "name",
    "children",
    "image",
    "boxImage",
    "removeTestImages",
    "cleanupSessionResources",
    body + "\nreturn cleanup;",
  )(
    command,
    async () => "{}",
    async () => [own],
    join,
    "/fixture",
    "owned",
    "driver",
    new Set(),
    "test-image",
    undefined,
    async (name) => removedImages.push(name),
    cleanupSessionResources,
  );
  await assert.rejects(cleanup(), AggregateError);
  assert.deepEqual(removedImages, ["test-image"]);
  assert.ok(fixture.network.Containers[foreignId]);
});
