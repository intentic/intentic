import { existsSync } from "node:fs";
import type { Answer, TerminalPlan } from "@intentic/sandbox-contract/front-wire";
import { AGENT_SESSION_PREFIX, JOB_SESSION_PREFIX, PANEL_SESSION_PREFIX } from "@intentic/sandbox-contract/session-names";
import { redeemTicket, type WsTickets } from "../auth/tokens/ws-tickets.js";
import { resolveWithin } from "../workspace/files/workspace-files-paths.js";
import { isValidSessionName, SERVICE_SESSION_PREFIX } from "./terminal-session.js";

// A terminal socket is the front's (_sandbox/front, term/): it asks here, once per socket, whether the socket may open
// and onto what, and none of its bytes ever pass through this process.

export interface TerminalPlanDeps {
    // Undefined when the daemon runs without auth: every socket opens, for no member.
    readonly auth: unknown;
    readonly wsTickets: WsTickets;
    readonly root: string;
    readonly logPathOf: (key: string) => string | undefined;
    readonly warn: (fields: object, message: string) => void;
}

export type TerminalAnswer = Extract<Answer, { answer: "terminal" }>;

// `-A` lets one call both create a tab and reattach an existing one; `-c <dir>` sets the cwd only on creation. Panel,
// agent and job sessions are attach-only: a missing one fails honestly, not as a bare shell in its place.
const tmuxArgv = (session: string, dir: string): string[] =>
    [PANEL_SESSION_PREFIX, AGENT_SESSION_PREFIX, JOB_SESSION_PREFIX].some((prefix) => session.startsWith(prefix))
        ? ["attach-session", "-t", `=${session}`]
        : ["new-session", "-A", "-s", session, "-c", dir];

// `cwd` is workspace-relative; one that escapes the workspace or does not exist opens at the root instead.
const directoryOf = (root: string, cwd: string | null): string => {
    const requested = cwd === null || cwd === "" ? undefined : resolveWithin(root, cwd);
    return requested !== undefined && existsSync(requested) ? requested : root;
};

// A `svc-<key>` session is no tmux session: it is its service's log, followed from the first line.
const planOf = (deps: TerminalPlanDeps, session: string, cwd: string | null): TerminalPlan => {
    if (session.startsWith(SERVICE_SESSION_PREFIX)) {
        const path = deps.logPathOf(session.slice(SERVICE_SESSION_PREFIX.length));
        return path === undefined ? { plan: "exit", code: 0, reason: "no such service" } : { plan: "tail", path };
    }
    return { plan: "tmux", session, argv: tmuxArgv(session, directoryOf(deps.root, cwd)) };
};

export const planTerminal = (deps: TerminalPlanDeps, query: string): TerminalAnswer => {
    const params = new URLSearchParams(query);
    let member: string | undefined;
    try {
        // A terminal is a shell over the whole sandbox: the ship-and-operate tier, not the driving one.
        member = redeemTicket(deps, params, "maintainer")?.email.toLowerCase();
    } catch (err) {
        // The close frame says only "unauthorized"; whether the ticket was unknown, spent or expired is logged here.
        deps.warn({ err }, "terminal ticket rejected");
        return { answer: "terminal", plan: { plan: "refused", code: 1008, reason: "unauthorized" } };
    }
    const session = params.get("session") ?? "";
    // The name reaches a tmux argv: checked, so a name like `-C` is never read as a flag.
    const plan: TerminalPlan = isValidSessionName(session)
        ? planOf(deps, session, params.get("cwd"))
        : { plan: "refused", code: 1008, reason: "invalid session" };
    return { answer: "terminal", plan, ...(member === undefined ? {} : { member }) };
};
