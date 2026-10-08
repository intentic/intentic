import { randomBytes } from "node:crypto";
import { chmod, chown, mkdir, readFile, unlink } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isAbsolute, join, normalize } from "node:path";
import { forkedExec } from "@intentic/base/git";
import { errnoCode } from "@intentic/base/errors";
import { AGENT_SESSION_PREFIX } from "@intentic/sandbox-contract/session-names";
import type { Logger } from "pino";
import { isNoTmuxTarget } from "./tmux-server.js";
import { AGENT_GID } from "../workload/agent-domain.js";
import { DOOR_DIR } from "../workload/agent-domain-view.js";
import { agentPaneLine, type NamespaceEntryReference } from "../workload/namespace-entry.js";

// A DOMAIN'S BASH PANES, OPENED BY THE DAEMON. An agent in the unprivileged domain cannot reach the root tmux server, and
// must not: that server starts panes anywhere, as root. So bin/tmux-run asks this door instead, over a socket the domain
// sees at PANE_DOOR_PATH, and the daemon makes the window itself with the domain's own way in (agentPaneLine): a pane
// opened here can only ever run inside that domain. The socket is the credential. Each domain gets its own, in a
// directory only the daemon writes, so a request arriving on it comes from that domain and names no other.
//
// What the door does for tmux-run is what tmux-run did itself in root mode, and nothing more: open a window in the turn's
// agent session (remain-on-exit set in the same command, so a fast command cannot outrun it, and the session stamped with
// its conversation), say whether a window it opened is dead, and end one. A session another conversation owns is
// refused, and a pane this door did not open is not one it answers for.

// tmux-run's epitaph for a finished pane; the same text it sets itself in root mode (bin/tmux-run, `epitaph`).
export const PANE_EPITAPH =
    "#{?#{==:#{pane_dead_status},0},#[fg=green]✓ finished,#[fg=red]✗ #{?#{!=:#{pane_dead_signal},},signal #{pane_dead_signal},exit #{pane_dead_status}}}#[default] · #{t:pane_dead_time}";

const SESSION = new RegExp(`^${AGENT_SESSION_PREFIX}[A-Za-z0-9_-]{1,8}$`, "u");
const WINDOW = /^[a-z0-9_-]{1,24}$/u;
const PANE = /^%\d{1,9}$/u;
const MAX_BODY = 16_384;
// tmux calls in flight per door: a domain asking faster than tmux answers is told to wait, not handed a fork each time.
const MAX_INFLIGHT = 8;

export interface PaneDoor {
    // The socket's path in the daemon's own view (DOOR_DIR), which the domain's view binds at PANE_DOOR_PATH.
    readonly socket: string;
    // Admits requests for this domain from now on. Before it, every request is refused: no domain exists to open in.
    readonly attach: (namespace: NamespaceEntryReference) => void;
    readonly close: () => Promise<void>;
}

export interface PaneDoorDeps {
    // The conversation the domain's sessions are stamped with (@intentic_owner, the value tmux-run stamps in root mode).
    readonly owner: string | undefined;
    readonly logger: Pick<Logger, "warn">;
    // One tmux invocation; stdout. Injected so a test answers for tmux without a server.
    readonly tmux?: (args: readonly string[]) => Promise<string>;
    readonly dir?: string;
    // Hands the socket to the domain's group. Injected so a test needs no root.
    readonly provision?: (socket: string) => Promise<void>;
}

// Root's own, reached by the domain through its group, like every endpoint its view binds (agent-domain-view.ts).
const provisionSocket = async (socket: string): Promise<void> => {
    await chown(socket, 0, AGENT_GID);
    await chmod(socket, 0o660);
};

const runTmux = async (args: readonly string[]): Promise<string> => (await forkedExec("tmux", args, { timeout: 10_000 })).stdout;

