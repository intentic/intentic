import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { plural } from "@intentic/base/format";
import { homeDir } from "@intentic/local-agent";
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
import { inFlightMarks } from "../sandbox-rounds/in-flight.js";

// The Intentic sandboxes running on this machine. A sandbox can't see its siblings itself (its docker socket
// isn't mounted), so this is the only place "what runs here, start that one back up" can be answered. Scopes
// split by what the action does: listing is a way of seeing (either grant), every verb that changes something
// takes `sandboxes`. Every verb runs through the `ic` CLI rather than being reimplemented: ic owns what runs and
// what should run after the next restart, and this file is a caller of it, one implementation for every door.

const exec = promisify(execFile);

// Long enough for a listing on a busy machine (ic bounds each docker read inside it at 20s); longer is a machine in
// trouble, and every caller is a screen or a model waiting to draw.
const LIST_TIMEOUT_MS = 60_000;

// Room for every container's share, well past exec's 1 MB default.
const MAX_BUFFER = 8 * 1024 * 1024;

// One row of the listing as it arrived, before it is read as the contract's.
const ListedRowSchema = z.record(z.string(), z.json());
type ListedRow = z.infer<typeof ListedRowSchema>;

// What a row is (which sandbox, its container, whether it runs, on what image) against what an ic newer than this agent
// may say about it in a way this agent cannot read yet: a new outcome word, a new kind of rollback target.
const REQUIRED_FIELDS: ReadonlySet<string> = new Set(["slug", "container", "running", "image"]);

// A row read as the contract's, dropping only the optional fields that do not parse, so a newer ic's answer about one
// of them costs that field rather than the whole listing. A row whose identity does not parse is no row at all.
const rowFrom = (row: ListedRow): DeviceSandbox | undefined => {
    const whole = DeviceSandboxSchema.safeParse(row);
    if (whole.success) {
        return whole.data;
    }
    const failed = new Set(whole.error.issues.map((issue) => String(issue.path[0] ?? "")));
    if ([...failed].some((field) => REQUIRED_FIELDS.has(field) || field === "")) {
        return undefined;
    }
    const kept = DeviceSandboxSchema.safeParse(Object.fromEntries(Object.entries(row).filter(([field]) => !failed.has(field))));
    return kept.success ? kept.data : undefined;
};

// `ic sandbox list --json` prints one line of JSON on stdout (notes, if any, go to stderr), in the contract's own
// shape: running state, the share docker enforces, the shape the container runs with, the shape saved for its next
// restart, the update staged for it, and (from a newer ic) its version, whether it is parked mid-swap, its probation
// and what it can roll back to. Parsed, not trusted: a line that is not a list of rows is ic too old or broken.
export const fleetFrom = (stdout: string): DeviceSandbox[] => {
    const line = stdout
        .split(/\r?\n/)
        .map((text) => text.trim())
        .findLast((text) => text.startsWith("["));
    const parsed = line === undefined ? undefined : z.array(ListedRowSchema).safeParse(JSON.parse(line));
    const rows = parsed?.success === true ? parsed.data.map(rowFrom) : [undefined];
    const read = rows.filter((row) => row !== undefined);
    if (read.length !== rows.length) {
        throw new Error("The `ic` on this device did not answer `ic sandbox list --json`. Re-run the sandbox's install command on it to update ic.");
    }
    return read;
};

