import assert from "node:assert/strict";

export function requireBoxImage(image = process.env.ACP_BOX_IMAGE) {
  if (!image?.trim())
    throw new Error(
      "ACP_BOX_IMAGE is required; run npm run verify to build this checkout's test box",
    );
  return image;
}

export function testBoxImage(version, runId) {
  const image = `agent-connect-box-test:${version}-${runId}`;
  assertTestImage(image);
  return image;
}

function assertTestImage(image) {
  assert.match(
    image,
    /^agent-connect-(?:box|clean-room)-test:[a-z0-9][a-z0-9._-]{0,110}$/,
    "Test images must use an isolated test namespace",
  );
}

// Remove tags, not IDs: identical builds may share an ID with an owner's image.
// Discover tags even when setup/build failed before returning an image ID.
export async function removeTestImages(base, docker) {
  assertTestImage(base);
  const output = await docker([
    "image",
    "ls",
    "--filter",
    `reference=${base}*`,
    "--format",
    "{{.Repository}}:{{.Tag}}",
  ]);
  const failures = [];
  for (const image of new Set(output.trim().split(/\s+/))) {
    const layer = image.slice(base.length + 1);
    if (
      image !== base &&
      !(image.startsWith(`${base}-`) && /^[a-f0-9]{16}$/.test(layer))
    )
      continue;
    try {
      await docker(["image", "rm", image]);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length)
    throw new AggregateError(failures, "Test image cleanup failed");
}