// A path the domain names for its own view: absolute and clean, so it cannot smuggle a second argument or a newline into
// the line tmux runs. Where it leads is the domain's own business: --wdns resolves it inside the domain.
const domainPath = (value: string | null): string | undefined =>
    value !== null && value.length <= 4096 && isAbsolute(value) && normalize(value) === value && !/[\u0000-\u001f\u007f]/u.test(value)
        ? value
        : undefined;

const readForm = async (request: IncomingMessage): Promise<URLSearchParams> => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > MAX_BODY) {
            throw new Error("request too large");
        }
        chunks.push(bytes);
    }
    return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
};

const reply = (response: ServerResponse, status: number, body: string): void => {
    response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
    response.end(body.endsWith("\n") ? body : `${body}\n`);
};

export const openPaneDoor = async (deps: PaneDoorDeps): Promise<PaneDoor> => {
    const tmux = deps.tmux ?? runTmux;
    const dir = deps.dir ?? DOOR_DIR;
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    const socket = join(dir, `${randomBytes(9).toString("base64url")}.sock`);
    let namespace: NamespaceEntryReference | undefined;
    const opened = new Set<string>();
    let inflight = 0;

    // The session's owner, or undefined for a session that does not exist yet.
    const ownerOf = async (session: string): Promise<string | undefined> => {
        try {
            return (await tmux(["display-message", "-p", "-t", `=${session}:`, "#{@intentic_owner}"])).trim();
        } catch (error) {
            if (isNoTmuxTarget(error)) {
                return undefined;
            }
            throw error;
        }
    };

    // Window options go to the session's current window, which the window just made is: one command list runs whole,
    // before tmux reads a child's exit, so remain-on-exit is on before the pane's command can end.
    const settle = (session: string): string[] => [
        ";", "set-option", "-w", "-t", `=${session}:`, "remain-on-exit", "on",
        ";", "set-option", "-w", "-t", `=${session}:`, "remain-on-exit-format", PANE_EPITAPH,
        ...(deps.owner === undefined ? [] : [";", "set-option", "-t", `=${session}:`, "@intentic_owner", deps.owner]),
    ];

    // The windows of this door's finished commands, as tmux-run prunes them; asked after a new window exists, so the
    // session outlives its own prune. Best-effort: a window already gone is what a prune wanted.
    const pruneFinished = async (session: string): Promise<void> => {
        try {
            const listing = await tmux(["list-panes", "-s", "-t", `=${session}`, "-F", "#{pane_dead} #{window_id} #{pane_id}"]);
            for (const [dead, windowId, paneId] of listing.split("\n").map((row) => row.split(" "))) {
                if (dead === "1" && windowId !== undefined && paneId !== undefined && opened.has(paneId)) {
                    opened.delete(paneId);
                    await tmux(["kill-window", "-t", windowId]).catch(() => undefined);
                }
            }
        } catch {
            // allow(silent-catch): nothing listed is nothing to prune.
        }
    };

    const open = async (form: URLSearchParams, target: NamespaceEntryReference): Promise<[number, string]> => {
        const session = form.get("session") ?? "";
        const name = form.get("name") ?? "run";
        const cwd = domainPath(form.get("cwd"));
        const runner = domainPath(form.get("runner"));
        if (!SESSION.test(session) || !WINDOW.test(name) || cwd === undefined || runner === undefined || !runner.endsWith("/runner")) {
            return [400, "invalid pane request"];
        }
        const owner = await ownerOf(session);
        if (owner !== undefined && owner !== "" && owner !== deps.owner) {
            return [403, "that session belongs to another conversation"];
        }
        const line = agentPaneLine(target, cwd, "bash", [runner]);
        const window = ["-P", "-F", "#{pane_id}", "-n", name, "-c", "/", line];
        const attach = async (): Promise<string> => tmux(["new-window", "-t", `=${session}:`, ...window, ...settle(session)]);
        const create = async (): Promise<string> => tmux(["new-session", "-d", "-s", session, ...window, ...settle(session)]);
        // Racing first commands create the session in both orders, as in tmux-run: attach, else create, else attach.
        const createOrAttach = async (): Promise<string> => {
            try {
                return await create();
            } catch {
                return attach();
            }
        };
        let pane: string;
        if (owner === undefined) {
            pane = await createOrAttach();
        } else {
            try {
                pane = await attach();
            } catch (error) {
                if (!isNoTmuxTarget(error)) {
                    throw error;
                }
                pane = await createOrAttach();
            }
        }
        const id = pane.trim().split("\n")[0] ?? "";
        if (!PANE.test(id)) {
            return [500, "tmux did not name the pane it opened"];
        }
        opened.add(id);
        void pruneFinished(session);
        return [200, id];
    };

    const dead = async (pane: string): Promise<[number, string]> => {
        try {
            return [200, (await tmux(["display-message", "-p", "-t", pane, "#{pane_dead}"])).trim() === "0" ? "0" : "1"];
        } catch {
            // A pane tmux no longer knows is as dead as one that exited: tmux-run stops waiting either way.
            return [200, "1"];
        }
    };

    // The pane's command runs as the leader of a session inside the domain (agentPaneLine), a child of the window's own
    // process; ending that session ends what the command left running, as tmux-run's endpane does in root mode.
    const kill = async (pane: string): Promise<[number, string]> => {
        try {
            const leader = (await tmux(["display-message", "-p", "-t", pane, "#{pane_pid}"])).trim();
            if (/^\d+$/u.test(leader)) {
                const children = (await readFile(`/proc/${leader}/task/${leader}/children`, "utf8").catch(() => "")).trim().split(/\s+/u).filter(Boolean);
                for (const child of children) {
                    await forkedExec("pkill", ["-TERM", "-s", child], { timeout: 5_000 }).catch(() => undefined);
                }
            }
        } finally {
            await tmux(["kill-window", "-t", pane]).catch(() => undefined);
            opened.delete(pane);
        }
        return [200, "killed"];
    };

    const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
        const target = namespace;
        if (target === undefined) {
            reply(response, 503, "this domain is not ready");
            return;
        }
        if (inflight >= MAX_INFLIGHT) {
            reply(response, 503, "too many pane requests at once");
            return;
        }
        inflight += 1;
        try {
            const url = new URL(request.url ?? "/", "http://pane");
            const form = request.method === "POST" ? await readForm(request) : url.searchParams;
            const pane = form.get("pane") ?? "";
            let answer: [number, string];
            if (request.method === "POST" && url.pathname === "/open") {
                answer = await open(form, target);
            } else if (request.method === "GET" && url.pathname === "/dead") {
                answer = PANE.test(pane) && opened.has(pane) ? await dead(pane) : [404, "not a pane this domain opened"];
            } else if (request.method === "POST" && url.pathname === "/kill") {
                answer = PANE.test(pane) && opened.has(pane) ? await kill(pane) : [404, "not a pane this domain opened"];
            } else {
                answer = [404, "no such request"];
            }
            reply(response, answer[0], answer[1]);
        } catch (error) {
            deps.logger.warn({ err: error }, "pane door: a request failed");
            reply(response, 500, "the pane request failed");
        } finally {
            inflight -= 1;
        }
    };

    const server = createServer((request, response) => {
        void handle(request, response);
    });
    // A name nobody else knows, in a directory only the daemon writes; anything at it is an earlier daemon's leftover.
    try {
        await unlink(socket);
    } catch (error) {
        if (errnoCode(error) !== "ENOENT") {
            throw error;
        }
    }
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socket, () => {
            server.off("error", reject);
            resolve();
        });
    });
    await (deps.provision ?? provisionSocket)(socket);
    let closed = false;
    return {
        socket,
        attach: (reference) => {
            namespace = reference;
        },
        close: async () => {
            if (closed) {
                return;
            }
            closed = true;
            namespace = undefined;
            await new Promise<void>((resolve) => {
                server.close(() => resolve());
            });
            await unlink(socket).catch(() => undefined);
        },
    };
};
