import { randomBytes } from "node:crypto";
import { RUNNER_VIEW_PATH, RUNNER_VIEW_TICKET } from "@intentic/sandbox-contract/browser-wire";
import type { Answer } from "@intentic/sandbox-contract/netd-wire";
import { tierAtLeast } from "@intentic/sandbox-contract/schemas/shared";
import type { Caller } from "../../auth/auth.js";
import { opt } from "../../opt.js";
import { conversationReader, registryProvenance } from "../../auth/scope/conversation-reader.js";
import type { PersistedAgent } from "../../conversations/registry/agents-store.js";

/* A PERSON'S VIEW OF A RUNNER, admitted on the parent (2026-11-23). A runner runs without auth, so the parent's netd is
   its only gate: it carries a view down the runner's uplink (netd proxy.rs `runner_view`) only for a path on its allowlist
   and, for a terminal, a browser view or a desktop view, only once this daemon redeemed a ticket it minted here. A ticket
   is one-shot, lives seconds, is bound to one runner, one kind of view and one session, and is minted only for a
   maintainer (a terminal is a shell over the whole runner, as a local one is over the sandbox, terminal-plan.ts) who may
   read the conversation that runner runs. Tickets are their own table, apart from ws-tickets.ts: a local terminal's
   ticket never opens a runner's view, nor the other way round. In memory only; a restart spends them all. */

// Where each view is asked for on the runner, and the query parameter that names its session there.
const VIEWS = {
    terminal: { path: "/system/terminal", session: "session" },
    "browser-view": { path: "/system/browser-view", session: "session" },
    "desktop-view": { path: "/system/desktop-view", session: "window" },
} as const satisfies Record<string, { readonly path: string; readonly session: string }>;

export type RunnerViewKind = keyof typeof VIEWS;
const KINDS: readonly RunnerViewKind[] = ["terminal", "browser-view", "desktop-view"];

// Long enough for a slow tunnel hop, short enough that a leaked ticket is already spent (ws-tickets.ts).
const TICKET_TTL_MS = 30_000;

// netd's name rule for a runner (uplinks.rs `is_name`), and a session as a query can carry it unescaped.
const RUNNER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SESSION = /^[A-Za-z0-9_.:-]{1,128}$/;

export interface RunnerViewDeps {
    // Undefined when this daemon runs without auth: the owner's own tools mint, for no member.
    readonly auth: unknown;
    readonly agents: { readonly entry: (id: string) => PersistedAgent | undefined };
}

export interface RunnerViewRequest {
    readonly identity: Caller | undefined;
    readonly runner: string;
    readonly conversationId: string;
    readonly kind: RunnerViewKind;
    // The tmux session (terminal), the browser session (browser view) or the window (desktop view; "" for the whole
    // desktop) the view opens; the socket's query must name the same.
    readonly session: string;
}

export interface MintedRunnerView {
    readonly ticket: string;
    // The path to open on this sandbox's address, ticket included: `${RUNNER_VIEW_PATH}/<runner>/system/<view>?…`.
    readonly path: string;
}

export class RunnerViewRefused extends Error {
    constructor(message: string) {
        super(message);
        this.name = "RunnerViewRefused";
    }
}

export type RunnerViewAnswer = Extract<Answer, { answer: "runnerView" }>;

export interface RunnerViewTickets {
    // Throws RunnerViewRefused when the caller may not open this view.
    readonly mint: (deps: RunnerViewDeps, request: RunnerViewRequest) => MintedRunnerView;
    // netd's `Question::RunnerView`: the ticket in `query` spent either way, the view admitted only when it matches.
    readonly redeem: (question: { readonly runner: string; readonly path: string; readonly query: string }) => RunnerViewAnswer;
    // Drops outstanding tickets, all or one member's; netd closes open views on the same revocation.
    readonly revoke: (email?: string) => void;
}

interface Held {
    readonly identity: Caller | undefined;
    readonly runner: string;
    readonly kind: RunnerViewKind;
    readonly session: string;
    readonly expiresAt: number;
}

