import { type WebExtGrant, type WebExtScopes, WebExtScopesSchema } from "@intentic/sandbox-contract";

/* EVERYTHING THIS EXTENSION REMEMBERS, in `chrome.storage.local`, in one place so that "what is on this
 * person's disk because of us" is a list somebody can read rather than a grep.
 *
 * Five things, and each is here for a different reason:
 *   · the SANDBOX it is paired with, url + durable token — the credential, and the only secret held;
 *   · the SCOPES the sandbox last pushed — cached so a browser that starts before its sandbox is reachable
 *     still enforces the grant it was last told about, rather than a default nobody chose;
 *   · the per-site MODES — read or act, this extension's narrowing on top of Chrome's own permission;
 *   · PAUSED — the kill switch, which must survive the service worker being killed, so it cannot live in a
 *     variable;
 *   · the ACTIVITY LOG the popup shows.
 *
 * WHAT IS NOT HERE: which sites are allowed at all. That is Chrome's own permission store, read through
 * `chrome.permissions`, and asking it rather than mirroring it is deliberate — a person who revokes a site in
 * the browser's settings has revoked it, and a mirror would let this extension believe otherwise. */

const KEY_SANDBOX = "sandbox";
const KEY_SCOPES = "scopes";
const KEY_MODES = "modes";
const KEY_PAUSED = "paused";
const KEY_LOG = "log";
const KEY_PENDING = "pending";
const KEY_INBOX = "inbox";

export interface PairedSandbox {
    readonly url: string;
    readonly token: string;
}

// One line in the popup's activity list. `detail` is already redacted by the caller (audit.ts): nothing typed
// into a page reaches this file.
export interface ActivityEntry {
    readonly at: number;
    readonly tool: string;
    readonly detail: string;
    readonly ok: boolean;
}

// A site the agent asked for and the person has not answered yet. One at a time on purpose: a queue of
// permission requests is a queue nobody reads, and the agent is blocked on the first one anyway.
export interface PendingAccess {
    readonly origin: string;
    readonly reason: string;
    readonly at: number;
}

// The last 200 actions. Long enough to answer "what did it just do", short enough that it is never a record of
// somebody's browsing history: it holds tool calls, not pages visited.
const LOG_LIMIT = 200;

const read = async <T>(key: string, fallback: T, parse: (raw: unknown) => T | undefined): Promise<T> => {
    const stored = await chrome.storage.local.get([key]);
    return parse(stored[key]) ?? fallback;
};

export const store = {
    sandbox: async (): Promise<PairedSandbox | undefined> =>
        await read<PairedSandbox | undefined>(KEY_SANDBOX, undefined, (raw) => {
            const value = raw as Partial<PairedSandbox> | undefined;
            return typeof value?.url === "string" && typeof value.token === "string" ? { url: value.url, token: value.token } : undefined;
        }),
    setSandbox: async (sandbox: PairedSandbox): Promise<void> => await chrome.storage.local.set({ [KEY_SANDBOX]: sandbox }),
    forgetSandbox: async (): Promise<void> => await chrome.storage.local.remove([KEY_SANDBOX, KEY_SCOPES]),

    // Defaults come from the contract's own schema rather than a second list here, so a switch added there
    // cannot be silently absent in the browser that has to enforce it.
    scopes: async (): Promise<WebExtScopes> => await read(KEY_SCOPES, WebExtScopesSchema.parse({}), (raw) => WebExtScopesSchema.safeParse(raw).data),
    setScopes: async (scopes: WebExtScopes): Promise<void> => await chrome.storage.local.set({ [KEY_SCOPES]: scopes }),

    modes: async (): Promise<Record<string, WebExtGrant["mode"]>> =>
        await read<Record<string, WebExtGrant["mode"]>>(KEY_MODES, {}, (raw) =>
            typeof raw === "object" && raw !== null ? (raw as Record<string, WebExtGrant["mode"]>) : undefined,
        ),
    setMode: async (origin: string, mode: WebExtGrant["mode"]): Promise<void> => {
        const modes = await store.modes();
        await chrome.storage.local.set({ [KEY_MODES]: { ...modes, [origin]: mode } });
    },
    forgetMode: async (origin: string): Promise<void> => {
        const modes = await store.modes();
        delete modes[origin];
        await chrome.storage.local.set({ [KEY_MODES]: modes });
    },

    paused: async (): Promise<boolean> => await read(KEY_PAUSED, false, (raw) => (typeof raw === "boolean" ? raw : undefined)),
    setPaused: async (paused: boolean): Promise<void> => await chrome.storage.local.set({ [KEY_PAUSED]: paused }),

    log: async (): Promise<ActivityEntry[]> =>
        await read<ActivityEntry[]>(KEY_LOG, [], (raw) => (Array.isArray(raw) ? (raw as ActivityEntry[]) : undefined)),
    append: async (entry: ActivityEntry): Promise<void> => {
        const log = await store.log();
        await chrome.storage.local.set({ [KEY_LOG]: [entry, ...log].slice(0, LOG_LIMIT) });
    },

    pending: async (): Promise<PendingAccess | undefined> =>
        await read<PendingAccess | undefined>(KEY_PENDING, undefined, (raw) => {
            const value = raw as Partial<PendingAccess> | undefined;
            return typeof value?.origin === "string" ? { origin: value.origin, reason: value.reason ?? "", at: value.at ?? 0 } : undefined;
        }),
    setPending: async (pending: PendingAccess | undefined): Promise<void> =>
        pending === undefined ? await chrome.storage.local.remove([KEY_PENDING]) : await chrome.storage.local.set({ [KEY_PENDING]: pending }),

    /* A pairing code the sandbox's own page handed over, waiting for the person to finish it in the popup.
     * It waits rather than being redeemed on arrival because redeeming needs a `fetch` to the sandbox, which
     * needs a host permission for it, which Chrome only grants from a user gesture in an extension page. So
     * the page's handoff saves the copy-paste and the popup still owns the decision — which is the right place
     * for it anyway: a page should not be able to connect somebody's browser to a sandbox on its own. */
    inbox: async (): Promise<PairedSandbox | undefined> =>
        await read<PairedSandbox | undefined>(KEY_INBOX, undefined, (raw) => {
            const value = raw as Partial<PairedSandbox> | undefined;
            return typeof value?.url === "string" && typeof value.token === "string" ? { url: value.url, token: value.token } : undefined;
        }),
    setInbox: async (pairing: PairedSandbox | undefined): Promise<void> =>
        pairing === undefined ? await chrome.storage.local.remove([KEY_INBOX]) : await chrome.storage.local.set({ [KEY_INBOX]: pairing }),
};
