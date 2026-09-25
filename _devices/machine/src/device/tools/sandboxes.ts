import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
    type DeviceSandbox,
    DeviceSandboxSchema,
    type DeviceScopes,
    icForgetShapeArgs,
    icPowerArgs,
    icShapeArgs,
    type SandboxResourcesAsk,
    type SandboxShapeFields,
    type SandboxShapeWhen,
} from "@intentic/sandbox-contract";
import { z } from "zod";
import { assertScope } from "../policy.js";
import { ensureCurrentIc, icCandidates } from "./ic-binary.js";

// The Intentic sandboxes running on this machine. A sandbox can't see its siblings itself (its docker socket
// isn't mounted), so this is the only place "what runs here, start that one back up" can be answered. Scopes
// split by what the action does: listing is a way of seeing (either grant), every verb that changes something
// takes `sandboxes`. Every verb runs through the `ic` CLI rather than being reimplemented: ic owns what runs and
// what should run after the next restart, and this file is a caller of it, one implementation for every door.

const exec = promisify(execFile);

// Long enough for a listing on a busy machine (ic bounds each docker read inside it at 20s); longer is a machine in
// trouble, and every caller is a screen or a model waiting to draw.
const LIST_TIMEOUT_MS = 60_000;

// Room for every container's share and a log tail at MAX_LOG_LINES, well past exec's 1 MB default.
const MAX_BUFFER = 8 * 1024 * 1024;

const PREFIX = "intentic-sandbox-";

// `windowsHide` here and on every other spawn in this agent: the connection agent runs detached with no console
// of its own, and a console child of a console-less process gets a brand-new console, window and all.
const docker = async (args: readonly string[]): Promise<{ readonly stdout: string; readonly stderr: string }> =>
    await exec("docker", [...args], { timeout: 120_000, maxBuffer: MAX_BUFFER, windowsHide: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") {
            throw new Error("This device has no docker command, so no Intentic sandboxes can run here.");
        }
        throw error;
    });

// `ic sandbox list --json` prints one line of JSON on stdout (notes, if any, go to stderr), in the contract's own
// shape: running state, the share docker enforces, the shape the container runs with, the shape saved for its next
// restart, and the update staged for it. Parsed, not trusted: a line that is not that shape is ic too old or broken.
export const fleetFrom = (stdout: string): DeviceSandbox[] => {
    const line = stdout
        .split(/\r?\n/)
        .map((text) => text.trim())
        .findLast((text) => text.startsWith("["));
    const parsed = line === undefined ? undefined : z.array(DeviceSandboxSchema).safeParse(JSON.parse(line));
    if (parsed?.success !== true) {
        throw new Error("The `ic` on this device did not answer `ic sandbox list --json`. Re-run the sandbox's install command on it to update ic.");
    }
    return parsed.data;
};

// What runs on this machine, as ic answers it. Exported for the auto-prepare tick (../auto-prepare.ts): one producer of
// "what runs on me", whoever is asking.
export const fleet = async (): Promise<DeviceSandbox[]> => {
    await ensureCurrentIc();
    const candidates = icCandidates(process.platform, homedir());
    for (const [index, binary] of candidates.entries()) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- candidates are tried in order; ENOENT means try the next
        const answer = await exec(binary, ["sandbox", "list", "--json"], { timeout: LIST_TIMEOUT_MS, maxBuffer: MAX_BUFFER, windowsHide: true }).catch(
            (error: NodeJS.ErrnoException & { stderr?: string }) => {
                if (error.code === "ENOENT" && index < candidates.length - 1) {
                    return undefined;
                }
                throw error.code === "ENOENT"
                    ? new Error("This device has no `ic` command, so its sandboxes can't be listed or managed from here. Re-run the sandbox's install command on it to get one.")
                    : new Error(`ic could not list this device's sandboxes: ${(error.stderr ?? error.message).trim()}`);
            },
        );
        if (answer !== undefined) {
            return fleetFrom(answer.stdout);
        }
    }
    throw new Error("no ic candidate was tried");
};

