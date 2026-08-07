import { execFile, spawn } from "node:child_process";
import { homedir } from "node:os";
import { promisify } from "node:util";
import type { HostScopes, MachineSandbox } from "@intentic/sandbox-contract";
import { assertScope } from "../policy.js";

/* The Intentic sandboxes running on THIS machine — the supervisor's tools.
 *
 * A sandbox can never see its siblings by itself (its docker socket is deliberately not mounted), so "what runs
 * on this computer, and start that one back up" can only be answered here, by the machine's own agent. These
 * tools are what lets the user delegate the machine's fleet to one sandbox: named operations enforced by the
 * `sandboxes` switch, instead of whatever a model improvises through a full shell.
 *
 * The scopes split by what the action DOES (the apps.ts rule): listing is a way of seeing and is subsumed by
 * EITHER grant — a shell could run `docker ps` itself, and a manager that may not look at what it manages is not
 * a coherent grant. Start/stop/restart change what the machine is doing, and take only the `sandboxes` switch.
 * Removal is the one that takes a switch of its own: everything else here is undone by doing it again.
 *
 * The three flows that swap or delete a container are NOT reimplemented here. They live in the `ic` CLI, which
 * every door onto this machine already runs — the pasted one-liner, the desktop app's buttons and a hand-typed
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
 * may legitimately BE `tunnel-something` — so a name is only a sidecar when the workspace container it would
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
            // Assigned rather than spread-in, so a sandbox with no sidecar at all has no `tunnelRunning` KEY —
            // absent and false are different facts (reached over the user's own proxy vs. tunnel down).
            if (tunnel !== undefined) {
                sandbox.tunnelRunning = tunnel.state === "running";
            }
            return sandbox;
        });
};

const docker = async (args: readonly string[]): Promise<string> => {
    const { stdout } = await exec("docker", [...args], { timeout: DOCKER_TIMEOUT_MS }).catch((error: NodeJS.ErrnoException) => {
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

export type SandboxOp = "start" | "stop" | "restart";

export const asSandboxOp = (value: unknown): SandboxOp => {
    if (value !== "start" && value !== "stop" && value !== "restart") {
        throw new Error(`"op" must be "start", "stop" or "restart".`);
    }
    return value;
};

export const manageSandbox = async (op: SandboxOp, slug: string, scopes: HostScopes): Promise<string> => {
    assertScope(scopes, "sandboxes");
    const boxes = await fleet();
    const target = boxes.find((box) => box.slug === slug);
    if (target === undefined) {
        const known = boxes.map((box) => box.slug).join(", ");
        throw new Error(`No sandbox "${slug}" on this computer. ${known === "" ? "It runs none." : `It has: ${known}.`}`);
    }
    // The tunnel sidecar goes wherever its sandbox goes — a "started" sandbox nobody can reach is not started.
    // Stopping fells the tunnel first so nothing routes into a container on its way down; starting raises it last.
    const sidecar = target.tunnelRunning === undefined ? [] : [`${TUNNEL_PREFIX}${slug}`];
    await docker([op, ...(op === "stop" ? [...sidecar, target.container] : [target.container, ...sidecar])]);
    const verb = { start: "Started", stop: "Stopped", restart: "Restarted" }[op];
    return `${verb} sandbox "${slug}"${sidecar.length === 0 ? "" : " and its tunnel"}.`;
};

/* ---- the flows that run `ic` ---- */

// A swap is not a delete: update/rollback move the container onto another image and rebuild re-applies the
// owner-approved overlay, all of them keeping /work and /history. Removal is the separate verb below.
export type SandboxSwap = "update" | "rebuild" | "rollback";

export const asSandboxSwap = (value: unknown): SandboxSwap => {
    if (value !== "update" && value !== "rebuild" && value !== "rollback") {
        throw new Error(`"op" must be "update", "rebuild" or "rollback".`);
    }
    return value;
};

/* Where `ic` is, in the order the installers put it: a root install writes /usr/local/bin, a user install writes
 * under the home and symlinks ~/.local/bin, and Windows only ever has the profile copy. PATH is the last resort
 * rather than the first, for the reason the desktop app states about the sync agent — a developer's global copy
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
 * overlay's digest as a REQUIRED second positional (it is the trust anchor — only content that still hashes to
 * what the owner reviewed is ever built), while update and rollback take the slug alone. Getting this wrong is
 * silent: an argument in the wrong position binds to a different parameter and fails much later as something
 * else. The same class of risk the desktop crate's own argv tests exist for. */
