// Gateway package publication only; callers enforce release approval and checksums.
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const numeric = "(?:0|[1-9]\\d*)";
const prerelease = "(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)";
const versionPattern = new RegExp(
  `^${numeric}\\.${numeric}\\.${numeric}(?:-${prerelease}(?:\\.${prerelease})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
);

export async function publishPackage(
  { name, version, path, dryRun = false, cwd, env = process.env },
  {
    run = spawnSync,
    log = console.log,
    sleep = delay,
    now = () => performance.now(),
    // npm now answers a publish with "being processed, may take a few
    // minutes": 0.0.5's first package was still a 404 after 30 seconds.
    confirmationMs = 900000,
    lookupMs = 10000,
    pollMs = 10000,
    publishMs = 120000,
  } = {},
) {
  const spec = `${name}@${version}`;
  const options = { cwd, env, encoding: "utf8", killSignal: "SIGKILL" };
  function view(subject, field, timeout) {
    const result = run(
      "npm",
      [
        "view",
        subject,
        field,
        "--json",
        "--prefer-online",
        "--fetch-retries=0",
      ],
      {
        ...options,
        stdio: ["ignore", "pipe", "pipe"],
        timeout,
        maxBuffer: 1024 * 1024,
      },
    );
    if (result.error || result.signal || !Number.isInteger(result.status))
      throw new Error(`Registry lookup for ${spec} did not complete`);
    let value;
    try {
      value = JSON.parse(result.stdout);
    } catch {
      throw new Error(`Registry lookup for ${spec} returned invalid JSON`);
    }
    return { status: result.status, value };
  }

  // npm's E404 can also mean no permission. A successful package-version
  // listing, rather than human error text, is required before publishing.
  // A wholly new/hidden package needs operator investigation and bootstrap.
  const listed = view(name, "versions", lookupMs);
  if (listed.status !== 0)
    throw new Error(
      `Cannot establish published versions for ${name}; publication was not attempted. Check registry access. A wholly new package requires a separately reviewed bootstrap.`,
    );
  const versions =
    typeof listed.value === "string" ? [listed.value] : listed.value;
  if (
    !Array.isArray(versions) ||
    !versions.every(
      (item) => typeof item === "string" && versionPattern.test(item),
    )
  )
    throw new Error(
      `Registry lookup for ${name} returned an invalid version list; publication was not attempted`,
    );
  if (versions.includes(version)) {
    log(`${spec} is already published (confirmed in registry)`);
    return;
  }

  log(`${dryRun ? "Dry-run publishing" : "Publishing"} ${spec}`);
  try {
    const result = run(
      "npm",
      [
        "publish",
        path,
        "--access",
        "public",
        "--tag",
        "latest",
        "--ignore-scripts",
        "--fetch-retries=0",
        ...(dryRun ? ["--dry-run"] : ["--provenance"]),
      ],
      {
        ...options,
        stdio: ["ignore", "inherit", "inherit"],
        timeout: publishMs,
      },
    );
    if (result.error || result.signal || result.status !== 0)
      throw new Error("npm did not report successful completion");
  } catch (cause) {
    throw new Error(
      dryRun
        ? `npm publish --dry-run failed for ${spec}; no publication was requested`
        : `Publication outcome for ${spec} is uncertain; publication was not retried. Inspect this exact version in the registry before another release attempt.`,
      { cause },
    );
  }
  if (dryRun) {
    log(`${spec} publish dry-run completed; no publication was requested`);
    return;
  }

  log(`npm reported success for ${spec}; confirming registry visibility`);
  const deadline = now() + confirmationMs;
  try {
    while (now() < deadline) {
      const confirmed = view(
        spec,
        "version",
        Math.max(1, Math.floor(Math.min(lookupMs, deadline - now()))),
      );
      if (confirmed.status === 0) {
        if (confirmed.value !== version)
          throw new Error(
            `Registry returned an unexpected version for ${spec}`,
          );
        log(`${spec} is live in the registry`);
        return;
      }
      // Only the read is retried. A 404 here is unconfirmed visibility, never
      // permission to upload again, including when the registry hides access.
      if (confirmed.value?.error?.code !== "E404")
        throw new Error(`Registry confirmation lookup failed for ${spec}`);
      const remaining = deadline - now();
      if (remaining > 0) await sleep(Math.min(pollMs, remaining));
    }
    throw new Error(`Registry visibility deadline expired for ${spec}`);
  } catch (cause) {
    throw new Error(
      `npm reported publish success for ${spec}, but registry visibility is unconfirmed. Publication was not retried; inspect this exact version before another release attempt.`,
      { cause },
    );
  }
}
