import { errorMessage } from "@intentic/base/errors";
import { parseJsonWith } from "@intentic/base/json";
import type { StackHealth, StackImageDigests } from "@intentic/sandbox-contract/schemas/device-stacks";
import { z } from "zod";
import { type ContainerRow, CONTAINERS_FORMAT, type Docker, healthOf, parseContainers, PROJECT_LABEL, READ_TIMEOUT_MS } from "./stacks.js";

/* HOW A MANAGED DEPLOY KNOWS IT CAME UP, AND WHAT IT RAN (2026-11-25). After `up`, the machine watches the project's
   containers and the stack's own URLs until all of them say so, and then reads which image each service runs, pinned
   by digest, so the daemon can record it and a rollback can run exactly those images again (`pins`). */

// The first seconds are not trusted: `up` returns while an old container may still be answering on the port.
export const HEALTH_SETTLE_MS = 5_000;
export const HEALTH_POLL_MS = 3_000;
// One URL's answer, fetched from the machine: a stack that does not answer in this long is not ready yet.
const PROBE_TIMEOUT_MS = 5_000;

// What a health wait reaches besides docker: the URLs, and the clock it waits on.
export interface HealthSeams {
    // Nothing when the URL answered 2xx, else what it did instead.
    readonly probe: (url: string, timeoutMs: number) => Promise<string | undefined>;
    readonly sleep: (ms: number) => Promise<void>;
    readonly now: () => number;
}

export const machineProbe = async (url: string, timeoutMs: number): Promise<string | undefined> => {
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
        await response.body?.cancel();
        return response.ok ? undefined : `${url} answered ${response.status}`;
    } catch (error) {
        return `${url} did not answer (${errorMessage(error)})`;
    }
};

// Every container compose made for the project, `run`'s one-off ones (a hook's migration) left out.
export const projectContainersArgs = (name: string): string[] => [
    "ps",
    "-a",
    "--filter",
    `label=${PROJECT_LABEL}=${name}`,
    "--filter",
    "label=com.docker.compose.oneoff=False",
    "--format",
    CONTAINERS_FORMAT,
];

// Why one container is not ready, or nothing when it is: running and, when it declares a healthcheck, healthy. One that
// exited 0 is a one-shot service that finished (a migration other services wait on), and counts as done.
export const notReadyBecause = (row: ContainerRow): string | undefined => {
    const who = row.service === "" ? row.container : row.service;
    const state = row.state.toLowerCase();
    if (state === "running") {
        const health = healthOf(row.status);
        return health === "starting" ? `${who} is still starting (its healthcheck has not passed yet)` : health === "unhealthy" ? `${who} is unhealthy` : undefined;
    }
    if (state === "exited" && row.status.startsWith('Exited (0)')) {
        return undefined;
    }
    return `${who} is ${state === "" ? "in no known state" : state}${row.status === "" ? "" : ` (${row.status})`}`;
};

// Everything that is not ready right now: containers first, then URLs. Docker failing to answer is one more reason to
// wait, not the end of the wait.
const notReady = async (name: string, urls: readonly string[], docker: Docker, seams: HealthSeams, remainingMs: number): Promise<string[]> => {
    const [listed, answers] = await Promise.all([
        docker(projectContainersArgs(name), { timeoutMs: Math.max(Math.min(READ_TIMEOUT_MS, remainingMs), 1_000) }),
        Promise.all(urls.map(async (url) => await seams.probe(url, PROBE_TIMEOUT_MS))),
    ]);
    const rows = listed.status === 0 ? parseContainers(listed.stdout) : undefined;
    const containers =
        rows === undefined
            ? [`docker ps did not answer (exit ${listed.status ?? "none"})`]
            : rows.length === 0
              ? ["no container of the stack exists"]
              : rows.flatMap((row) => notReadyBecause(row) ?? []);
    return [...containers, ...answers.flatMap((answer) => answer ?? [])];
};

