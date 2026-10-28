import assert from "node:assert/strict";

const sessionId =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const dockerId = /^[0-9a-f]{64}$/;
const component = "org.agent-connect.component";
const session = "org.agent-connect.session";

// Session ownership comes from this run's private state, never a shared prefix
// or attachment to the model's networks. Docker IDs prevent name replacement.
export async function cleanupSessionResources({
  sessionIds,
  model,
  egress,
  docker,
}) {
  const failures = [];
  const ownedIds = new Set(sessionIds.filter((id) => sessionId.test(id)));
  async function inspect(kind, name) {
    try {
      const records = JSON.parse(
        await docker(["inspect", "--type", kind, name]),
      );
      assert.equal(records.length, 1, "Expected one Docker resource");
      return records[0];
    } catch (error) {
      if (
        /No such (?:object|container|network):|network .* not found/.test(
          error.message,
        )
      )
        return null;
      throw error;
    }
  }
  function owned(kind, resource, id) {
    const expected = `${kind === "container" ? "acp-sess-" : "acp-sess-net-"}${id}`;
    const labels =
      kind === "container" ? resource.Config?.Labels : resource.Labels;
    assert.equal(
      resource.Name,
      kind === "container" ? `/${expected}` : expected,
      "Session resource name changed",
    );
    assert.equal(
      labels?.[component],
      "acp-session",
      "Refusing an unowned session resource",
    );
    assert.equal(labels?.[session], id, "Session resource ownership changed");
    assert.match(resource.Id, dockerId, "Expected immutable Docker ID");
    return resource.Id;
  }
  async function attempt(task) {
    try {
      await task();
    } catch (error) {
      failures.push(error);
    }
  }
  for (const id of ownedIds) {
    await attempt(async () => {
      const container = await inspect("container", `acp-sess-${id}`);
      if (container)
        await docker(["rm", "--force", owned("container", container, id)]);
    });
  }
  // Unexpected attachments are evidence of an ownership ambiguity, not a
  // source of new deletion authority. Still attempt every known owned network.
  await attempt(async () => {
    const info = await inspect("container", model);
    for (const name of Object.keys(info?.NetworkSettings?.Networks ?? {})) {
      if (
        name.startsWith("acp-sess-net-") &&
        !ownedIds.has(name.slice("acp-sess-net-".length))
      )
        failures.push(
          new Error(
            `Preserved session network absent from this run's private state: ${name}`,
          ),
        );
    }
  });
  for (const id of ownedIds) {
    await attempt(async () => {
      const network = await inspect("network", `acp-sess-net-${id}`);
      if (!network) return;
      const immutable = owned("network", network, id);
      let blocked = false;
      for (const [peerId, peer] of Object.entries(network.Containers ?? {})) {
        if (peer.Name === model || peer.Name === egress) {
          assert.match(peerId, dockerId, "Expected immutable attached peer ID");
          await docker(["network", "disconnect", "--force", immutable, peerId]);
        } else {
          blocked = true;
        }
      }
      if (blocked)
        throw new Error(
          `Preserved owned network with an unrelated or unremoved peer: ${network.Name}`,
        );
      await docker(["network", "rm", immutable]);
    });
  }
  if (failures.length)
    throw new AggregateError(
      failures,
      "Clean-room session cleanup preserved resources that could not be safely removed",
    );
}