const kindOf = (path: string): RunnerViewKind | undefined => KINDS.find((kind) => VIEWS[kind].path === path);

const refused = (reason: string): RunnerViewAnswer => ({ answer: "runnerView", allowed: false, reason });

// Throws for a request no ticket may be minted for. Pure but for the registry it reads.
const assertMayView = (deps: RunnerViewDeps, { identity, runner, conversationId, kind, session }: RunnerViewRequest): void => {
    if (!RUNNER_ID.test(runner)) {
        throw new RunnerViewRefused(`"${runner}" is not a runner's name`);
    }
    if (!KINDS.includes(kind)) {
        throw new RunnerViewRefused(`"${String(kind)}" is not a view of a runner`);
    }
    if (!(session === "" ? kind === "desktop-view" : SESSION.test(session))) {
        throw new RunnerViewRefused(`"${session}" is not a session a ${kind} can name`);
    }
    if (deps.auth !== undefined && (identity === undefined || !tierAtLeast(identity.tier, "maintainer"))) {
        throw new RunnerViewRefused("a runner's views are opened by a maintainer");
    }
    if (!conversationReader(identity, registryProvenance(deps.agents))(conversationId)) {
        throw new RunnerViewRefused("this conversation is not one you may read");
    }
    const placement = deps.agents.entry(conversationId)?.placement;
    if (placement?.kind !== "worktree" || placement.runner !== runner) {
        throw new RunnerViewRefused(`this conversation does not run on the runner "${runner}"`);
    }
};

export const createRunnerViewTickets = (now: () => number = Date.now): RunnerViewTickets => {
    const tickets = new Map<string, Held>();
    const sweep = (): void => {
        for (const [ticket, held] of tickets) {
            if (held.expiresAt < now()) {
                tickets.delete(ticket);
            }
        }
    };
    return {
        mint: (deps, request) => {
            assertMayView(deps, request);
            sweep();
            const ticket = randomBytes(32).toString("base64url");
            const { identity, runner, kind, session } = request;
            tickets.set(ticket, { identity, runner, kind, session, expiresAt: now() + TICKET_TTL_MS });
            const query = new URLSearchParams(session === "" ? {} : { [VIEWS[kind].session]: session });
            query.set(RUNNER_VIEW_TICKET, ticket);
            return { ticket, path: `${RUNNER_VIEW_PATH}/${runner}${VIEWS[kind].path}?${query.toString()}` };
        },
        redeem: ({ runner, path, query }) => {
            const kind = kindOf(path);
            if (kind === undefined) {
                return refused(`${path} is not a view a ticket opens`);
            }
            const params = new URLSearchParams(query);
            const ticket = params.get(RUNNER_VIEW_TICKET) ?? "";
            const held = tickets.get(ticket);
            // Spent on any hit, whatever follows: a replay finds nothing.
            tickets.delete(ticket);
            if (held === undefined || held.expiresAt < now()) {
                return refused("unknown, spent or expired ticket");
            }
            if (held.runner !== runner || held.kind !== kind || held.session !== (params.get(VIEWS[kind].session) ?? "")) {
                return refused("the ticket was minted for another view");
            }
            if (held.identity !== undefined && !tierAtLeast(held.identity.tier, "maintainer")) {
                return refused("a runner's views are opened by a maintainer");
            }
            return { answer: "runnerView", allowed: true, ...opt("member", held.identity?.email.toLowerCase()) };
        },
        revoke: (email) => {
            const target = email?.toLowerCase();
            for (const [ticket, held] of tickets) {
                if (target === undefined || held.identity?.email.toLowerCase() === target) {
                    tickets.delete(ticket);
                }
            }
        },
    };
};

// This daemon's one table, which netd's questions are answered from (bootstrap/netd-door.ts).
export const runnerViewTickets = createRunnerViewTickets();

// What a route calls to hand a person a runner view: the path to open, ticket included. Throws RunnerViewRefused.
export const mintRunnerViewTicket = (deps: RunnerViewDeps, request: RunnerViewRequest, tickets: RunnerViewTickets = runnerViewTickets): MintedRunnerView =>
    tickets.mint(deps, request);