// Waits until the stack is up as `health` describes, within its timeout and the deploy's own `deadline`, and answers
// how long that took in seconds; or fails saying what was still not ready when time ran out.
export const waitHealthy = async (name: string, health: StackHealth, docker: Docker, seams: HealthSeams, deadline: number): Promise<number> => {
    const started = seams.now();
    const until = Math.min(started + health.timeoutSeconds * 1000, deadline);
    await seams.sleep(Math.max(Math.min(HEALTH_SETTLE_MS, until - seams.now()), 0));
    for (;;) {
        // in order: each look is taken after the wait before it
        const waiting = await notReady(name, health.http, docker, seams, until - seams.now());
        if (waiting.length === 0) {
            return Math.round((seams.now() - started) / 100) / 10;
        }
        if (seams.now() >= until) {
            throw new Error(`"${name}" did not come up healthy within ${Math.round((until - started) / 1000)} s: ${waiting.join("; ")}.`);
        }
        // the last look is taken at the timeout itself
        await seams.sleep(Math.min(HEALTH_POLL_MS, until - seams.now()));
    }
};

// ---- which image each service runs -------------------------------------------------------------------------------

const InspectedSchema = z.object({ service: z.string().catch(""), ref: z.string().catch(""), image: z.string() });
const ImageSchema = z.object({ id: z.string(), repoDigests: z.array(z.string()).nullable().catch(null) });

export const CONTAINER_IMAGE_FORMAT = '{"service":{{json (index .Config.Labels "com.docker.compose.service")}},"ref":{{json .Config.Image}},"image":{{json .Image}}}';
export const IMAGE_DIGESTS_FORMAT = '{"id":{{json .Id}},"repoDigests":{{json .RepoDigests}}}';

// A repository as Docker spells it in RepoDigests: Docker Hub's own prefixes left off (`postgres`, `me/app`).
const familiarRepo = (repo: string): string => repo.replace(/^(?:docker\.io|index\.docker\.io)\//, "").replace(/^library\//, "");

// The repository an image reference names, without its tag or digest: `ghcr.io/o/api:main` is `ghcr.io/o/api`, and a
// registry's port (`localhost:5000/app:1`) is no tag.
export const repoOf = (ref: string): string => {
    const named = ref.split("@")[0] ?? ref;
    const slash = named.lastIndexOf("/");
    const colon = named.lastIndexOf(":");
    return familiarRepo(colon > slash ? named.slice(0, colon) : named);
};

// The image a service runs, pinned: the registry digest of the repository the service names, else its image id (a
// locally built image has none, and an image pulled under another name answers for a repository the service never named).
export const pinnedImage = (ref: string, imageId: string, repoDigests: readonly string[]): string =>
    repoDigests.find((digest) => familiarRepo(digest.split("@")[0] ?? "") === repoOf(ref)) ?? imageId;

// One JSON object per line, as a `--format` template prints them; a line of any other shape is left out.
const linesOf = <T>(text: string, schema: z.ZodType<T>): T[] =>
    text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== "")
        .flatMap((line) => parseJsonWith(line, schema) ?? []);

// What one docker read printed, or nothing when it failed.
const printed = async (docker: Docker, args: readonly string[], timeoutMs: number): Promise<string> => {
    const result = await docker(args, { timeoutMs });
    return result.status === 0 ? result.stdout : "";
};

// service → pinned image for every container of the project, the first container of a scaled service answering for
// it; undefined when docker could not say, which leaves the deploy's answer without digests rather than failing a stack
// that is up.
export const readDigests = async (name: string, docker: Docker, timeoutMs: number): Promise<StackImageDigests | undefined> => {
    const containers = parseContainers(await printed(docker, projectContainersArgs(name), timeoutMs)).map((row) => row.container.split(",")[0] ?? row.container);
    const services =
        containers.length === 0
            ? []
            : linesOf(await printed(docker, ["inspect", "--format", CONTAINER_IMAGE_FORMAT, ...containers], timeoutMs), InspectedSchema).filter((one) => one.service !== "");
    const ids = [...new Set(services.map((one) => one.image))];
    if (ids.length === 0) {
        return undefined;
    }
    const images = linesOf(await printed(docker, ["image", "inspect", "--format", IMAGE_DIGESTS_FORMAT, ...ids], timeoutMs), ImageSchema);
    const digests = new Map(images.map((image) => [image.id, image.repoDigests ?? []]));
    const pinned = new Map<string, string>();
    for (const one of services.toSorted((a, b) => a.service.localeCompare(b.service))) {
        if (!pinned.has(one.service)) {
            pinned.set(one.service, pinnedImage(one.ref, one.image, digests.get(one.image) ?? []));
        }
    }
    return images.length === 0 ? undefined : Object.fromEntries(pinned);
};