// Which slugs an `ic` flow is touching right now, in this process. The background auto-prepare tick reads it so
// a timer never starts a pull under an update someone is watching stream. Only advisory: a person's click never
// waits on the timer's work, and the flows race benignly.
export const icInFlight = new Set<string>();

// The answer is the JSON itself: the daemon's Devices view reads it verbatim (device-reports.ts), and a model
// reads keys as well as prose.
export const listSandboxes = async (scopes: DeviceScopes): Promise<string> => {
    if (scopes.shell !== "on") {
        assertScope(scopes, "sandboxes");
    }
    return JSON.stringify(await fleet(), undefined, 2);
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

// Start, stop or restart, through ic: it powers the tunnel sidecar with its sandbox (down first, up last), and a start
// or restart with a shape saved for the next restart is the recreate that applies it.
export const manageSandbox = async (
    op: SandboxOp,
    slug: string,
    scopes: DeviceScopes,
    onLine: (line: string) => void = () => {},
): Promise<string> => {
    assertScope(scopes, "sandboxes");
    const target = await find(slug);
    const run = await icFlow(slug, icPowerArgs(op, slug), onLine);
    if (run.code !== 0) {
        throw new Error(`That ${op} failed on this device.\n\n${run.output}`);
    }
    const verb = { start: "Started", stop: "Stopped", restart: "Restarted" }[op];
    const applied = op !== "stop" && target.resources?.desired !== undefined;
    return `${verb} sandbox "${slug}"${applied ? " with the shape saved for its next restart. Its files and its history were kept" : ""}.`;
};

// ---- the flows that run `ic` ----

// A swap is not a delete: update/rollback move the container onto another image and rebuild re-applies the
// owner-approved overlay, all keeping /work and /history. `prepare` runs the same flow but stops before the
// container is touched, so the update that follows is a restart rather than a wait.
export const SandboxSwapSchema = z.enum(["prepare", "update", "rebuild", "rollback"]);
export type SandboxSwap = z.infer<typeof SandboxSwapSchema>;

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

// One argv for both claim-redeeming ops, because `ic sandbox connect` IS both: a claim minted for a row this machine
// already runs reconnects it, and a claim minted for a fresh row builds that sandbox here. What differs is which row
// the claim was minted for, which is decided on the platform and is nothing this side can see.
export const icConnectArgs = (setupCode: string | undefined): string[] => {
    if (setupCode === undefined || setupCode.trim() === "") {
        throw new Error(`"setupCode" is required: it is the claim carrying the values this sandbox is missing.`);
    }
    // No slug in argv: ic derives it from the claim, and a second spelling would build a second sandbox.
    // -y: there is no terminal to answer ic's other-sandboxes prompt.
    // `--` before the code: it is a positional, and a code beginning with a hyphen would otherwise parse as a flag.
    return ["sandbox", "connect", "-y", "--", setupCode.trim()];
};

// A claim is redeemable only on the platform that minted it; host.docker.internal is a container's name for this machine.
export const icConnectEnv = (platformUrl: string | undefined): { readonly PLATFORM_URL: string } => {
    if (platformUrl === undefined || platformUrl.trim() === "") {
        throw new Error(`"platformUrl" is required: a setup code is redeemable only on the platform that minted it.`);
    }
    const url = new URL(platformUrl.trim());
    if (url.hostname === "host.docker.internal") {
        url.hostname = "localhost";
    }
    // ic appends `/setup/claim` itself, so a trailing slash would double it.
    return { PLATFORM_URL: `${url.origin}${url.pathname.replace(/\/+$/, "")}` };
};

// The OLD `reshape` op's argv, kept one release for pages served by sandboxes older than `set-shape`: a delta as
// `ic sandbox reshape` flags, `later` as `--later` (ic validates and saves it as the shape for the next restart), and
// an empty `later` as `--forget`. An empty immediate ask is ic's own "apply what is saved", which ic refuses when
// nothing is. New callers send `set-shape`, spelled once in the contract (`icShapeArgs`).
const capFlag = (value: number | null | undefined, spell: (value: number) => string): string | undefined =>
    value === undefined ? undefined : value === null ? "default" : spell(value);
const switchFlag = (value: boolean | undefined): string | undefined => (value === undefined ? undefined : value ? "on" : "off");

export const icReshapeArgs = (slug: string, ask: SandboxResourcesAsk | undefined, { later = false }: { readonly later?: boolean | undefined } = {}): string[] => {
    const flags: readonly (readonly [string, string | undefined])[] = [
        ["--memory", capFlag(ask?.memoryGib, (gib) => `${gib}g`)],
        ["--cpus", capFlag(ask?.cpus, String)],
        ["--privileged", switchFlag(ask?.privileged)],
        ["--gpus", switchFlag(ask?.gpu)],
    ];
    const given = flags.flatMap(([flag, value]) => (value === undefined ? [] : [flag, value]));
    if (later) {
        return ["sandbox", "reshape", slug, ...(given.length === 0 ? ["--forget"] : [...given, "--later"])];
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
    scopes: DeviceScopes,
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

// One long child process, narrated as it goes. Every line is handed to `onLine` the moment it arrives, and the same
// lines are collected into the answer a caller reports at the end. Both streams go to one place: `ic` writes progress
// to stdout and diagnostics to stderr. `missing` is ENOENT alone — the program isn't there — which the caller answers
// for, since only it knows what was supposed to be at that path.
const runStreamed = (
    binary: string,
    args: readonly string[],
    onLine: (line: string) => void,
    env: Readonly<Record<string, string>>,
): Promise<{ code: number; output: string } | "missing"> => {
    const lines: string[] = [];
    const emit = (chunk: string): void => {
        for (const line of chunk.split(/\r?\n/)) {
            if (line !== "") {
                lines.push(line);
                onLine(line);
            }
        }
    };
    return new Promise((resolve) => {
        const child = spawn(binary, [...args], { windowsHide: true, env: { ...process.env, ...env } });
        let missing = false;
        child.stdout.setEncoding("utf8").on("data", emit);
        child.stderr.setEncoding("utf8").on("data", emit);
        // Any error other than ENOENT is a real failure and is reported as the run's own.
        child.on("error", (error: NodeJS.ErrnoException) => {
            missing = error.code === "ENOENT";
            if (!missing) {
                emit(String(error.message));
            }
            resolve(missing ? "missing" : { code: 1, output: lines.join("\n") });
        });
        child.on("close", (code) => resolve(missing ? "missing" : { code: code ?? 1, output: lines.join("\n") }));
    });
};

// An `ic` run, over the install locations in order: ENOENT means that candidate is not installed, so the next one is
// tried rather than the run being failed. Exported for the auto-prepare tick.
export const runIc = async (
    args: readonly string[],
    onLine: (line: string) => void,
    env: Readonly<Record<string, string>> = {},
): Promise<{ code: number; output: string }> => {
    await ensureCurrentIc();
    const candidates = icCandidates(process.platform, homedir());
    for (const [index, binary] of candidates.entries()) {
        const attempt = await runStreamed(binary, args, onLine, env);
        if (attempt !== "missing") {
            return attempt;
        }
        if (index === candidates.length - 1) {
            throw new Error(
                "This device has no `ic` command, so its sandboxes can't be updated or removed from here. Re-run the sandbox's install command on it to get one.",
            );
        }
    }
    // Unreachable: the agent either returns a run or throws on the last candidate.
    throw new Error("no ic candidate was tried");
};

// One `ic` run on one slug, marked in flight for its whole length so the background tick never pulls under it.
export const icFlow = async (
    slug: string,
    args: readonly string[],
    onLine: (line: string) => void,
    env: Readonly<Record<string, string>> = {},
): Promise<{ code: number; output: string }> => {
    icInFlight.add(slug);
    try {
        return await runIc(args, onLine, env);
    } finally {
        icInFlight.delete(slug);
    }
};

export const swapSandbox = async (
    swap: SandboxSwap,
    slug: string,
    hash: string | undefined,
    scopes: DeviceScopes,
    onLine: (line: string) => void,
): Promise<string> => {
    assertScope(scopes, "sandboxes");
    // Built before the fleet is read, so a rebuild with no digest is refused instantly rather than after a docker
    // round trip.
    const args = icSwapArgs(swap, slug, hash);
    await find(slug);
    const { code, output } = await icFlow(slug, args, onLine);
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

// Set a sandbox's shape, now or for its next restart, over the same `ic` door as the swaps. Rides `sandboxes`, not the
// removal switch, since every value it changes is undone by the next one. The shape is a closed form (two caps, two
// switches) rather than flags, so nothing reaches ic as text; a field left out keeps what ic has for it.
export const shapeSandbox = async (
    slug: string,
    fields: SandboxShapeFields,
    when: SandboxShapeWhen,
    scopes: DeviceScopes,
    onLine: (line: string) => void,
): Promise<string> => {
    assertScope(scopes, "sandboxes");
    if (Object.values(fields).every((value) => value === undefined)) {
        throw new Error("A shape has to set something: a memory or CPU cap, or a privileged/GPU switch. To apply what is saved, restart the sandbox.");
    }
    await find(slug);
    const run = await icFlow(slug, icShapeArgs(slug, fields, when), onLine);
    if (run.code !== 0) {
        throw new Error(`That shape was not ${when === "now" ? "applied" : "saved"} on this device.\n\n${run.output}`);
    }
    return when === "now"
        ? `Reshaped sandbox "${slug}". Its files and its history were kept, and the new shape survives every later update.`
        : `Saved for the next restart of "${slug}" through ic (Restart, Start, an update, a rollback or a rebuild). It keeps running as it is until then.`;
};

export const forgetShape = async (slug: string, scopes: DeviceScopes, onLine: (line: string) => void): Promise<string> => {
    assertScope(scopes, "sandboxes");
    await find(slug);
    const run = await icFlow(slug, icForgetShapeArgs(slug), onLine);
    if (run.code !== 0) {
        throw new Error(`That could not be forgotten on this device.\n\n${run.output}`);
    }
    return `Nothing is saved for the next restart of "${slug}" any more. It keeps running as it is.`;
};

// The old `reshape` op, for one release (see icReshapeArgs).
export const reshapeSandbox = async (
    slug: string,
    ask: SandboxResourcesAsk | undefined,
    scopes: DeviceScopes,
    onLine: (line: string) => void,
    { later = false }: { readonly later?: boolean | undefined } = {},
): Promise<string> => {
    assertScope(scopes, "sandboxes");
    const args = icReshapeArgs(slug, ask, { later });
    await find(slug);
    const run = await icFlow(slug, args, onLine);
    if (run.code !== 0) {
        throw new Error(`That reshape failed on this device.\n\n${run.output}`);
    }
    const empty = ask === undefined || Object.values(ask).every((value) => value === undefined);
    if (later) {
        return empty
            ? `Nothing is saved for the next restart of "${slug}" any more. It keeps running as it is.`
            : `Saved for the next restart of "${slug}" through ic. It keeps running as it is until then.`;
    }
    return `Reshaped sandbox "${slug}". Its files and its history were kept, and the new share survives every later update.`;
};

export const reconnectSandbox = async (
    slug: string,
    setupCode: string | undefined,
    platformUrl: string | undefined,
    scopes: DeviceScopes,
    onLine: (line: string) => void,
): Promise<string> => {
    assertScope(scopes, "sandboxes");
    const args = icConnectArgs(setupCode);
    const env = icConnectEnv(platformUrl);
    // find(slug) first: redeeming the claim for a slug not on this machine would burn it for nothing.
    await find(slug);
    const run = await icFlow(slug, args, onLine, env);
    if (run.code !== 0) {
        throw new Error(`That reconnect failed on this device.\n\n${run.output}`);
    }
    return `Reconnected sandbox "${slug}". Its files and its history were kept, and it now has what it was missing.`;
};

// A sandbox this machine does not run yet, from a claim minted for a row that has never been anywhere. The same `ic`
// flow as a reconnect and the OPPOSITE precondition: `slug` is the name the claim will produce (the first label of the
// hostname the platform minted), so a container already answering to it means the claim would recreate somebody else's
// sandbox — refused here, before the code is spent, because a setup code is single-use and burning one costs the
// caller a whole round trip to the platform.
export const createSandbox = async (
    slug: string,
    setupCode: string | undefined,
    platformUrl: string | undefined,
    scopes: DeviceScopes,
    onLine: (line: string) => void,
): Promise<string> => {
    assertScope(scopes, "sandboxes");
    const args = icConnectArgs(setupCode);
    const env = icConnectEnv(platformUrl);
    if ((await fleet()).some((box) => box.slug === slug)) {
        throw new Error(`This device already runs a sandbox called "${slug}". Nothing was created and the setup code was not spent.`);
    }
    const run = await icFlow(slug, args, onLine, env);
    if (run.code !== 0) {
        throw new Error(`That sandbox could not be created on this device.\n\n${run.output}`);
    }
    return `Created sandbox "${slug}" on this device.`;
};

// Rides `sandboxes` like every other verb: a fleet nobody may delete from is one the owner can't clean up. The
// data outlives this by a week (`ic sandbox restore`), but the interruption does not, so the confirmation is
// still the caller's job.
export const removeSandbox = async (slug: string, scopes: DeviceScopes, onLine: (line: string) => void): Promise<string> => {
    assertScope(scopes, "sandboxes");
    await find(slug);
    const run = await icFlow(slug, icRemoveArgs(slug), onLine);
    if (run.code !== 0) {
        throw new Error(`That removal failed on this device.\n\n${run.output}`);
    }
    return `Removed sandbox "${slug}". Its files and its history are kept for a week — 'ic sandbox restore ${slug}' on this device brings it back.`;
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
const readLogs = async (slug: string, lines: number, scopes: DeviceScopes): Promise<string> => {
    if (scopes.shell !== "on") {
        assertScope(scopes, "sandboxes");
    }
    await find(slug);
    const { stdout, stderr } = await docker(["logs", "--tail", String(lines), `${PREFIX}${slug}`]);
    return [stdout, stderr].filter((part) => part !== "").join("\n");
};

export const sandboxLogs = async (slug: string, lines: number | undefined, scopes: DeviceScopes): Promise<string> => {
    const text = await readLogs(slug, lines ?? DEFAULT_LOG_LINES, scopes);
    return text === "" ? `Sandbox "${slug}" has logged nothing yet.` : text;
};

// The same reading, as a flow: the Devices view's Logs button, travelling the machine door every other button
// on that row travels. It changes nothing, and needs no separate route since the stream's shape is already
// "many lines, then an outcome".
export const tailSandboxLogs = async (slug: string, scopes: DeviceScopes, onLine: (line: string) => void): Promise<string> => {
    const lines = (await readLogs(slug, DEFAULT_LOG_LINES, scopes)).split(/\r?\n/).filter((line) => line !== "");
    for (const line of lines) {
        onLine(line);
    }
    return lines.length === 0 ? `"${slug}" has logged nothing yet.` : `The last ${lines.length} lines from "${slug}".`;
};