// What runs on this machine, as ic answers it. Exported for the auto-prepare tick (../auto-prepare.ts): one producer of
// "what runs on me", whoever is asking. `current: false` asks whatever ic is installed without first fetching a newer
// one: what a command deciding whether the agent stays needs (resident.ts), where a download would be out of place.
export const fleet = async ({ current = true }: { readonly current?: boolean } = {}): Promise<DeviceSandbox[]> => {
    if (current) {
        await ensureCurrentIc();
    }
    const candidates = icCandidates(process.platform, homeDir());
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

// Which slugs an `ic` flow is touching right now, in this process. The background rounds (auto-prepare, the daily
// backup, the probation watch) read it so a timer never starts work under an update someone is watching stream. Only
// advisory: a person's click never waits on the timer's work, and the flows race benignly.
const flows = inFlightMarks();
export const icInFlight: ReadonlySet<string> = flows.slugs;

// The subset of those flows that move a container (every one but a prepare, a shape saved for later and its forget):
// what an agent restart must not land in the middle of. A separate process's upgrade cannot see this set, and reads
// ic's own record of the cutover instead (swap-records.ts).
const swaps = inFlightMarks();
export const icSwapsInFlight: ReadonlySet<string> = swaps.slugs;

// Marks one flow on `slug` in both sets it belongs to until the returned release runs. Counted per flow, so two flows
// overlapping on one slug keep it marked until the second ends; the release is safe to call twice.
export const holdIcFlow = (slug: string, { moves }: { readonly moves: boolean }): (() => void) => {
    const releaseFlow = flows.hold(slug);
    const releaseSwap = moves ? swaps.hold(slug) : undefined;
    return () => {
        releaseFlow();
        releaseSwap?.();
    };
};

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
// wrong slug gets the same sentence whichever button sent it, and so a flow that will take minutes is refused now. A
// sandbox an interrupted swap left parked is listed under its own slug, not running, and is found like any other:
// start, rollback and update are exactly what bring it back.
export const findIn = (boxes: readonly DeviceSandbox[], slug: string): DeviceSandbox => {
    const target = boxes.find((box) => box.slug === slug);
    if (target !== undefined) {
        return target;
    }
    const known = boxes.map((box) => (box.parked === true ? `${box.slug} (parked mid-swap)` : box.slug)).join(", ");
    throw new Error(`No sandbox "${slug}" on this device. ${known === "" ? "It runs none." : `It has: ${known}.`}`);
};

const find = async (slug: string): Promise<DeviceSandbox> => findIn(await fleet(), slug);

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
    const run = await icFlow(slug, icPowerArgs(op, slug), onLine, { moves: true });
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
// different parameter and fails silently, much later, as something else. `to` is rollback's alone: a version or pinned
// image from the sandbox's `rollbackTargets` to go back to instead of the previous one, refused on any other swap
// rather than dropped, since a swap carried out without it would be a different swap.
export const icSwapArgs = (swap: SandboxSwap, slug: string, hash: string | undefined, to?: string): string[] => {
    if (to !== undefined && swap !== "rollback") {
        throw new Error(`"to" names a version to go back to, which only a rollback takes, not ${swap}.`);
    }
    if (swap === "rebuild") {
        if (hash === undefined || hash === "") {
            throw new Error(`"hash" is required to rebuild: it is the digest of the overlay the owner approved.`);
        }
        return ["sandbox", "rebuild", slug, hash];
    }
    return to === undefined ? ["sandbox", swap, slug] : ["sandbox", swap, slug, "--to", to];
};

// Removal confirms itself: there is no terminal on this end, so `ic`'s own "are you sure" would hang forever.
// Consent happened in the browser, on a card that named what is lost.
export const icRemoveArgs = (slug: string): string[] => ["sandbox", "remove", slug, "-y"];

// One argv for both claim-redeeming ops, because `ic sandbox connect` IS both: a claim minted for a row this machine
// already runs reconnects it, and a claim minted for a fresh row builds that sandbox here. What differs is which row
// the claim was minted for, which is decided on the platform and is nothing this side can see, and whether ic may
// replace a sandbox it finds under that name: only a reconnect says so, and ic refuses one that exists otherwise.
export const icConnectArgs = (setupCode: string | undefined, op: "create" | "reconnect"): string[] => {
    if (setupCode === undefined || setupCode.trim() === "") {
        throw new Error(`"setupCode" is required: it is the claim carrying the values this sandbox is missing.`);
    }
    // No slug in argv: ic derives it from the claim, and a second spelling would build a second sandbox.
    // -y: there is no terminal to answer ic's other-sandboxes prompt.
    // --replace: the owner confirmed reinstalling this sandbox in the browser; ic keeps what it was set up as.
    // `--` before the code: it is a positional, and a code beginning with a hyphen would otherwise parse as a flag.
    return ["sandbox", "connect", "-y", ...(op === "reconnect" ? ["--replace"] : []), "--", setupCode.trim()];
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

// One stream's chunks back into its lines. A pipe hands over whatever it has, so a chunk may end mid-line: the tail is
// held until its newline arrives (or the stream ends), and a blank line is a line like any other, since a log's
// spacing is part of what it says. Only the empty remainder after a final newline is not a line. Pure, so the
// boundaries are asserted without a child.
export interface LineSplitter {
    readonly push: (chunk: string) => void;
    readonly end: () => void;
}
export const lineSplitter = (onLine: (line: string) => void): LineSplitter => {
    let partial = "";
    return {
        push: (chunk) => {
            const parts = (partial + chunk).split(/\r?\n/);
            partial = parts.pop() ?? "";
            for (const line of parts) {
                onLine(line);
            }
        },
        end: () => {
            // A CR the chunk boundary split from its LF.
            const last = partial.replace(/\r$/, "");
            partial = "";
            if (last !== "") {
                onLine(last);
            }
        },
    };
};

// What one `ic` run answered: its exit code, every line it printed on either stream, and whether it outlived the
// deadline its caller gave it and was stopped.
export interface IcRun {
    readonly code: number;
    readonly output: string;
    readonly timedOut?: boolean;
}

// A deadline in the words a log line says it in.
const spanOf = (ms: number): string => (ms >= 60_000 ? plural(Math.round(ms / 60_000), "minute") : plural(Math.round(ms / 1_000), "second"));

// How long a stopped run's process group has to leave after SIGTERM before it is killed outright.
const STOP_GRACE_MS = 10_000;

// Ends a run that outlived its deadline, with whatever it started: its process group on POSIX (it leads one, below), its
// process tree on Windows, where only taskkill reaches the children.
const stopRun = (child: ChildProcess): void => {
    const pid = child.pid;
    if (pid === undefined) {
        return;
    }
    if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => child.kill());
        return;
    }
    const signal = (name: NodeJS.Signals): void => {
        try {
            process.kill(-pid, name);
        } catch {
            // allow(silent-catch): the group is already gone, which is what this was for
        }
    };
    signal("SIGTERM");
    setTimeout(() => signal("SIGKILL"), STOP_GRACE_MS).unref();
};

