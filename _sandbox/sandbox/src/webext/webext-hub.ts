import type { ContractRouterClient } from "@orpc/contract";
import type { WebExtFacts, webextContract, WebExtScopes, WebExtSummary } from "@intentic/sandbox-contract";

/* The live half of the `webext` capability: which of the user's browsers are holding a socket right now, and
 * the typed client for each.
 *
 * The host hub's shape (hosts/host-hub.ts) with one difference that comes straight from what a browser is:
 * FACTS ARE PULLED, NOT REMEMBERED. A machine's OS and shell are true until it reboots into another one, so
 * caching them is honest; a browser's answer includes which sites the person has allowed and how many tabs are
 * open, and both change without this daemon being told — a grant can be revoked in Chrome's own settings. So
 * `describe` is re-asked when a reader wants it (see `facts` below), and what is cached is only the last
 * answer, for the card of a browser that has since been closed.
 *
 * Everything here is in memory, deliberately, for the hub's usual reason: "online" is a fact about a socket,
 * and a socket does not survive a restart. */

export type WebExtClient = ContractRouterClient<typeof webextContract>;

// A browser that goes silent without closing its socket would otherwise hold a tool call open forever. Far
// above any tool's own timeout: the extension bounds its own work (a click that waits on a person still
// answers), so this only ever catches a connection that is gone but not closed.
const CALL_TIMEOUT_MS = 10 * 60 * 1000;

/* Keepalive and liveness. TIGHTER THAN THE HOST HUB'S 30s, and the number is not a taste: an MV3 service
 * worker is killed after 30 seconds of inactivity, and WebSocket traffic is what counts as activity. The
 * extension pings on its own timer too (belt and braces, since its own timer is the one that survives this
 * daemon restarting), but a heartbeat at or above Chrome's own limit would race the browser into shutting the
 * extension down between beats. */
const HEARTBEAT_MS = 20_000;

// How long a card's live `describe` may take before the reader gets the last known answer instead. A browser
// answers in milliseconds when it is there at all, and this read sits behind a page: a person waiting on a
// capability card must not wait out a tool-call timeout because a laptop went to sleep mid-request.
const DESCRIBE_TIMEOUT_MS = 3_000;

interface LiveExtension {
    readonly client: WebExtClient;
    readonly close: (code: number, reason: string) => void;
    readonly heartbeat: NodeJS.Timeout;
    version: string | undefined;
    facts: WebExtFacts | undefined;
    lastSeen: number;
}

export interface WebExtHub {
    /* Take over as THE connection for this browser, closing any socket it left behind (a laptop waking from
     * sleep reconnects long before the old socket's keepalive gives up on it). Returns a detach function for
     * the socket's own close handler; calling it after a newer connection replaced this one does nothing. */
    readonly attach: (id: string, connection: { client: WebExtClient; close: (code: number, reason: string) => void }) => () => void;
    readonly announce: (id: string, version: string) => void;
    readonly observe: (id: string, facts: WebExtFacts) => void;
    /* One MCP message to a browser. Throws when it is offline, with the sentence the agent ends up reading:
     * a closed browser is a normal state, not a fault. */
    readonly mcp: (id: string, payload: unknown, options?: { readonly signal?: AbortSignal }) => Promise<unknown>;
    // Push the grant. False ⇒ nobody to push to; the extension gets it on its next connect instead.
    readonly pushScopes: (id: string, scopes: WebExtScopes) => Promise<boolean>;
    readonly disconnect: (id: string, reason: string) => void;
    /* The last tool list this extension answered with, remembered across disconnects — the host hub's reason
     * exactly: a turn loads its MCP servers up front, and half the time the browser is shut at that moment.
     * With the list cached the agent still SEES the tools and gets a readable "this browser is closed" when it
     * calls one, instead of the whole connection dropping out of the turn. */
    readonly rememberTools: (id: string, result: unknown) => void;
    readonly knownTools: (id: string) => unknown | undefined;
    readonly online: (id: string) => boolean;
    // The card's read: liveness from this hub, and the browser's own facts asked fresh when it is up. Falls
    // back to the last answer on timeout, so a card renders a stale grant list rather than nothing.
    readonly state: (id: string) => Promise<Omit<WebExtSummary, "id" | "platform">>;
}