export const icSwapArgs = (swap: SandboxSwap, slug: string, hash: string | undefined): string[] => {
    if (swap === "rebuild") {
        if (hash === undefined || hash === "") {
            throw new Error(`"hash" is required to rebuild — it is the digest of the overlay the owner approved.`);
        }
        return ["sandbox", "rebuild", slug, hash];
    }
    return ["sandbox", swap, slug];
};

// Removal confirms itself: there is no terminal on this end, so `ic`'s own "are you sure" would hang forever.
// The consent happened in the browser, on a card that named what is lost.
export const icRemoveArgs = (slug: string): string[] => ["sandbox", "remove", slug, "-y"];

/* An `ic` run, narrated as it goes. Every line it prints is handed to `onLine` the moment it arrives, which is
 * what lets the browser show progress on an operation that takes minutes — and the same lines are collected for
 * the callers that want one answer at the end (an MCP tool result). Both streams go to one place on purpose:
 * `ic` writes progress to stdout and diagnostics to stderr, and the failure detail is always in the second. */
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
            // ENOENT here means THIS candidate is not installed, not that the run failed — fall through to the
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

// The sandbox has to exist before a flow is started against it — `ic` would say so too, but several minutes and
// an image pull later, and the reader is owed the answer now.
const assertKnown = async (slug: string): Promise<void> => {
    const boxes = await fleet();
    if (boxes.some((box) => box.slug === slug)) {
        return;
    }
    const known = boxes.map((box) => box.slug).join(", ");
    throw new Error(`No sandbox "${slug}" on this computer. ${known === "" ? "It runs none." : `It has: ${known}.`}`);
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
    // round trip — the argument was already wrong when it arrived.
    const args = icSwapArgs(swap, slug, hash);
    await assertKnown(slug);
    const { code, output } = await runIc(args, onLine);
    if (code !== 0) {
        throw new Error(`That ${swap} failed on this computer.\n\n${output}`);
    }
    const verb = { update: "Updated", rebuild: "Rebuilt", rollback: "Rolled back" }[swap];
    return `${verb} sandbox "${slug}". Its files and its history were kept.`;
};

export const removeSandbox = async (slug: string, scopes: HostScopes, onLine: (line: string) => void): Promise<string> => {
    assertScope(scopes, "sandboxRemove");
    await assertKnown(slug);
    const { code, output } = await runIc(icRemoveArgs(slug), onLine);
    if (code !== 0) {
        throw new Error(`That removal failed on this computer.\n\n${output}`);
    }
    return `Removed sandbox "${slug}" and everything in it.`;
};

// How many lines of a container's log to answer with by default, and the ceiling. A log is read to find out why
// something is wrong, so the tail is what matters; the cap is there because this answer crosses a WebSocket that
// also carries everything else the machine is doing.
const DEFAULT_LOG_LINES = 200;
const MAX_LOG_LINES = 2_000;

export const asLogLines = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), MAX_LOG_LINES) : DEFAULT_LOG_LINES;

/* The container's own log. Gated like `list_sandboxes` — it is a way of SEEING what you already manage, and a
 * shell on this machine could run `docker logs` itself — so either grant answers it.
 *
 * Both streams, because a container that died wrote its reason to stderr. `--timestamps` is deliberately off:
 * the daemon stamps its own lines, and docker's wall-clock prefix on every row is mostly noise in a tail. */
export const sandboxLogs = async (slug: string, lines: number, scopes: HostScopes): Promise<string> => {
    if (scopes.shell !== "on") {
        assertScope(scopes, "sandboxes");
    }
    await assertKnown(slug);
    const { stdout, stderr } = await exec("docker", ["logs", "--tail", String(lines), `${PREFIX}${slug}`], {
        timeout: DOCKER_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
    });
    const text = [stdout, stderr].filter((part) => part !== "").join("\n");
    return text === "" ? `Sandbox "${slug}" has logged nothing yet.` : text;
};
