import { randomBytes } from "node:crypto";
import type { RegisteredClient } from "./mcp-oauth-client.js";
import type { McpSession } from "./mcp-session.js";

// The sign-ins this daemon started and has not yet handed over, in memory only: a restart forgets them, which costs only
// a new press of Sign in. Each is found two ways: by its `state`, which the authorization server sends back with the
// browser and which is spent on its first landing, and by its id, which the form waits on.

// Long enough to read a consent page and sign in to the account first; the authorization server's own code lapses sooner.
const FLOW_TTL_MS = 10 * 60_000;
// More than one form may be signing in; past it the oldest go first, so a caller that loops cannot grow this.
const FLOW_LIMIT = 32;
// How long one wait holds before answering `waiting`, under the request timer and any proxy's idle cut.
const WAIT_HOLD_MS = 25_000;

export type FlowOutcome =
    | { readonly state: "waiting" }
    | { readonly state: "done"; readonly session: McpSession }
    | { readonly state: "failed"; readonly message: string };

export type FlowEnd = Exclude<FlowOutcome, { readonly state: "waiting" }>;

// What a sign-in was started with, and so what its answer is held to.
export interface FlowStart {
    readonly verifier: string;
    readonly issuer: string;
    // The authorization server promised `iss` in every answer (RFC 9207 §2.3), so one without it is refused.
    readonly requireIss: boolean;
    readonly client: RegisteredClient;
    readonly tokenEndpoint: string;
    readonly redirectUri: string;
    readonly resource: string;
    readonly server: string;
}

export interface Flow extends FlowStart {
    readonly id: string;
    readonly state: string;
}

export interface FlowBook {
    readonly open: (start: FlowStart) => Flow;
    // The flow a landing's state names, if it is still waiting; taking it spends the state, so a replayed address finds
    // nothing.
    readonly take: (state: string) => Flow | undefined;
    readonly finish: (flow: Flow, end: FlowEnd) => void;
    // The outcome once it has one; an ended flow is handed over once and forgotten.
    readonly wait: (id: string, signal?: AbortSignal) => Promise<FlowOutcome>;
}

const LAPSED = "This sign-in is no longer waiting: it finished, lapsed after ten minutes, or the sandbox restarted since. Sign in again.";

interface Held {
    readonly flow: Flow;
    readonly expiresAt: number;
    end: FlowEnd | undefined;
    readonly ended: Promise<void>;
    readonly settle: () => void;
}

const holdFlow = (flow: Flow, expiresAt: number): Held => {
    let settle = (): void => {};
    const ended = new Promise<void>((resolve) => {
        settle = resolve;
    });
    return { flow, expiresAt, end: undefined, ended, settle };
};

interface Pause {
    readonly done: Promise<void>;
    readonly cancel: () => void;
}

// Resolves after `ms`, or as soon as the signal aborts.
const pause = (ms: number, signal: AbortSignal | undefined): Pause => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
        signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    return { done, cancel: () => clearTimeout(timer) };
};

export const createFlowBook = (now: () => number = Date.now): FlowBook => {
    const flows = new Map<string, Held>();
    const byState = new Map<string, string>();
    const forget = (held: Held): void => {
        flows.delete(held.flow.id);
        byState.delete(held.flow.state);
        held.settle();
    };
    const prune = (): void => {
        const at = now();
        // Deleting the entry being visited is safe for a Map iterator.
        for (const held of flows.values()) {
            if (held.expiresAt <= at) {
                forget(held);
            }
        }
        // A Map iterates in insertion order, so its first entries are the oldest.
        for (const oldest of [...flows.values()].slice(0, Math.max(0, flows.size - FLOW_LIMIT + 1))) {
            forget(oldest);
        }
    };
    return {
        open: (start) => {
            prune();
            const flow: Flow = { ...start, id: randomBytes(18).toString("base64url"), state: randomBytes(24).toString("base64url") };
            flows.set(flow.id, holdFlow(flow, now() + FLOW_TTL_MS));
            byState.set(flow.state, flow.id);
            return flow;
        },
        take: (state) => {
            prune();
            const id = byState.get(state);
            byState.delete(state);
            const held = id === undefined ? undefined : flows.get(id);
            return held?.end === undefined ? held?.flow : undefined;
        },
        finish: (flow, end) => {
            const held = flows.get(flow.id);
            if (held !== undefined) {
                held.end = end;
                held.settle();
            }
        },
        wait: async (id, signal) => {
            prune();
            const held = flows.get(id);
            if (held === undefined) {
                return { state: "failed", message: LAPSED };
            }
            if (held.end === undefined) {
                const hold = pause(WAIT_HOLD_MS, signal);
                await Promise.race([held.ended, hold.done]);
                hold.cancel();
            }
            if (held.end === undefined) {
                return flows.has(id) ? { state: "waiting" } : { state: "failed", message: LAPSED };
            }
            forget(held);
            return held.end;
        },
    };
};
