import { type WebExtGrant, type WebExtScopes, WebExtScopesSchema } from "@intentic/sandbox-contract";

// Everything this extension remembers, in chrome.storage.local: the sandbox's url+token (the only secret), cached
// scopes, per-site read/act modes, paused (must survive the worker's death), and the activity log. Not here:
// which sites are allowed — that's Chrome's live permission store, never mirrored, so a browser revoke is honored
// immediately.

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

// One line in the popup's activity list; `detail` is already redacted by the caller (audit.ts), so nothing typed
// into a page reaches this file.
export interface ActivityEntry {
    readonly at: number;
    readonly tool: string;
    readonly detail: string;
    readonly ok: boolean;
}

// A site the agent asked for, unanswered; one at a time on purpose, since a request queue is one nobody reads and
// the agent is blocked on the first anyway.
export interface PendingAccess {
    readonly origin: string;
    readonly reason: string;
    readonly at: number;
}

// The last 200 actions: long enough to answer "what did it just do", short enough to never be a browsing-history
// record (tool calls, not pages).
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

    // Defaults come from the contract's own schema, not a second list here, so a switch added there can't be silently
    // absent from enforcement.
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

    // A pairing code the sandbox's page handed over, waiting for the popup to finish it: redeeming needs a host
    // permission, which Chrome only grants from a user gesture, so a page can't connect the browser on its own.
    inbox: async (): Promise<PairedSandbox | undefined> =>
        await read<PairedSandbox | undefined>(KEY_INBOX, undefined, (raw) => {
            const value = raw as Partial<PairedSandbox> | undefined;
            return typeof value?.url === "string" && typeof value.token === "string" ? { url: value.url, token: value.token } : undefined;
        }),
    setInbox: async (pairing: PairedSandbox | undefined): Promise<void> =>
        pairing === undefined ? await chrome.storage.local.remove([KEY_INBOX]) : await chrome.storage.local.set({ [KEY_INBOX]: pairing }),
};
