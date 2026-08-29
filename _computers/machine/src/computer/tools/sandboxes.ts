import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { HostScopes, MachineSandbox } from "@intentic/sandbox-contract";
import { z } from "zod";
import { assertScope } from "../policy.js";

/* The Intentic sandboxes running on THIS machine, the supervisor's tools.
 *
 * A sandbox can never see its siblings by itself (its docker socket is deliberately not mounted), so "what runs
 * on this computer, and start that one back up" can only be answered here, by the machine's own agent. These
 * tools are what lets the user delegate the machine's fleet to one sandbox: named operations enforced by the
 * `sandboxes` switch, instead of whatever a model improvises through a full shell.
 *
 * The scopes split by what the action DOES (the apps.ts rule): listing is a way of seeing and is subsumed by
 * EITHER grant, a shell could run `docker ps` itself, and a manager that may not look at what it manages is not
 * a coherent grant. Start/stop/restart change what the machine is doing, and take only the `sandboxes` switch.
 * Removal is the one that takes a switch of its own: everything else here is undone by doing it again.
 *
 * The three flows that swap or delete a container are NOT reimplemented here. They live in the `ic` CLI, which
 * every door onto this machine already runs, the pasted one-liner, the desktop app's buttons and a hand-typed
 * `ic` are one implementation, and this is the fourth caller of it rather than a second copy. That is the same
 * argument the desktop app makes for spawning the scripts instead of porting them into Rust. */

const exec = promisify(execFile);

// Long enough for `docker stop`'s grace period plus a slow disk; a docker CLI that takes longer than this is a
// machine in trouble, and the tool is better off saying so than holding the call open.
const DOCKER_TIMEOUT_MS = 120_000;

const PREFIX = "intentic-sandbox-";
const TUNNEL_PREFIX = "intentic-sandbox-tunnel-";

export interface DockerRow {
    readonly names: string;
    readonly state: string;
    readonly image: string;
}

// Docker's own `--format '{{json .}}'` gives one JSON object per line; anything that is not one is a warning or
// a banner riding along, and is skipped rather than thrown on.
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

/* A workspace container and its tunnel sidecar share the `intentic-sandbox-` prefix, and a user's own subdomain
 * may legitimately BE `tunnel-something`, so a name is only a sidecar when the workspace container it would
 * belong to actually exists. The same rule the desktop app applies natively; nothing here guesses. */
export const sandboxesFrom = (rows: readonly DockerRow[]): MachineSandbox[] => {
    const isSidecar = (name: string): boolean => {
        const slug = name.startsWith(TUNNEL_PREFIX) ? name.slice(TUNNEL_PREFIX.length) : undefined;
        return slug !== undefined && rows.some((row) => row.names === `${PREFIX}${slug}`);
    };
    return rows
        .filter((row) => !isSidecar(row.names))
        .map((row) => {
            const slug = row.names.slice(PREFIX.length);
            const tunnel = rows.find((candidate) => candidate.names === `${TUNNEL_PREFIX}${slug}`);
            const sandbox: MachineSandbox = { slug, container: row.names, running: row.state === "running", image: row.image };
            // Assigned rather than spread-in, so a sandbox with no sidecar at all has no `tunnelRunning` KEY,
            // absent and false are different facts (reached over the user's own proxy vs. tunnel down).
            if (tunnel !== undefined) {
                sandbox.tunnelRunning = tunnel.state === "running";
            }
            return sandbox;
        });
};

/* `windowsHide` here and on every other spawn in this agent: the connection loop runs detached, which on Windows
 * means it has no console of its own, and a console child of a console-less process is handed a BRAND-NEW
 * console, window and all. Without the flag, every `docker ps` behind a sandbox listing would flash a black
 * window on the user's desktop. */
const docker = async (args: readonly string[]): Promise<string> => {
    const { stdout } = await exec("docker", [...args], { timeout: DOCKER_TIMEOUT_MS, windowsHide: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") {
            throw new Error("This computer has no docker command, so no Intentic sandboxes can run here.");
        }
        throw error;
    });
    return stdout;
};