// One long child process, narrated as it goes. Every line is handed to `onLine` the moment it arrives, and the same
// lines are collected into the answer a caller reports at the end. Both streams go to one place: `ic` writes progress
// to stdout and diagnostics to stderr. `missing` is ENOENT alone — the program isn't there — which the caller answers
// for, since only it knows what was supposed to be at that path.
// On POSIX the child gets a process group of its own: a signal meant for the agent's group (a supervisor stopping it, a
// terminal's Ctrl-C) never reaches an ic that has parked a container and not yet started its replacement. Nothing here
// ever kills it either, when the link or request that asked goes away: the swap finishes, and the probation watch
// judges it. The one exception is a `deadlineMs` its caller set, which only a background round does (the keeper's fix,
// where a Docker Desktop that never comes up must not hold every later round): past it the run is stopped and answers
// `timedOut`. Windows has no groups to leave, and a detached child there would get a console window.
const runStreamed = (
    binary: string,
    args: readonly string[],
    onLine: (line: string) => void,
    env: Readonly<Record<string, string>>,
    deadlineMs: number | undefined,
): Promise<IcRun | "missing"> => {
    const lines: string[] = [];
    const take = (line: string): void => {
        lines.push(line);
        onLine(line);
    };
    // One splitter per stream: the two interleave, and a partial line belongs to the stream that began it.
    const out = lineSplitter(take);
    const err = lineSplitter(take);
    const flush = (): void => {
        out.end();
        err.end();
    };
    return new Promise((resolve) => {
        const child = spawn(binary, [...args], { windowsHide: true, env: { ...process.env, ...env }, detached: process.platform !== "win32" });
        let missing = false;
        let timedOut = false;
        const deadline =
            deadlineMs === undefined
                ? undefined
                : setTimeout(() => {
                      timedOut = true;
                      stopRun(child);
                  }, deadlineMs);
        const answer = (code: number): IcRun => {
            clearTimeout(deadline);
            if (timedOut) {
                lines.push(`ic did not finish within ${spanOf(deadlineMs ?? 0)} and was stopped.`);
            }
            return timedOut ? { code, output: lines.join("\n"), timedOut } : { code, output: lines.join("\n") };
        };
        child.stdout.setEncoding("utf8").on("data", out.push);
        child.stderr.setEncoding("utf8").on("data", err.push);
        // Any error other than ENOENT is a real failure and is reported as the run's own.
        child.on("error", (error: NodeJS.ErrnoException) => {
            missing = error.code === "ENOENT";
            flush();
            if (!missing) {
                take(String(error.message));
            }
            clearTimeout(deadline);
            resolve(missing ? "missing" : answer(1));
        });
        child.on("close", (code) => {
            flush();
            resolve(missing ? "missing" : answer(code ?? 1));
        });
    });
};

