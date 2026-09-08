import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { HostScopes, DeviceSandbox, SandboxResources, SandboxResourcesAsk } from "@intentic/sandbox-contract";
import { HOST_RUNTIME_ENV, OVERLAY_RUNTIME_ENV } from "@intentic/sandbox-run";
import { z } from "zod";
import { assertScope } from "../policy.js";

// The Intentic sandboxes running on this machine. A sandbox can't see its siblings itself (its docker socket
// isn't mounted), so this is the only place "what runs here, start that one back up" can be answered. Scopes
// split by what the action does: listing is a way of seeing (either grant), start/stop/restart take
// `sandboxes`, removal takes its own switch. The swap/remove flows run through the `ic` CLI rather than being
// reimplemented, one implementation for every door onto this machine.

const exec = promisify(execFile);

// Long enough for `docker stop`'s grace period plus a slow disk; a docker CLI that takes longer than this is a
// machine in trouble.
const DOCKER_TIMEOUT_MS = 120_000;

const PREFIX = "intentic-sandbox-";
const TUNNEL_PREFIX = "intentic-sandbox-tunnel-";

export interface DockerRow {
    readonly names: string;
    readonly state: string;
    readonly image: string;
}

// Docker's own `--format '{{json .}}'` gives one JSON object per line; anything that is not one is a warning or
// banner riding along, skipped rather than thrown on.
export const rowsFrom = (stdout: string): DockerRow[] =>
    stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith("{"))
        .flatMap((line) => {
            try {
                const parsed = JSON.parse(line) as { Names?: unknown; State?: unknown; Image?: unknown };
                return typeof parsed.Names === "string" ? [{ names: parsed.Names, state: String(parsed.State), image: String(parsed.Image) }] : [];
            } catch {
                return [];
            }
        });

// A workspace container and its tunnel sidecar share the `intentic-sandbox-` prefix, and a user's own subdomain
// may legitimately BE `tunnel-something`, so a name is only a sidecar when the workspace container it would
// belong to actually exists.
export const sandboxesFrom = (rows: readonly DockerRow[]): DeviceSandbox[] => {
    const isSidecar = (name: string): boolean => {
        const slug = name.startsWith(TUNNEL_PREFIX) ? name.slice(TUNNEL_PREFIX.length) : undefined;
        return slug !== undefined && rows.some((row) => row.names === `${PREFIX}${slug}`);
    };
    return rows
        .filter((row) => !isSidecar(row.names))
        .map((row) => {
            const slug = row.names.slice(PREFIX.length);
            const tunnel = rows.find((candidate) => candidate.names === `${TUNNEL_PREFIX}${slug}`);
            const sandbox: DeviceSandbox = { slug, container: row.names, running: row.state === "running", image: row.image };
            // Assigned rather than spread-in, so a sandbox with no sidecar at all has no `tunnelRunning` key: absent
            // and
            // false are different facts.
            if (tunnel !== undefined) {
                sandbox.tunnelRunning = tunnel.state === "running";
            }
            return sandbox;
        });
};

// `windowsHide` here and on every other spawn in this agent: the connection loop runs detached with no console
// of its own, and a console child of a console-less process gets a brand-new console, window and all.
const docker = async (args: readonly string[]): Promise<string> => {
    const { stdout } = await exec("docker", [...args], { timeout: DOCKER_TIMEOUT_MS, windowsHide: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") {
            throw new Error("This device has no docker command, so no Intentic sandboxes can run here.");
        }
        throw error;
    });
    return stdout;
};

// Exported for the auto-prepare tick (../auto-prepare.ts): one producer of "what runs on me", whoever is asking.
export const fleet = async (): Promise<DeviceSandbox[]> =>
    sandboxesFrom(rowsFrom(await docker(["ps", "-a", "--filter", `name=^${PREFIX}`, "--format", "{{json .}}"])));

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

// One `NAME=value` out of a container's env list, or undefined when it carries none by that name.
const envOf = (env: unknown, name: string): string | undefined =>
    Array.isArray(env)
        ? env.find((entry): entry is string => typeof entry === "string" && entry.startsWith(`${name}=`))?.slice(name.length + 1)
        : undefined;

const tokensOf = (value: string | undefined): string[] => (value ?? "").split(/\s+/).filter((token) => token !== "");