const fleet = async (): Promise<MachineSandbox[]> =>
    sandboxesFrom(rowsFrom(await docker(["ps", "-a", "--filter", `name=^${PREFIX}`, "--format", "{{json .}}"])));

// The answer is the JSON itself: the daemon's Computers view reads it verbatim (machine-reports.ts), and a model
// reads keys as well as prose. One producer for both is what stops the tab and the tool from drifting.
export const listSandboxes = async (scopes: HostScopes): Promise<string> => {
    if (scopes.shell !== "on") {
        assertScope(scopes, "sandboxes");
    }
    return JSON.stringify(await fleet(), undefined, 2);
};

// The ops themselves, in the one place that spells them: the MCP tool advertises this schema to the model and
// checks an arriving call against it, so a name added here is offered and accepted in the same commit.
export const SandboxOpSchema = z.enum(["start", "stop", "restart"]);
export type SandboxOp = z.infer<typeof SandboxOpSchema>;

/* WHICH CONTAINER THE SLUG MEANS, or the machine's own answer that it means none, one lookup for every op,
 * because a wrong slug deserves the same sentence whichever button sent it, and because a flow that will take
 * minutes is owed the refusal NOW rather than after an image pull. */
const find = async (slug: string): Promise<MachineSandbox> => {
    const boxes = await fleet();
    const target = boxes.find((box) => box.slug === slug);
    if (target !== undefined) {
        return target;
    }
    const known = boxes.map((box) => box.slug).join(", ");
    throw new Error(`No sandbox "${slug}" on this computer. ${known === "" ? "It runs none." : `It has: ${known}.`}`);
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

/* ---- the flows that run `ic` ---- */

/* A swap is not a delete: update/rollback move the container onto another image and rebuild re-applies the
 * owner-approved overlay, all of them keeping /work and /history. Removal is the separate verb below.
 *
 * `prepare` is the odd one and belongs here anyway: it runs the SAME `ic` flow, over the same minutes, with
 * the same output to narrate, it just stops before the container is touched, downloading and building the
 * next update so that the update itself is a restart rather than a wait. Grouping it with the swaps is what
 * keeps one implementation of "run `ic`, stream what it says". */
export const SandboxSwapSchema = z.enum(["prepare", "update", "rebuild", "rollback"]);
export type SandboxSwap = z.infer<typeof SandboxSwapSchema>;

/* Where `ic` is, in the order the installers put it: a root install writes /usr/local/bin, a user install writes
 * under the home and symlinks ~/.local/bin, and Windows only ever has the profile copy. PATH is the last resort
 * rather than the first, for the reason the desktop app states about the sync agent, a developer's global copy
 * would answer on the machine where this was written and nothing would answer on a real user's.
 *
 * The separator is chosen from the TARGET platform rather than taken from `node:path`, which would use the one
 * the process is running on. This agent's Windows spelling is asserted from a Linux runner (there is no Windows
 * box in the loop until a user's), so a function that quietly answers in the host's dialect cannot be checked. */
export const icCandidates = (platform: NodeJS.Platform, home: string | undefined): string[] => {
    if (platform === "win32") {
        return [...(home === undefined ? [] : [`${home}\\.intentic\\ic\\bin\\ic.exe`]), "ic.exe"];
    }
    return [...(home === undefined ? [] : [`${home}/.intentic/ic/bin/ic`]), "/usr/local/bin/ic", "ic"];
};

/* The argv for each swap, which is the part worth asserting without a machine: `rebuild` takes the approved
 * overlay's digest as a REQUIRED second positional (it is the trust anchor, only content that still hashes to
 * what the owner reviewed is ever built), while update and rollback take the slug alone. Getting this wrong is
 * silent: an argument in the wrong position binds to a different parameter and fails much later as something
 * else. The same class of risk the desktop crate's own argv tests exist for. */
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
// The consent happened in the browser, on a card that named what is lost.
export const icRemoveArgs = (slug: string): string[] => ["sandbox", "remove", slug, "-y"];

/* The parent sandbox's SHAPE, riding along on runner-up so the container starts as its twin: a settings-only
 * definition the runner boots with, and the parent's approved overlay with the sha256 that pins it. All
 * optional — a bare-image runner still runs turns — and file-based below because the overlay is a Dockerfile
 * and the definition is TOML, neither of which belongs on a process command line. */
export interface RunnerShapeFiles {
    readonly definitionFile?: string;
    readonly overlayFile?: string;
    readonly environmentHash?: string;
}

/* The argv for the two RUNNER ops (a sandbox-image container that belongs to a parent sandbox rather than to
 * a person). Asserted without a machine for icSwapArgs' reason, and with one extra worth stating: the pairing
 * is single-use and short-lived, so an argv that dropped it produces a container that boots, dials, is
 * refused, and sits there looking like a network problem. */
export const icRunnerArgs = (op: "runner-up" | "runner-remove", name: string, parentUrl: string | undefined, pair: string | undefined, shape: RunnerShapeFiles = {}): string[] => {
    if (op === "runner-remove") {
        return ["runner", "remove", name, "-y"];
    }
    if (parentUrl === undefined || parentUrl === "" || pair === undefined || pair === "") {
        throw new Error(`starting a runner needs the parent sandbox's address and a pairing, and this request carried ${parentUrl ? "no pairing" : "neither"}.`);
    }
    // Both or neither, `ic`'s own rule restated where the argv is built: the hash is the trust anchor for the
    // overlay bytes, and an overlay riding without it would ask the machine to build unreviewed content.
    if ((shape.overlayFile === undefined) !== (shape.environmentHash === undefined)) {
        throw new Error(`an overlay travels with the hash that pins it, and this request carried ${shape.overlayFile === undefined ? "only the hash" : "only the overlay"}.`);
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
        ...(shape.overlayFile === undefined || shape.environmentHash === undefined ? [] : ["--overlay-file", shape.overlayFile, "--environment-hash", shape.environmentHash]),
    ];
};

/* Start or remove a runner on this computer.
 *
 * BOTH RIDE THE `sandboxes` SWITCH, removal included, and that is the one place this differs from a person's
 * sandbox. The removal switch exists because a sandbox is somebody's workspace and deleting it is undone by
 * nothing; a runner's /work is a MIRROR of the parent's git, so what dies with it is a checkout the parent can
 * hand back. The owner who allowed sandbox containers here allowed this one too. */
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
    /* The definition and overlay arrive as TEXT on the flow and reach `ic` as files: a Dockerfile on a command
     * line is unreadable in every log that quotes it, and the hash check `ic` runs wants bytes on disk anyway.
     * A private temp dir per flow, removed when the run ends either way — nothing here is secret (settings and
     * an owner-approved Dockerfile), but a machine is not a place to accumulate other sandboxes' droppings. */
    const dir = op === "runner-up" && (shape.definition !== undefined || shape.overlay !== undefined) ? await mkdtemp(join(tmpdir(), "intentic-runner-")) : undefined;
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
        // Built first, so a request missing its pairing (or an overlay missing its hash) is refused before
        // anything is spawned.
        const args = icRunnerArgs(op, name, parentUrl, pair, files);
        const { code, output } = await runIc(args, onLine);
        if (code !== 0) {
            throw new Error(`That runner ${op === "runner-up" ? "start" : "removal"} failed on this computer.\n\n${output}`);
        }
        return op === "runner-up"
            ? `Runner "${name}" is up on this computer and pairing with the sandbox that asked for it.`
            : `Removed runner "${name}". Its work lives in the parent sandbox's git, so nothing was lost with it.`;
    } finally {
        if (dir !== undefined) {
            await rm(dir, { recursive: true, force: true });
        }
    }
};