// An `ic` run, over the install locations in order: ENOENT means that candidate is not installed, so the next one is
// tried rather than the run being failed. Exported for the auto-prepare tick. `deadlineMs` bounds a background round's
// run (see runStreamed); every flow a person or a sandbox asked for leaves it unset.
export const runIc = async (
    args: readonly string[],
    onLine: (line: string) => void,
    env: Readonly<Record<string, string>> = {},
    { deadlineMs }: { readonly deadlineMs?: number } = {},
): Promise<IcRun> => {
    await ensureCurrentIc();
    const candidates = icCandidates(process.platform, homeDir());
    for (const [index, binary] of candidates.entries()) {
        const attempt = await runStreamed(binary, args, onLine, env, deadlineMs);
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

// The same `ic`, run in a person's own terminal (`intentic-machine sandbox …`): its streams are the terminal's, so its
// prompts, colours and JSON reach them untouched, and it stays in the terminal's process group, where Ctrl-C belongs to
// the person watching. Answers ic's exit code.
export const runIcAttached = async (args: readonly string[]): Promise<number> => {
    await ensureCurrentIc();
    const candidates = icCandidates(process.platform, homeDir());
    for (const [index, binary] of candidates.entries()) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- candidates are tried in order; ENOENT means try the next
        const code = await new Promise<number | "missing">((resolve) => {
            const child = spawn(binary, [...args], { stdio: "inherit", windowsHide: true });
            child.once("error", (error: NodeJS.ErrnoException) => {
                if (error.code !== "ENOENT") {
                    process.stderr.write(`${error.message}\n`);
                }
                resolve(error.code === "ENOENT" ? "missing" : 1);
            });
            child.once("close", (exit) => resolve(exit ?? 1));
        });
        if (code !== "missing") {
            return code;
        }
        if (index === candidates.length - 1) {
            throw new Error("This device has no `ic` command. Re-run a sandbox's install command on it to get one.");
        }
    }
    throw new Error("no ic candidate was tried");
};

// One `ic` run on one slug, marked in flight for its whole length so the background rounds never start work under it,
// and, when it `moves` a container, so this agent does not restart under it either (tools/agent.ts, auto-upgrade.ts).
export const icFlow = async (
    slug: string,
    args: readonly string[],
    onLine: (line: string) => void,
    { env = {}, moves }: { readonly env?: Readonly<Record<string, string>>; readonly moves: boolean },
): Promise<{ code: number; output: string }> => {
    const release = holdIcFlow(slug, { moves });
    try {
        return await runIc(args, onLine, env);
    } finally {
        release();
    }
};

// `prepare` under the unattended rules, the one argv the background tick (sandbox-rounds/auto-prepare.ts) and the
// `prepare-background` op both run: nobody pressed anything, so ic skips a pinned sandbox and the version it went back
// from, and treats low disk as "not now". Dropping `--auto` would run the attended flow's judgement calls unattended.
export const icBackgroundPrepareArgs = (slug: string): string[] => ["sandbox", "prepare", slug, "--auto"];

// The update card's own nudge when it opens: the download the background tick would run within the next few hours, run
// now. It answers with ic's last line (downloaded, already current, or skipped and why), since unlike an attended
// prepare every one of those is a fine ending; only ic failing outright is an error.
export const prepareInBackground = async (slug: string, scopes: DeviceScopes, onLine: (line: string) => void): Promise<string> => {
    assertScope(scopes, "sandboxes");
    await find(slug);
    const { code, output } = await icFlow(slug, icBackgroundPrepareArgs(slug), onLine, { moves: false });
    if (code !== 0) {
        throw new Error(`The background download for "${slug}" failed on this device.\n\n${output}`);
    }
    return output.split(/\r?\n/).findLast((line) => line.trim() !== ``) ?? `Nothing to download for "${slug}" right now.`;
};

export const swapResult = (swap: SandboxSwap, slug: string, output: string, to?: string): string => {
    if (swap === "update" && output.includes("no newer sandbox image is available yet")) {
        return `Sandbox "${slug}" is already up to date. Nothing was restarted.`;
    }
    if (swap === "prepare") {
        return `The next update for "${slug}" is downloaded and built. Applying it is now a short restart.`;
    }
    const verb = { update: "Updated", rebuild: "Rebuilt", rollback: to === undefined ? "Rolled back" : `Rolled back to ${to}` }[swap];
    return `${verb} sandbox "${slug}". Its files and its history were kept.`;
};

export const swapSandbox = async (
    swap: SandboxSwap,
    slug: string,
    hash: string | undefined,
    scopes: DeviceScopes,
    onLine: (line: string) => void,
    to?: string,
): Promise<string> => {
    assertScope(scopes, "sandboxes");
    // Built before the fleet is read, so a rebuild with no digest is refused instantly rather than after a docker
    // round trip.
    const args = icSwapArgs(swap, slug, hash, to);
    await find(slug);
    const { code, output } = await icFlow(slug, args, onLine, { moves: swap !== "prepare" });
    if (code !== 0) {
        throw new Error(`That ${swap} failed on this device.\n\n${output}`);
    }
    return swapResult(swap, slug, output, to);
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
    const run = await icFlow(slug, icShapeArgs(slug, fields, when), onLine, { moves: when === "now" });
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
    const run = await icFlow(slug, icForgetShapeArgs(slug), onLine, { moves: false });
    if (run.code !== 0) {
        throw new Error(`That could not be forgotten on this device.\n\n${run.output}`);
    }
    return `Nothing is saved for the next restart of "${slug}" any more. It keeps running as it is.`;
};

// The OLD `reshape` op, kept one release for pages served by sandboxes older than `set-shape`, carried out through the
// same `ic sandbox shape` argv as `set-shape` (the contract's `icShapeArgs`) so there is one spelling of the shape
// flags: a delta now is a shape now, a delta with `later` a shape for the next restart, an empty `later` the forget,
// and an empty delta now the restart that applies what is saved. Pure, so the mapping is asserted without an ic.
export type OlderResizePlan =
    | { readonly kind: "shape"; readonly fields: SandboxShapeFields; readonly when: SandboxShapeWhen }
    | { readonly kind: "forget" }
    | { readonly kind: "apply-saved" };
export const olderResizePlan = (ask: SandboxResourcesAsk | undefined, later: boolean): OlderResizePlan => {
    const fields: SandboxShapeFields = ask ?? {};
    const empty = Object.values(fields).every((value) => value === undefined);
    if (empty) {
        return later ? { kind: "forget" } : { kind: "apply-saved" };
    }
    return { kind: "shape", fields, when: later ? "nextRestart" : "now" };
};

export const reshapeSandbox = async (
    slug: string,
    ask: SandboxResourcesAsk | undefined,
    scopes: DeviceScopes,
    onLine: (line: string) => void,
    { later = false }: { readonly later?: boolean | undefined } = {},
): Promise<string> => {
    assertScope(scopes, "sandboxes");
    const plan = olderResizePlan(ask, later);
    if (plan.kind === "shape") {
        return await shapeSandbox(slug, plan.fields, plan.when, scopes, onLine);
    }
    if (plan.kind === "forget") {
        return await forgetShape(slug, scopes, onLine);
    }
    // ic's old bare reshape refused when nothing was saved; a restart would not, so the refusal is kept here.
    if ((await find(slug)).resources?.desired === undefined) {
        throw new Error(`Nothing is saved for the next restart of "${slug}", so there is nothing to apply.`);
    }
    return await manageSandbox("restart", slug, scopes, onLine);
};

export const reconnectSandbox = async (
    slug: string,
    setupCode: string | undefined,
    platformUrl: string | undefined,
    scopes: DeviceScopes,
    onLine: (line: string) => void,
): Promise<string> => {
    assertScope(scopes, "sandboxes");
    const args = icConnectArgs(setupCode, "reconnect");
    const env = icConnectEnv(platformUrl);
    // find(slug) first: redeeming the claim for a slug not on this machine would burn it for nothing.
    await find(slug);
    const run = await icFlow(slug, args, onLine, { env, moves: true });
    if (run.code !== 0) {
        throw new Error(`That reconnect failed on this device.\n\n${run.output}`);
    }
    return `Reconnected sandbox "${slug}". Its files, history, logins and settings were kept, and it now has what it was missing.`;
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
    const args = icConnectArgs(setupCode, "create");
    const env = icConnectEnv(platformUrl);
    if ((await fleet()).some((box) => box.slug === slug)) {
        throw new Error(`This device already runs a sandbox called "${slug}". Nothing was created and the setup code was not spent.`);
    }
    const run = await icFlow(slug, args, onLine, { env, moves: true });
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
    const run = await icFlow(slug, icRemoveArgs(slug), onLine, { moves: true });
    if (run.code !== 0) {
        throw new Error(`That removal failed on this device.\n\n${run.output}`);
    }
    return `Removed sandbox "${slug}". Its files and its history are kept for a week — 'ic sandbox restore ${slug}' on this device brings it back.`;
};

// What `diagnose_sandbox` may name: a container name's characters, never starting with the dash ic would read as a flag.
const ADDRESSABLE_SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

// A doctor probes a handful of addresses, each bounded by ic; past this it is hung, and a model is waiting.
const DOCTOR_DEADLINE_MS = 2 * 60_000;

export const icDoctorArgs = (slug: string): string[] => {
    if (!ADDRESSABLE_SLUG.test(slug)) {
        throw new Error(`"${slug}" is not a sandbox slug; list_sandboxes names them.`);
    }
    return ["sandbox", "doctor", slug, "--json"];
};

// Every link of one sandbox's reachability chain (Docker, its container, its daemon, its registration, the tunnel),
// checked by `ic sandbox doctor --json` and answered in ic's own words and JSON. Read-only, and gated like the logs. No
// `find` first: this is asked most while Docker is down, when the listing cannot answer, and ic refuses a slug it does
// not know itself. A doctor that found something broken exits non-zero with its report, which is still the answer; one
// that printed no JSON at all is an ic from before `doctor --json`, said as a failure with ic's own words.
export const diagnoseSandbox = async (slug: string, scopes: DeviceScopes): Promise<string> => {
    if (scopes.shell !== "on") {
        assertScope(scopes, "sandboxes");
    }
    const run = await runIc(icDoctorArgs(slug), () => {}, {}, { deadlineMs: DOCTOR_DEADLINE_MS });
    if (run.code !== 0 && !run.output.includes("{")) {
        throw new Error(`"${slug}" could not be diagnosed on this device.\n\n${run.output}`);
    }
    return run.output;
};

// How many lines of a container's log to answer with by default, and the ceiling. A log is read to find out why
// something is wrong, so the tail matters; the cap exists because the answer crosses a WebSocket that also
// carries everything else the machine is doing. Both are exported so the MCP tool's schema is built from the
// same numbers it is enforced by.
export const DEFAULT_LOG_LINES = 200;
export const MAX_LOG_LINES = 2_000;

// The container's own log, gated like `list_sandboxes` since it's a way of seeing what you already manage, read
// through `ic sandbox logs` like every other verb here: both streams, since a container that died wrote its reason to
// stderr. Possibly empty, since the two readers phrase "it has said nothing" differently.
const readLogs = async (slug: string, lines: number, scopes: DeviceScopes): Promise<string> => {
    if (scopes.shell !== "on") {
        assertScope(scopes, "sandboxes");
    }
    await find(slug);
    const run = await runIc(["sandbox", "logs", slug, "--tail", String(lines)], () => {});
    if (run.code !== 0) {
        throw new Error(`The log of "${slug}" could not be read on this device.\n\n${run.output}`);
    }
    return run.output;
};

export const sandboxLogs = async (slug: string, lines: number | undefined, scopes: DeviceScopes): Promise<string> => {
    const text = await readLogs(slug, lines ?? DEFAULT_LOG_LINES, scopes);
    return text === "" ? `Sandbox "${slug}" has logged nothing yet.` : text;
};

// The same reading, as a flow: the Devices view's Logs button, travelling the machine door every other button
// on that row travels. It changes nothing, and needs no separate route since the stream's shape is already
// "many lines, then an outcome".
export const tailSandboxLogs = async (slug: string, scopes: DeviceScopes, onLine: (line: string) => void): Promise<string> => {
    // Blank lines kept: they are the log's own spacing (runStreamed keeps them too).
    const output = await readLogs(slug, DEFAULT_LOG_LINES, scopes);
    const lines = output === "" ? [] : output.split(/\r?\n/);
    for (const line of lines) {
        onLine(line);
    }
    return lines.length === 0 ? `"${slug}" has logged nothing yet.` : `The last ${lines.length} lines from "${slug}".`;
};
