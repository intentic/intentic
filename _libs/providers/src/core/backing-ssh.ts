import { setTimeout as sleep } from "node:timers/promises";
import type { SshSession } from "./ssh.js";
import { shellQuote } from "@intentic/sandbox-run/quote";

// Shared host-side helpers for the backing providers (postgres/valkey instances + their binding nodes). Each
// backing instance is a single container, deployed as a per-instance compose project so multiple instances
// (and multiple backing kinds) co-exist on one host without colliding. The container is stamped with its
// node id as the intentic.id label, so its binding nodes can find it by id with `docker exec`.

/* A docker-compose-safe project / path fragment derived from a node id (lowercase, non-alnum -> "-").
 *
 * Refuses to return "" instead of letting the caller build a path one level too high. An id of nothing but
 * punctuation — `"---"`, `"__"` — used to slug to the empty string, and every use below is a path or project
 * built by CONCATENATION: stateDir became `/opt/intentic/postgres/` rather than a directory inside it, so the
 * `rm -rf ${dir}` on delete took every postgres instance on the host with it. An id that cannot name one
 * instance must not silently name all of them. */
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
export const stateDir = (kind: string, id: string): string => `/opt/intentic/${kind}/${slug(id)}`;
const projectName = (kind: string, id: string): string => `intentic-${kind}-${slug(id)}`;

// The id of the container stamped intentic.id=<stamp>, or "" when it is not running. Both an instance (its own
// id) and a binding (the instance id it targets) locate the container this way.
export const containerId = async (session: SshSession, stamp: string): Promise<string> => {
    const result = await session.exec(`docker ps -q --filter "label=intentic.id=${stamp}" --format '{{.ID}}'`);
    return result.stdout.trim().split("\n")[0] ?? "";
};

// The create-time image of the stamped container (.Config.Image is the exact repo:tag@sha256 ref written into
// compose.yaml, so a pin bump reads as drift), or "" when it is not running.
export const containerImage = async (session: SshSession, stamp: string): Promise<string> => {
    const id = await containerId(session, stamp);
    if (id === "") {
        return "";
    }
    const result = await session.exec(`docker inspect --format '{{.Config.Image}}' ${id}`);
    return result.stdout.trim();
};

// A create-time label of the stamped container, or "" when the container is not running or the label is
// absent (a pre-hash container). Backs the intentic.hash drift-stamp read.
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

// Rename a single-volume backing instance in place: oldId → newId, preserving its data. The id is baked into
// the compose project name, the host state dir, and (via the project prefix) the Docker named volume, so a
// rename is a migration, not a relabel: stop the old project KEEPING its volume, copy the volume to the new
// project's name (Docker has no volume rename), move the state dir, and let the next reconcile bring the
// instance up under the new id against the migrated data. Idempotent: if the new state dir already exists a
// prior run finished the move. `image` (the instance's own image, already on the host) runs the copy.
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
        // Stop the old project but KEEP its volume (no -v), tolerating an already-stopped stack.
        `docker compose -p ${oldProject} --project-directory ${oldDir} --env-file ${oldDir}/.env -f ${oldDir}/compose.yaml down 2>/dev/null || true`,
        // Migrate the named volume old → new (create + copy + remove), only when the old exists and the new does not.
        `if docker volume inspect ${oldVolume} >/dev/null 2>&1 && ! docker volume inspect ${newVolume} >/dev/null 2>&1; then`,
        `  docker volume create ${newVolume} >/dev/null`,
        `  docker run --rm --entrypoint sh -v ${oldVolume}:/from -v ${newVolume}:/to ${image} -c 'cp -a /from/. /to/'`,
        `  docker volume rm ${oldVolume} >/dev/null`,
        "fi",
        // Move the host-side state dir (compose.yaml + .env/conf) so the next apply finds it under the new id.
        `if [ -d ${oldDir} ] && [ ! -d ${newDir} ]; then mkdir -p "$(dirname ${newDir})" && mv ${oldDir} ${newDir}; fi`,
    ].join("\n");
    const result = await session.exec(script);
    if (result.code !== 0) {
        throw new Error(`failed to restamp ${kind} "${oldId}" → "${newId}": exited ${result.code}: ${result.stderr.trim()}`);
    }
};

// Poll `probe` (a host-side command returning code 0 when ready) until it passes or the deadline elapses.
export const waitReady = async (session: SshSession, kind: string, id: string, probe: string, timeoutMs: number): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const result = await session.exec(probe);
        if (result.code === 0) {
            return;
        }
        if (Date.now() >= deadline) {
            throw new Error(`${kind} "${id}" did not become ready within ${timeoutMs}ms`);
        }
        await sleep(3_000);
    }
};