export const createWebExtHub = (logger: { warn: (data: object, message: string) => void }): WebExtHub => {
    const live = new Map<string, LiveExtension>();
    // What each browser reported last time it was up, kept after it goes offline so the card can say "last
    // seen" and still name the browser instead of going blank the moment someone quits Chrome.
    const seen = new Map<string, { version: string | undefined; facts: WebExtFacts | undefined; lastSeen: number }>();
    const tools = new Map<string, unknown>();

    const drop = (id: string, extension: LiveExtension): void => {
        clearInterval(extension.heartbeat);
        seen.set(id, { version: extension.version, facts: extension.facts, lastSeen: Date.now() });
        live.delete(id);
    };

    return {
        attach: (id, connection) => {
            const previous = live.get(id);
            if (previous !== undefined) {
                clearInterval(previous.heartbeat);
                previous.close(1000, "replaced");
                live.delete(id);
            }
            const remembered = seen.get(id);
            const extension: LiveExtension = {
                client: connection.client,
                close: connection.close,
                heartbeat: setInterval(() => {
                    void connection.client.ping().catch((err: unknown) => {
                        logger.warn({ err, id }, "webext: heartbeat failed, dropping the connection");
                        connection.close(1001, "no answer");
                        const current = live.get(id);
                        if (current?.client === connection.client) {
                            drop(id, current);
                        }
                    });
                }, HEARTBEAT_MS),
                version: remembered?.version,
                facts: remembered?.facts,
                lastSeen: Date.now(),
            };
            live.set(id, extension);
            return () => {
                const current = live.get(id);
                if (current === extension) {
                    drop(id, extension);
                }
            };
        },
        announce: (id, version) => {
            const extension = live.get(id);
            if (extension === undefined) {
                return;
            }
            extension.version = version;
            extension.lastSeen = Date.now();
        },
        observe: (id, facts) => {
            const extension = live.get(id);
            if (extension === undefined) {
                return;
            }
            extension.facts = facts;
            extension.lastSeen = Date.now();
        },
        mcp: async (id, payload, options) => {
            const extension = live.get(id);
            if (extension === undefined) {
                throw new Error(`"${id}" is not connected right now: that browser is closed, or its computer is asleep.`);
            }
            extension.lastSeen = Date.now();
            return await extension.client.mcp(payload, { signal: options?.signal ?? AbortSignal.timeout(CALL_TIMEOUT_MS) });
        },
        pushScopes: async (id, scopes) => {
            const extension = live.get(id);
            if (extension === undefined) {
                return false;
            }
            await extension.client.setScopes(scopes);
            return true;
        },
        rememberTools: (id, result) => void tools.set(id, result),
        knownTools: (id) => tools.get(id),
        disconnect: (id, reason) => {
            const extension = live.get(id);
            if (extension === undefined) {
                return;
            }
            clearInterval(extension.heartbeat);
            extension.close(1000, reason);
            seen.delete(id);
            live.delete(id);
        },
        online: (id) => live.has(id),
        state: async (id) => {
            const extension = live.get(id);
            if (extension !== undefined) {
                // The live read. A failure here is not a failure of the card: the browser may have gone in the
                // millisecond between `live.get` and the call, and the last answer still describes it better
                // than nothing does.
                const fresh = await extension.client.describe(undefined, { signal: AbortSignal.timeout(DESCRIBE_TIMEOUT_MS) }).catch(() => undefined);
                if (fresh !== undefined) {
                    extension.facts = fresh;
                    extension.lastSeen = Date.now();
                }
            }
            const remembered = extension ?? seen.get(id);
            return {
                online: extension !== undefined,
                ...(remembered?.version !== undefined ? { version: remembered.version } : {}),
                ...(remembered?.facts !== undefined ? { facts: remembered.facts } : {}),
                ...(remembered !== undefined ? { lastSeen: remembered.lastSeen } : {}),
            };
        },
    };
};
