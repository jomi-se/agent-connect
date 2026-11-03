import { execFileSync } from "node:child_process";

// The container engine the test harness drives, chosen like the gateway's:
// AGENT_CONNECT_CONTAINER_ENGINE (docker or podman), else docker.
const requested = process.env.AGENT_CONNECT_CONTAINER_ENGINE;
if (requested !== undefined && !["docker", "podman"].includes(requested))
  throw new Error(
    `AGENT_CONNECT_CONTAINER_ENGINE must be docker or podman, not ${requested}`,
  );
export const engine = requested ?? "docker";
// An explicit choice must answer, or a run would half-run on the other engine.
if (requested !== undefined)
  execFileSync(engine, ["info"], { stdio: "ignore", timeout: 30_000 });

export const architectureFormat =
  engine === "podman" ? "{{.Host.Arch}}" : "{{.Architecture}}";

// A fixture container that writes into a bind-mounted test directory as the
// invoking user: rootless Podman needs keep-id for the ids to line up.
export const ownerIdentity = (uid) =>
  engine === "podman" ? ["--userns=keep-id", "--user", uid] : ["--user", uid];

// Podman names local builds localhost/<name>; compare names without it.
export const localName = (image) => image.replace(/^localhost\//, "");

// Podman rejects tmpfs uid=/gid= and chowns to the container user with U.
export const tmpfsOwner = (uid, gid) =>
  engine === "podman" ? "U" : `uid=${uid},gid=${gid}`;

// What a child with an isolated HOME needs to reach the same engine. Docker
// talks to a socket; rootless Podman keeps its image store and runtime state
// under the user's XDG data and runtime directories, which an isolated HOME
// would replace. Its configuration stays isolated: the defaults suffice. The
// engine is always named: left to choose, the gateway prefers a rootless one,
// which need not be the one this harness drives.
export function engineEnv(env = process.env) {
  const kept = { AGENT_CONNECT_CONTAINER_ENGINE: engine };
  if (engine === "docker") {
    for (const name of ["DOCKER_HOST", "DOCKER_CONTEXT"])
      if (env[name]) kept[name] = env[name];
    return kept;
  }
  kept.XDG_DATA_HOME = env.XDG_DATA_HOME ?? `${env.HOME}/.local/share`;
  if (env.XDG_RUNTIME_DIR) kept.XDG_RUNTIME_DIR = env.XDG_RUNTIME_DIR;
  return kept;
}
