import { HOST_STATE_ROOT } from "@intentic/constants";
import { pollUntil } from "@intentic/base/async";
import type { SshSession } from "./ssh.js";
import { shellQuote } from "@intentic/sandbox-run/quote";

// Shared host-side helpers for the backing providers. Each instance is a single container in its own per-instance
// compose project, stamped with its node id so binding nodes can find it with `docker exec`.

// A docker-compose-safe project/path fragment derived from a node id; refuses to return "" instead of silently
// naming every instance on the host at once.
const slug = (id: string): string => {
    const slugged = id
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    if (slugged === "") {
        throw new Error(`cannot derive a host directory from node id "${id}": it has no letters or digits`);
    }
    return slugged;
};

// The per-instance host directory holding its compose.yaml + .env, and the compose project name.
export const stateDir = (kind: string, id: string): string => `${HOST_STATE_ROOT}/${kind}/${slug(id)}`;
const projectName = (kind: string, id: string): string => `intentic-${kind}-${slug(id)}`;

// The compose `labels:` line that makes a container findable: by owning node (intentic.id), by kind
// (intentic.type), by inputs hash (intentic.hash), and by protection (intentic.protect, omitted rather than
// written false).
export const stampLabels = (kind: string, id: string, hash: string, protect = false): string =>
    `    labels: [ "intentic.id=${id}", "intentic.type=${kind}", "intentic.hash=${hash}"${protect ? ', "intentic.protect=true"' : ""} ]`;

// A readiness probe that runs inside the stamped container: resolve it by stamp, then exec. Exits non-zero (the
// "not ready" callers want) when the container is not running.
export const execProbe = (id: string, command: string): string =>
    `cid=$(docker ps -q --filter "label=intentic.id=${id}"); [ -n "$cid" ] && docker exec "$cid" ${command}`;

// The id of the container stamped intentic.id=<stamp>, or "" when it is not running.
export const containerId = async (session: SshSession, stamp: string): Promise<string> => {
    const result = await session.exec(`docker ps -q --filter "label=intentic.id=${stamp}" --format '{{.ID}}'`);
    return result.stdout.trim().split("\n")[0] ?? "";
};

// The create-time image of the stamped container (the exact repo:tag@sha256 ref, so a pin bump reads as drift),
// or "" when it is not running.
export const containerImage = async (session: SshSession, stamp: string): Promise<string> => {
    const id = await containerId(session, stamp);
    if (id === "") {
        return "";
    }
    const result = await session.exec(`docker inspect --format '{{.Config.Image}}' ${id}`);
    return result.stdout.trim();
};

// A create-time label of the stamped container, or "" when not running or the label is absent (a pre-hash
// container). Backs the intentic.hash drift-stamp read.
export const containerLabel = async (session: SshSession, stamp: string, key: string): Promise<string> => {
    const id = await containerId(session, stamp);
    if (id === "") {
        return "";
    }
    const result = await session.exec(`docker inspect --format ${shellQuote(`{{index .Config.Labels "${key}"}}`)} ${id}`);
    return result.stdout.trim();
};

// `docker compose up -d` for a single-instance project, throwing with stderr on failure.
export const composeUp = async (session: SshSession, kind: string, id: string): Promise<void> => {
    const dir = stateDir(kind, id);
    const up = await session.exec(
        `docker compose -p ${projectName(kind, id)} --project-directory ${dir} --env-file ${dir}/.env -f ${dir}/compose.yaml up -d`,
    );
    if (up.code !== 0) {
        throw new Error(`failed to bring up ${kind} "${id}": exited ${up.code}: ${up.stderr.trim()}`);
    }
};

// `docker compose down -v` + remove the host-side dir; tolerant of an already-gone stack.
export const composeDown = async (session: SshSession, kind: string, id: string): Promise<void> => {
    const dir = stateDir(kind, id);
    await session.exec(
        `docker compose -p ${projectName(kind, id)} --project-directory ${dir} --env-file ${dir}/.env -f ${dir}/compose.yaml down -v 2>/dev/null || true`,
    );
    await session.exec(`rm -rf ${dir}`);
};

// Rename a single-volume backing instance in place: the id is baked into the compose project name, the state dir,
// and the named volume, so a rename is a migration, not a relabel. Idempotent via the new state dir's presence.
export const restampBacking = async (session: SshSession, kind: string, oldId: string, newId: string, image: string): Promise<void> => {
    const oldDir = stateDir(kind, oldId);
    const newDir = stateDir(kind, newId);
    const oldProject = projectName(kind, oldId);
    const newProject = projectName(kind, newId);
    const oldVolume = `${oldProject}_data`;
    const newVolume = `${newProject}_data`;
    const script = [
        "set -e",
        // Idempotent: the move already completed if the new state dir is in place.
        `if [ -d ${newDir} ]; then exit 0; fi`,
        // Stop the old project but keep its volume (no -v), tolerating an already-stopped stack.
        `docker compose -p ${oldProject} --project-directory ${oldDir} --env-file ${oldDir}/.env -f ${oldDir}/compose.yaml down 2>/dev/null || true`,
        // Migrate the named volume old -> new (create + copy + remove), only when the old exists and the new does not.
        `if docker volume inspect ${oldVolume} >/dev/null 2>&1 && ! docker volume inspect ${newVolume} >/dev/null 2>&1; then`,
        `  docker volume create ${newVolume} >/dev/null`,
        `  docker run --rm --entrypoint sh -v ${oldVolume}:/from -v ${newVolume}:/to ${image} -c 'cp -a /from/. /to/'`,
        `  docker volume rm ${oldVolume} >/dev/null`,
        "fi",
        // Move the host-side state dir so the next apply finds it under the new id.
        `if [ -d ${oldDir} ] && [ ! -d ${newDir} ]; then mkdir -p "$(dirname ${newDir})" && mv ${oldDir} ${newDir}; fi`,
    ].join("\n");
    const result = await session.exec(script);
    if (result.code !== 0) {
        throw new Error(`failed to restamp ${kind} "${oldId}" → "${newId}": exited ${result.code}: ${result.stderr.trim()}`);
    }
};

// Poll `probe` (a host-side command returning code 0 when ready) until it passes or the deadline elapses.
export const waitReady = async (session: SshSession, kind: string, id: string, probe: string, timeoutMs: number): Promise<void> => {
    const ready = await pollUntil(async () => (await session.exec(probe)).code === 0, { timeoutMs, intervalMs: 3_000 });
    if (!ready) {
        throw new Error(`${kind} "${id}" did not become ready within ${timeoutMs}ms`);
    }
};
