import { answered, type FleetSys } from "../sys.js";

/* HOW MUCH MEMORY THE INTENTIC SANDBOXES ON THIS ENGINE USE: the containers labelled as a sandbox or a sandbox runner,
   as `docker stats` reads them once. Egress helpers and the other labelled containers are small and come and go with
   their sandbox, so they are left out. Docker missing or failing throws, and the round keeps what it held. */

const KINDS = new Set(["sandbox", "runner"]);
const DOCKER_MS = 30_000;

// What `docker stats` prints per unit: binary for MemUsage, decimal where a daemon prints it that way.
const UNIT_BYTES = new Map([
    ["B", 1],
    ["KiB", 1024],
    ["MiB", 1024 ** 2],
    ["GiB", 1024 ** 3],
    ["TiB", 1024 ** 4],
    ["kB", 1000],
    ["KB", 1000],
    ["MB", 1000 ** 2],
    ["GB", 1000 ** 3],
    ["TB", 1000 ** 4],
]);

// "1.25GiB" → bytes, or undefined for what is not a size ("--" for a container that just stopped).
export const sizeBytes = (text: string): number | undefined => {
    const match = /^([\d.]+)\s*([A-Za-z]+)$/u.exec(text.trim());
    const unit = match?.[2] === undefined ? undefined : UNIT_BYTES.get(match[2]);
    const value = Number(match?.[1]);
    return unit === undefined || !Number.isFinite(value) ? undefined : Math.round(value * unit);
};

// `docker ps` lines of "<id> <kind>" → the ids of sandboxes and runners.
export const sandboxIds = (listing: string): string[] =>
    listing
        .split(/\r?\n/u)
        .map((line) => line.trim().split(/\s+/u))
        .filter(([id, kind]) => id !== undefined && id !== "" && kind !== undefined && KINDS.has(kind))
        .map(([id]) => id ?? "");

// `docker stats` lines of "<id> <used> / <limit>" → the used bytes together.
export const usedBytes = (stats: string): number =>
    stats
        .split(/\r?\n/u)
        .map((line) => /^\S+\s+(.+?)\s*\/.*$/u.exec(line.trim())?.[1])
        .map((used) => (used === undefined ? 0 : (sizeBytes(used) ?? 0)))
        .reduce((sum, bytes) => sum + bytes, 0);

export const measureSandboxBytes = async (sys: FleetSys): Promise<number> => {
    const listed = await sys.run("docker", ["ps", "--filter", "label=dev.intentic.kind", "--format", '{{.ID}} {{.Label "dev.intentic.kind"}}'], { timeoutMs: DOCKER_MS });
    const ids = sandboxIds(answered("docker ps", listed));
    if (ids.length === 0) {
        return 0;
    }
    const stats = await sys.run("docker", ["stats", "--no-stream", "--format", "{{.ID}} {{.MemUsage}}", ...ids], { timeoutMs: DOCKER_MS });
    return usedBytes(answered("docker stats", stats));
};