/* An `ic` run, narrated as it goes. Every line it prints is handed to `onLine` the moment it arrives, which is
 * what lets the browser show progress on an operation that takes minutes, and the same lines are collected for
 * the callers that want one answer at the end (an MCP tool result). Both streams go to one place on purpose:
 * `ic` writes progress to stdout and diagnostics to stderr, and the failure detail is always in the second. */
const runIc = async (args: readonly string[], onLine: (line: string) => void): Promise<{ code: number; output: string }> => {
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
            // ENOENT here means THIS candidate is not installed, not that the run failed, fall through to the
            // next one. Any other spawn error is a real failure and is reported as the run's own.
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
                "This computer has no `ic` command, so its sandboxes can't be updated or removed from here. Re-run the sandbox's install command on it to get one.",
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
    // round trip, the argument was already wrong when it arrived.
    const args = icSwapArgs(swap, slug, hash);
    await find(slug);
    const { code, output } = await runIc(args, onLine);
    if (code !== 0) {
        throw new Error(`That ${swap} failed on this computer.\n\n${output}`);
    }
    // `prepare` gets its own sentence because it is the one that did NOT move the sandbox: saying "files were
    // kept" about a container that was never touched would describe a swap that has not happened yet.
    if (swap === "prepare") {
        return `The next update for "${slug}" is downloaded and built. Applying it is now a short restart.`;
    }
    const verb = { update: "Updated", rebuild: "Rebuilt", rollback: "Rolled back" }[swap];
    return `${verb} sandbox "${slug}". Its files and its history were kept.`;
};

