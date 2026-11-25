import { createHash } from "node:crypto";

// How many credentialed calls the daemon carries at once for a connected card, and the open ones it cuts when the card
// stops being theirs to spend. Two doors forward an agent's request with a credential the agent never holds: the
// credential gateway (broker/broker-gateway.ts) and a signed-in MCP server's door (mcp-oauth/mcp-remote.ts). Each counts
// its calls from arrival, per conversation and for the whole door, in two pools so idle event streams (an MCP server's
// GET, a service's server-sent events) never starve ordinary calls. And each sweeps its open calls: one whose card was
// removed, whose credential was replaced, or that the conversation's reach no longer covers is aborted, its upstream
// request and its stream with it, within one sweep.

export type CallPool = "call" | "stream";

export interface CallLimits {
    readonly perConversation: number;
    readonly perDoor: number;
}

// A call holds at most a request body in memory (mcp-remote.ts caps it) and a socket; a stream holds a socket for as
// long as its client keeps it. Raise these only with that in mind.
const CALL_LIMITS = {
    call: { perConversation: 32, perDoor: 256 },
    stream: { perConversation: 8, perDoor: 64 },
} as const satisfies Readonly<Record<CallPool, CallLimits>>;

// How often open calls are checked against their card and the conversation's reach.
const SWEEP_EVERY_MS = 10_000;

/** What one open call was admitted for: re-checked on every sweep. */
export interface OpenCall {
    // The capability id whose credential the call carries.
    readonly subject: string;
    readonly conversationId: string | undefined;
    readonly pool: CallPool;
    // The credential as it was when the call was admitted (credentialPrint), so a replaced one is told apart.
    readonly print: string;
}

export interface AdmittedCall {
    // Aborted when the call is cut; the forwarded request and the answer's stream take it.
    readonly signal: AbortSignal;
    // The answer, its slot held until its body is read to the end, cancelled or cut.
    readonly hold: (response: Response) => Response;
    // Frees the slot of a call that ends without an answer to hold.
    readonly release: () => void;
}

export interface OpenCalls {
    /** The call's slot, or undefined when its conversation or the door already carries as many of its kind as it may. */
    readonly admit: (call: OpenCall, signal: AbortSignal) => AdmittedCall | undefined;
    /** Aborts every open call `matches` picks; their slots free as they unwind. */
    readonly cut: (matches: (call: OpenCall) => boolean, reason: string) => number;
    readonly size: (pool: CallPool) => number;
    /** Checks every open call with `stillValid` now; what fails it is cut. */
    readonly sweep: (stillValid: (call: OpenCall) => Promise<string | undefined>) => Promise<number>;
    /** Sweeps every `everyMs` while anything is open; the returned stop ends it. */
    readonly watch: (stillValid: (call: OpenCall) => Promise<string | undefined>, everyMs?: number) => () => void;
}

/** A credential's fingerprint: equal while the same credential is in place, never the credential itself. */
export const credentialPrint = (parts: readonly (string | undefined)[]): string => createHash("sha256").update(JSON.stringify(parts)).digest("base64url");

/** Why a call was cut, as the client reads it on the stream it was reading. */
export class CallCut extends Error {}

interface Slot {
    readonly call: OpenCall;
    readonly abort: AbortController;
    released: boolean;
}

// The answer's body, passed through as it is read; reading to its end, cancelling or erroring frees the slot.
const heldBody = (body: ReadableStream<Uint8Array>, signal: AbortSignal, release: () => void): ReadableStream<Uint8Array> => {
    const reader = body.getReader();
    const onCut = (): void => {
        // allow(silent-catch): the stream is being torn down for the cut; a cancel that fails has nothing left to stop
        void reader.cancel(signal.reason).catch(() => undefined);
    };
    signal.addEventListener("abort", onCut, { once: true });
    const done = (): void => {
        signal.removeEventListener("abort", onCut);
        release();
    };
    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            try {
                const { done: ended, value } = await reader.read();
                if (ended) {
                    done();
                    // A stream cut short ends in its reason, so the client reads a cut apart from a finished answer.
                    if (signal.aborted) {
                        controller.error(signal.reason);
                    } else {
                        controller.close();
                    }
                    return;
                }
                controller.enqueue(value);
            } catch (error) {
                done();
                controller.error(signal.aborted ? signal.reason : error);
            }
        },
        async cancel(reason) {
            done();
            await reader.cancel(reason);
        },
    });
};

export const createOpenCalls = (limits: Readonly<Record<CallPool, CallLimits>> = CALL_LIMITS): OpenCalls => {
    const open = new Set<Slot>();
    const count = (pool: CallPool, conversationId?: string): number =>
        [...open].filter((slot) => slot.call.pool === pool && (conversationId === undefined || slot.call.conversationId === conversationId)).length;

    const admit = (call: OpenCall, signal: AbortSignal): AdmittedCall | undefined => {
        const limit = limits[call.pool];
        // A call no conversation speaks for (a peer's, a suite's) counts against the door alone.
        const forConversation = call.conversationId === undefined ? 0 : count(call.pool, call.conversationId);
        if (forConversation >= limit.perConversation || count(call.pool) >= limit.perDoor) {
            return undefined;
        }
        const slot: Slot = { call, abort: new AbortController(), released: false };
        open.add(slot);
        const release = (): void => {
            if (!slot.released) {
                slot.released = true;
                open.delete(slot);
            }
        };
        const both = AbortSignal.any([signal, slot.abort.signal]);
        return {
            signal: both,
            release,
            hold: (response) => {
                if (response.body === null) {
                    release();
                    return response;
                }
                return new Response(heldBody(response.body, both, release), { status: response.status, statusText: response.statusText, headers: response.headers });
            },
        };
    };

    const cut = (matches: (call: OpenCall) => boolean, reason: string): number => {
        let cutCount = 0;
        for (const slot of open) {
            if (!slot.abort.signal.aborted && matches(slot.call)) {
                slot.abort.abort(new CallCut(reason));
                cutCount += 1;
            }
        }
        return cutCount;
    };

    const sweep = async (stillValid: (call: OpenCall) => Promise<string | undefined>): Promise<number> => {
        let cutCount = 0;
        // A copy: a call that ends while its check is awaited leaves the set mid-iteration.
        for (const slot of Array.from(open)) {
            if (slot.abort.signal.aborted) {
                continue;
            }
            // allow(silent-catch): a check that cannot be answered cuts nothing; the next sweep asks again
            const why = await stillValid(slot.call).catch(() => undefined);
            if (why !== undefined) {
                slot.abort.abort(new CallCut(why));
                cutCount += 1;
            }
        }
        return cutCount;
    };

    const watch = (stillValid: (call: OpenCall) => Promise<string | undefined>, everyMs = SWEEP_EVERY_MS): (() => void) => {
        let running = false;
        const timer = setInterval(() => {
            if (running || open.size === 0) {
                return;
            }
            running = true;
            void sweep(stillValid).finally(() => {
                running = false;
            });
        }, everyMs);
        timer.unref();
        return () => clearInterval(timer);
    };

    return { admit, cut, size: (pool) => count(pool), sweep, watch };
};