// One container's share of the machine, read off its `docker inspect` object. `Memory`/`NanoCpus` are 0 for
// "unbounded" (absent here), a GPU is a DeviceRequest for the nvidia driver or the `gpu` capability, and which
// directive is whose is the pair of env stamps the run contract leaves on the container (SANDBOX_RUNTIME the
// owner's, SANDBOX_OVERLAY_RUNTIME the approved environment's).
// A docker limit field: a positive number is a cap, 0 (docker's "unbounded") and anything else is none.
const capOf = (value: unknown): number | undefined => (typeof value === "number" && value > 0 ? value : undefined);

// Whether a HostConfig's DeviceRequests carry the GPU, in either spelling docker writes for `--gpus`.
const gpuRequested = (host: Record<string, unknown>): boolean =>
    (Array.isArray(host["DeviceRequests"]) ? host["DeviceRequests"] : []).some(
        (request) =>
            isRecord(request) &&
            (request["Driver"] === "nvidia" ||
                (Array.isArray(request["Capabilities"]) && request["Capabilities"].some((set) => Array.isArray(set) && set.includes("gpu")))),
    );

export const resourcesFrom = (inspected: unknown): SandboxResources | undefined => {
    if (!isRecord(inspected)) {
        return undefined;
    }
    const host = isRecord(inspected["HostConfig"]) ? inspected["HostConfig"] : {};
    const env = isRecord(inspected["Config"]) ? inspected["Config"]["Env"] : undefined;
    const memory = capOf(host["Memory"]);
    const nanos = capOf(host["NanoCpus"]);
    return {
        ...(memory === undefined ? {} : { memoryBytes: memory }),
        ...(nanos === undefined ? {} : { cpus: nanos / 1_000_000_000 }),
        privileged: host["Privileged"] === true,
        gpu: gpuRequested(host),
        hostRuntime: tokensOf(envOf(env, HOST_RUNTIME_ENV)),
        overlayRuntime: tokensOf(envOf(env, OVERLAY_RUNTIME_ENV)),
    };
};

