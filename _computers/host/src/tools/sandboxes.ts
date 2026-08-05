import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { HostScopes, MachineSandbox } from "@intentic/sandbox-contract";
import { assertScope } from "../policy.js";

/* The Intentic sandboxes running on THIS machine — the supervisor's tools.
 *
 * A sandbox can never see its siblings by itself (its docker socket is deliberately not mounted), so "what runs
 * on this computer, and start that one back up" can only be answered here, by the machine's own agent. These two
 * tools are what lets the user delegate the machine's fleet to one sandbox: named operations enforced by the
 * `sandboxes` switch, instead of whatever a model improvises through a full shell.
 *
 * The scopes split by what the action DOES (the apps.ts rule): listing is a way of seeing and is subsumed by
 * EITHER grant — a shell could run `docker ps` itself, and a manager that may not look at what it manages is not
 * a coherent grant. Start/stop/restart change what the machine is doing, and take only the `sandboxes` switch. */

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