export const removeSandbox = async (slug: string, scopes: HostScopes, onLine: (line: string) => void): Promise<string> => {
    assertScope(scopes, "sandboxRemove");
    await find(slug);
    const { code, output } = await runIc(icRemoveArgs(slug), onLine);
    if (code !== 0) {
        throw new Error(`That removal failed on this computer.\n\n${output}`);
    }
    return `Removed sandbox "${slug}" and everything in it.`;
};

/* How many lines of a container's log to answer with by default, and the ceiling. A log is read to find out why
 * something is wrong, so the tail is what matters; the cap is there because this answer crosses a WebSocket that
 * also carries everything else the machine is doing.
 *
 * Both are exported because the MCP tool's schema is built from them, the ceiling is a rule the model is TOLD,
 * in the same sentence that the rule is enforced by, so a bigger tail comes back as "the maximum is 2000"
 * rather than as 2000 lines quietly presented as the 9000 that were asked for. */
export const DEFAULT_LOG_LINES = 200;
export const MAX_LOG_LINES = 2_000;

/* The container's own log. Gated like `list_sandboxes`, it is a way of SEEING what you already manage, and a
 * shell on this machine could run `docker logs` itself, so either grant answers it.
 *
 * Both streams, because a container that died wrote its reason to stderr. `--timestamps` is deliberately off:
 * the daemon stamps its own lines, and docker's wall-clock prefix on every row is mostly noise in a tail.
 *
 * Raw and possibly empty: the two readers phrase "it has said nothing" differently, a model wants a sentence,
 * and the Computers view wants the count for its own, so neither is written into the reading itself. */
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

/* THE SAME READING, AS A FLOW, the Computers view's Logs button, which travels the machine door every other
 * button on that row travels.
 *
 * It is the one op there that changes nothing, and it needs no separate route for exactly the reason the others
 * share one: the stream's shape is already "many lines, then an outcome", which is what a log tail is. The lines
 * arrive as the view's own run log, so a container too broken to answer anything else still gets read from the
 * same button, on the same row, in both apps. */
export const tailSandboxLogs = async (slug: string, scopes: HostScopes, onLine: (line: string) => void): Promise<string> => {
    const lines = (await readLogs(slug, DEFAULT_LOG_LINES, scopes)).split(/\r?\n/).filter((line) => line !== "");
    for (const line of lines) {
        onLine(line);
    }
    return lines.length === 0 ? `"${slug}" has logged nothing yet.` : `The last ${lines.length} lines from "${slug}".`;
};