// The fleet WITH each container's share of the machine: one `docker inspect` on top of the `docker ps` above.
// `fleet()` answers "which slug is this" for every op, none of which need a HostConfig; this is for the listing
// a person or model reads, where the caps and privileges are the point. A container that vanished between the
// two calls makes `docker inspect` exit non-zero with the others still on stdout, so the partial answer is kept.
export const fleetDetailed = async (): Promise<DeviceSandbox[]> => {
    const boxes = await fleet();
    if (boxes.length === 0) {
        return boxes;
    }
    const inspected = await exec("docker", ["inspect", "--format", "{{json .}}", ...boxes.map((box) => box.container)], {
        timeout: DOCKER_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
    })
        .then(({ stdout }) => stdout)
        .catch((error: { stdout?: string }) => error.stdout ?? "");
    const byContainer = new Map<string, SandboxResources>();
    for (const line of inspected.split(/\r?\n/)) {
        if (!line.trim().startsWith("{")) {
            continue;
        }
        try {
            const parsed: unknown = JSON.parse(line);
            const resources = resourcesFrom(parsed);
            // docker names the inspected container with a leading slash, which no other reader here uses.
            const name = isRecord(parsed) && typeof parsed["Name"] === "string" ? parsed["Name"].replace(/^\//, "") : undefined;
            if (name !== undefined && resources !== undefined) {
                byContainer.set(name, resources);
            }
        } catch {
            // A line that is not one inspect object is a warning riding along; the rows it did print still count.
        }
    }
    return boxes.map((box) => {
        const resources = byContainer.get(box.container);
        return resources === undefined ? box : { ...box, resources };
    });
};

// Which slugs an `ic` flow is touching right now, in this process. The background auto-prepare tick reads it so
// a timer never starts a pull under an update someone is watching stream. Only advisory: a person's click never
// waits on the timer's work, and the flows race benignly.
export const icInFlight = new Set<string>();

// The answer is the JSON itself: the daemon's Devices view reads it verbatim (device-reports.ts), and a model
// reads keys as well as prose.
export const listSandboxes = async (scopes: HostScopes): Promise<string> => {
    if (scopes.shell !== "on") {
        assertScope(scopes, "sandboxes");
    }
    return JSON.stringify(await fleetDetailed(), undefined, 2);
};

// The ops themselves, in the one place that spells them: the MCP tool advertises this schema to the model and
// checks an arriving call against it.
export const SandboxOpSchema = z.enum(["start", "stop", "restart"]);
export type SandboxOp = z.infer<typeof SandboxOpSchema>;

// Which container the slug means, or the machine's own answer that it means none: one lookup for every op, so a
// wrong slug gets the same sentence whichever button sent it, and so a flow that will take minutes is refused now.
const find = async (slug: string): Promise<DeviceSandbox> => {
    const boxes = await fleet();
    const target = boxes.find((box) => box.slug === slug);
    if (target !== undefined) {
        return target;
    }
    const known = boxes.map((box) => box.slug).join(", ");
    throw new Error(`No sandbox "${slug}" on this device. ${known === "" ? "It runs none." : `It has: ${known}.`}`);
};

export const manageSandbox = async (op: SandboxOp, slug: string, scopes: HostScopes): Promise<string> => {
    assertScope(scopes, "sandboxes");
    const target = await find(slug);
    // The tunnel sidecar goes wherever its sandbox goes, a "started" sandbox nobody can reach is not started.
    // Stopping fells the tunnel first so nothing routes into a container on its way down; starting raises it last.
    const sidecar = target.tunnelRunning === undefined ? [] : [`${TUNNEL_PREFIX}${slug}`];
    await docker([op, ...(op === "stop" ? [...sidecar, target.container] : [target.container, ...sidecar])]);
    const verb = { start: "Started", stop: "Stopped", restart: "Restarted" }[op];
    return `${verb} sandbox "${slug}"${sidecar.length === 0 ? "" : " and its tunnel"}.`;
};

// ---- the flows that run `ic` ----

// A swap is not a delete: update/rollback move the container onto another image and rebuild re-applies the
// owner-approved overlay, all keeping /work and /history. `prepare` runs the same flow but stops before the
// container is touched, so the update that follows is a restart rather than a wait.
export const SandboxSwapSchema = z.enum(["prepare", "update", "rebuild", "rollback"]);
export type SandboxSwap = z.infer<typeof SandboxSwapSchema>;

// Where `ic` is, in the order the installers put it: a root install writes /usr/local/bin, a user install
// writes under the home and symlinks ~/.local/bin, Windows only ever has the profile copy. PATH is the last
// resort, since a developer's global copy would answer here and nothing would answer on a real user's machine.
// The separator is chosen from the target platform, not from `node:path`, so the Windows spelling can be
// asserted from a Linux runner.
export const icCandidates = (platform: NodeJS.Platform, home: string | undefined): string[] => {
    if (platform === "win32") {
        return [...(home === undefined ? [] : [`${home}\\.intentic\\ic\\bin\\ic.exe`]), "ic.exe"];
    }
    return [...(home === undefined ? [] : [`${home}/.intentic/ic/bin/ic`]), "/usr/local/bin/ic", "ic"];
};

// The argv for each swap: `rebuild` takes the approved overlay's digest as a required second positional (the
// trust anchor), while update and rollback take the slug alone. An argument in the wrong position binds to a
// different parameter and fails silently, much later, as something else.
export const icSwapArgs = (swap: SandboxSwap, slug: string, hash: string | undefined): string[] => {
    if (swap === "rebuild") {
        if (hash === undefined || hash === "") {
            throw new Error(`"hash" is required to rebuild: it is the digest of the overlay the owner approved.`);
        }
        return ["sandbox", "rebuild", slug, hash];
    }
    return ["sandbox", swap, slug];
};

// Removal confirms itself: there is no terminal on this end, so `ic`'s own "are you sure" would hang forever.
// Consent happened in the browser, on a card that named what is lost.
export const icRemoveArgs = (slug: string): string[] => ["sandbox", "remove", slug, "-y"];

export const icReconnectArgs = (setupCode: string | undefined): string[] => {
    if (setupCode === undefined || setupCode.trim() === "") {
        throw new Error(`"setupCode" is required to reconnect: it is the claim carrying the values this sandbox is missing.`);
    }
    // No slug in argv: ic derives it from the claim, and a second spelling would build a second sandbox.
    // -y: there is no terminal to answer ic's other-sandboxes prompt.
    return ["sandbox", "connect", setupCode.trim(), "-y"];
};

// The reshape argv, spelled the way `ic sandbox reshape` takes it: a cap as `<n>g`/`<n>`, `null` as ic's
// `default`, a switch as an explicit on/off. Nothing is interpreted here; a reshape with nothing to change is
// refused before anything is spawned.
// A cap's flag value: absent means no flag, null means ic's `default`, a number is spelled the way ic takes it.
const capFlag = (value: number | null | undefined, spell: (value: number) => string): string | undefined =>
    value === undefined ? undefined : value === null ? "default" : spell(value);
// A switch's flag value: absent means no flag, otherwise the explicit word ic requires (a bare flag could only add).
const switchFlag = (value: boolean | undefined): string | undefined => (value === undefined ? undefined : value ? "on" : "off");

export const icReshapeArgs = (slug: string, ask: SandboxResourcesAsk | undefined): string[] => {
    const flags: readonly (readonly [string, string | undefined])[] = [
        ["--memory", capFlag(ask?.memoryGib, (gib) => `${gib}g`)],
        ["--cpus", capFlag(ask?.cpus, String)],
        ["--privileged", switchFlag(ask?.privileged)],
        ["--gpus", switchFlag(ask?.gpu)],
    ];
    const given = flags.flatMap(([flag, value]) => (value === undefined ? [] : [flag, value]));
    if (given.length === 0) {
        throw new Error(`A reshape has to change something: give a memory or CPU cap, or a privileged/GPU switch.`);
    }
    return ["sandbox", "reshape", slug, ...given];
};

// The parent sandbox's shape, riding along on runner-up so the container starts as its twin: a settings-only
// definition, and the approved overlay pinned to its hash. All optional, and file-based because the overlay is
// a Dockerfile and the definition is TOML, neither of which belongs on a command line.
export interface RunnerShapeFiles {
    readonly definitionFile?: string;
    readonly overlayFile?: string;
    readonly environmentHash?: string;
}

// The argv for the two runner ops (a sandbox-image container that belongs to a parent sandbox rather than a
// person). The pairing is single-use and short-lived; an argv that dropped it produces a container that boots,
// dials, is refused, and looks like a network problem.
export const icRunnerArgs = (
    op: "runner-up" | "runner-remove",
    name: string,
    parentUrl: string | undefined,
    pair: string | undefined,
    shape: RunnerShapeFiles = {},
): string[] => {
    if (op === "runner-remove") {
        return ["runner", "remove", name, "-y"];
    }
    if (parentUrl === undefined || parentUrl === "" || pair === undefined || pair === "") {
        throw new Error(
            `starting a runner needs the parent sandbox's address and a pairing, and this request carried ${parentUrl ? "no pairing" : "neither"}.`,
        );
    }
    // Both or neither, `ic`'s own rule restated where the argv is built: the hash is the trust anchor for the
    // overlay bytes.
    if ((shape.overlayFile === undefined) !== (shape.environmentHash === undefined)) {
        throw new Error(
            `an overlay travels with the hash that pins it, and this request carried ${shape.overlayFile === undefined ? "only the hash" : "only the overlay"}.`,
        );
    }
    return [
        "runner",
        "up",
        parentUrl,
        "--pair",
        pair,
        "--name",
        name,
        ...(shape.definitionFile === undefined ? [] : ["--definition-file", shape.definitionFile]),
        ...(shape.overlayFile === undefined || shape.environmentHash === undefined
            ? []
            : ["--overlay-file", shape.overlayFile, "--environment-hash", shape.environmentHash]),
    ];
};

// Start or remove a runner on this device. Both ride the `sandboxes` switch, removal included: a runner's
// /work is a mirror of the parent's git, so what dies with it is a checkout the parent can hand back, unlike a
// person's sandbox.
export const runnerFlow = async (
    op: "runner-up" | "runner-remove",
    name: string,
    parentUrl: string | undefined,
    pair: string | undefined,
    shape: { definition?: string; overlay?: string; overlayHash?: string },
    scopes: HostScopes,
    onLine: (line: string) => void,
): Promise<string> => {
    assertScope(scopes, "sandboxes");
    // The definition and overlay arrive as text on the flow and reach `ic` as files: a Dockerfile on a command line
    // is unreadable in every log that quotes it, and the hash check `ic` runs wants bytes on disk anyway. A private
    // temp dir per flow, removed when the run ends either way.
    const dir =
        op === "runner-up" && (shape.definition !== undefined || shape.overlay !== undefined)
            ? await mkdtemp(join(tmpdir(), "intentic-runner-"))
            : undefined;
    try {
        const withDefinition = dir !== undefined && shape.definition !== undefined;
        const withOverlay = dir !== undefined && shape.overlay !== undefined;
        if (withDefinition) {
            await writeFile(join(dir, "sandbox.toml"), shape.definition ?? "", "utf8");
        }
        if (withOverlay) {
            await writeFile(join(dir, "overlay.Dockerfile"), shape.overlay ?? "", "utf8");
        }
        const files: RunnerShapeFiles = {
            ...(withDefinition ? { definitionFile: join(dir, "sandbox.toml") } : {}),
            ...(withOverlay ? { overlayFile: join(dir, "overlay.Dockerfile") } : {}),
            ...(withOverlay && shape.overlayHash !== undefined ? { environmentHash: shape.overlayHash } : {}),
        };
        // Built first, so a request missing its pairing (or an overlay missing its hash) is refused before anything is
        // spawned.
        const args = icRunnerArgs(op, name, parentUrl, pair, files);
        const { code, output } = await runIc(args, onLine);
        if (code !== 0) {
            throw new Error(`That runner ${op === "runner-up" ? "start" : "removal"} failed on this device.\n\n${output}`);
        }
        return op === "runner-up"
            ? `Runner "${name}" is up on this device and pairing with the sandbox that asked for it.`
            : `Removed runner "${name}". Its work lives in the parent sandbox's git, so nothing was lost with it.`;
    } finally {
        if (dir !== undefined) {
            await rm(dir, { recursive: true, force: true });
        }
    }
};

// An `ic` run, narrated as it goes. Every line is handed to `onLine` the moment it arrives, and the same lines
// are collected for callers that want one answer at the end. Both streams go to one place: `ic` writes progress
// to stdout and diagnostics to stderr. Exported for the auto-prepare tick.
export const runIc = async (args: readonly string[], onLine: (line: string) => void): Promise<{ code: number; output: string }> => {
    const candidates = icCandidates(process.platform, homedir());
    const lines: string[] = [];
    const emit = (chunk: string): void => {
        for (const line of chunk.split(/\r?\n/)) {
            if (line !== "") {
                lines.push(line);
                onLine(line);
            }
        }
    };
    for (const [index, binary] of candidates.entries()) {
        const attempt = await new Promise<{ code: number; output: string } | "missing">((resolve) => {
            const child = spawn(binary, [...args], { windowsHide: true });
            let missing = false;
            child.stdout.setEncoding("utf8").on("data", emit);
            child.stderr.setEncoding("utf8").on("data", emit);
            // ENOENT here means this candidate is not installed, not that the run failed: fall through to the next one.
            // Any
            // other spawn error is a real failure and is reported as the run's own.
            child.on("error", (error: NodeJS.ErrnoException) => {
                missing = error.code === "ENOENT";
                if (!missing) {
                    emit(String(error.message));
                }
                resolve(missing ? "missing" : { code: 1, output: lines.join("\n") });
            });
            child.on("close", (code) => resolve(missing ? "missing" : { code: code ?? 1, output: lines.join("\n") }));
        });
        if (attempt !== "missing") {
            return attempt;
        }
        if (index === candidates.length - 1) {
            throw new Error(
                "This device has no `ic` command, so its sandboxes can't be updated or removed from here. Re-run the sandbox's install command on it to get one.",
            );
        }
    }
    // Unreachable: the loop either returns a run or throws on the last candidate.
    throw new Error("no ic candidate was tried");
};

export const swapSandbox = async (
    swap: SandboxSwap,
    slug: string,
    hash: string | undefined,
    scopes: HostScopes,
    onLine: (line: string) => void,
): Promise<string> => {
    assertScope(scopes, "sandboxes");
    // Built before the fleet is read, so a rebuild with no digest is refused instantly rather than after a docker
    // round trip.
    const args = icSwapArgs(swap, slug, hash);
    await find(slug);
    icInFlight.add(slug);
    let run: { code: number; output: string };
    try {
        run = await runIc(args, onLine);
    } finally {
        icInFlight.delete(slug);
    }
    const { code, output } = run;
    if (code !== 0) {
        throw new Error(`That ${swap} failed on this device.\n\n${output}`);
    }
    // `prepare` gets its own sentence because it did NOT move the sandbox: saying "files were kept" about a
    // container that was never touched would describe a swap that hasn't happened yet.
    if (swap === "prepare") {
        return `The next update for "${slug}" is downloaded and built. Applying it is now a short restart.`;
    }
    const verb = { update: "Updated", rebuild: "Rebuilt", rollback: "Rolled back" }[swap];
    return `${verb} sandbox "${slug}". Its files and its history were kept.`;
};

// Change a sandbox's share of this machine, or its privileges, over the same `ic` door as the swaps. Rides
// `sandboxes`, not the removal switch, since every value it changes is undone by the next reshape. The ask is a
// closed form (two caps, two switches) rather than flags, so nothing reaches docker as text.
export const reshapeSandbox = async (
    slug: string,
    ask: SandboxResourcesAsk | undefined,
    scopes: HostScopes,
    onLine: (line: string) => void,
): Promise<string> => {
    assertScope(scopes, "sandboxes");
    // Built before the fleet is read, for icSwapArgs' reason: an empty ask was already wrong when it arrived.
    const args = icReshapeArgs(slug, ask);
    await find(slug);
    icInFlight.add(slug);
    let run: { code: number; output: string };
    try {
        run = await runIc(args, onLine);
    } finally {
        icInFlight.delete(slug);
    }
    if (run.code !== 0) {
        throw new Error(`That reshape failed on this device.\n\n${run.output}`);
    }
    return `Reshaped sandbox "${slug}". Its files and its history were kept, and the new share survives every later update.`;
};

// sandboxes scope, not sandboxRemove: /work and /history survive a reconnect.
export const reconnectSandbox = async (
    slug: string,
    setupCode: string | undefined,
    scopes: HostScopes,
    onLine: (line: string) => void,
): Promise<string> => {
    assertScope(scopes, "sandboxes");
    const args = icReconnectArgs(setupCode);
    // find(slug) first: redeeming the claim for a slug not on this machine would burn it for nothing.
    await find(slug);
    icInFlight.add(slug);
    let run: { code: number; output: string };
    try {
        run = await runIc(args, onLine);
    } finally {
        icInFlight.delete(slug);
    }
    if (run.code !== 0) {
        throw new Error(`That reconnect failed on this device.\n\n${run.output}`);
    }
    return `Reconnected sandbox "${slug}". Its files and its history were kept, and it now has what it was missing.`;
};

export const removeSandbox = async (slug: string, scopes: HostScopes, onLine: (line: string) => void): Promise<string> => {
    assertScope(scopes, "sandboxRemove");
    await find(slug);
    icInFlight.add(slug);
    let run: { code: number; output: string };
    try {
        run = await runIc(icRemoveArgs(slug), onLine);
    } finally {
        icInFlight.delete(slug);
    }
    if (run.code !== 0) {
        throw new Error(`That removal failed on this device.\n\n${run.output}`);
    }
    return `Removed sandbox "${slug}" and everything in it.`;
};

// How many lines of a container's log to answer with by default, and the ceiling. A log is read to find out why
// something is wrong, so the tail matters; the cap exists because the answer crosses a WebSocket that also
// carries everything else the machine is doing. Both are exported so the MCP tool's schema is built from the
// same numbers it is enforced by.
export const DEFAULT_LOG_LINES = 200;
export const MAX_LOG_LINES = 2_000;

// The container's own log, gated like `list_sandboxes` since it's a way of seeing what you already manage. Both
// streams, since a container that died wrote its reason to stderr. `--timestamps` is off: the daemon stamps its
// own lines. Raw and possibly empty, since the two readers phrase "it has said nothing" differently.
const readLogs = async (slug: string, lines: number, scopes: HostScopes): Promise<string> => {
    if (scopes.shell !== "on") {
        assertScope(scopes, "sandboxes");
    }
    await find(slug);
    const { stdout, stderr } = await exec("docker", ["logs", "--tail", String(lines), `${PREFIX}${slug}`], {
        timeout: DOCKER_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
    });
    return [stdout, stderr].filter((part) => part !== "").join("\n");
};

export const sandboxLogs = async (slug: string, lines: number | undefined, scopes: HostScopes): Promise<string> => {
    const text = await readLogs(slug, lines ?? DEFAULT_LOG_LINES, scopes);
    return text === "" ? `Sandbox "${slug}" has logged nothing yet.` : text;
};

// The same reading, as a flow: the Devices view's Logs button, travelling the machine door every other button
// on that row travels. It changes nothing, and needs no separate route since the stream's shape is already
// "many lines, then an outcome".
export const tailSandboxLogs = async (slug: string, scopes: HostScopes, onLine: (line: string) => void): Promise<string> => {
    const lines = (await readLogs(slug, DEFAULT_LOG_LINES, scopes)).split(/\r?\n/).filter((line) => line !== "");
    for (const line of lines) {
        onLine(line);
    }
    return lines.length === 0 ? `"${slug}" has logged nothing yet.` : `The last ${lines.length} lines from "${slug}".`;
};
