import { type WebExtGrant, type WebExtScopes, WebExtScopesSchema } from "@intentic/sandbox-contract/webext";
// Named imports, as in mcp.ts: the `z` namespace would keep zod's locales in the bundle.
import { enum as zEnum, number, object, string } from "zod";
import { approvalCovers, type KeptApproval } from "./policy.js";

// Everything this extension remembers, in chrome.storage.local: the sandbox's url+token (the only secret), cached
// scopes, per-site read/act modes, paused (must survive the worker's death), the activity log, recent declines and
// the person's own settings. Not here:
// which sites are allowed — that's Chrome's live permission store, never mirrored, so a browser revoke is honored
// immediately.

const KEY_SANDBOX = "sandbox";
const KEY_SCOPES = "scopes";
const KEY_MODES = "modes";
const KEY_PAUSED = "paused";
const KEY_LOG = "log";
const KEY_PENDING = "pending";
const KEY_CHOICE = "choice";
const KEY_INBOX = "inbox";
const KEY_DECLINED = "declined";
const KEY_SETTINGS = "settings";
const KEY_PROMPTED = "prompted";
const KEY_APPROVAL = "approval";
const KEY_PASSWORDS = "passwordsOn";
const KEY_NEVER_SAVE = "passwordsNeverHosts";

const KeptApprovalSchema = object({ tabId: number(), url: string(), what: string(), at: number() });
const SiteChoiceSchema = object({ origin: string(), mode: zEnum(["read", "act"]), at: number() });

export interface PairedSandbox {
    readonly url: string;
    readonly token: string;
}

// One line in the popup's activity list; `detail` is already redacted by the caller (audit.ts), so nothing typed
// into a page reaches this file. `detail` is a sentence a person reads ("Typed 86 characters"), `note` the reason a
// call failed. Entries written before that split hold the call's JSON in `detail` and no note.
export interface ActivityEntry {
    readonly at: number;
    readonly tool: string;
    readonly detail: string;
    readonly ok: boolean;
    readonly note?: string;
}

// The person's own preferences for this extension, as opposed to anything a sandbox decides.
export interface Settings {
    // Open the popup by itself when the agent asks for a site, instead of leaving only a badge.
    readonly openOnAsk: boolean;
}

const DEFAULT_SETTINGS: Settings = { openOnAsk: true };

// How long a "no" holds: long enough that an agent can't re-ask in a loop, short enough that a new task on the same
// site is not refused by a decision about an old one.
export const DECLINE_HOLD_MS = 15 * 60_000;

// A site the agent asked for, unanswered; one at a time on purpose, since a request queue is one nobody reads and
// the agent is blocked on the first anyway.
export interface PendingAccess {
    readonly origin: string;
    readonly reason: string;
    readonly at: number;
}

// The mode the person picked in the popup for a site Chrome is being asked for, kept until Chrome's grant lands
// (site-grants.ts), since the popup that picked it is closed by the time that happens.
export interface SiteChoice {
    readonly origin: string;
    readonly mode: WebExtGrant["mode"];
    readonly at: number;
}

// How long a pick waits for Chrome's grant: the dialog is answered in seconds, and a pick whose dialog was turned down
// should not be filed by a grant the person makes much later, some other way.
export const CHOICE_HOLD_MS = 5 * 60_000;

// The last 200 actions: long enough to answer "what did it just do", short enough to never be a browsing-history
// record (tool calls, not pages).
const LOG_LIMIT = 200;

const read = async <T>(key: string, fallback: T, parse: (raw: unknown) => T | undefined): Promise<T> => {
    const stored = await chrome.storage.local.get([key]);
    return parse(stored[key]) ?? fallback;
};

// Every switch off and every action asked: a stored grant that no longer parses holds a choice the owner made, which
// the defaults may be wider than. The sandbox's next push replaces it.
const LOCKED_SCOPES: WebExtScopes = { read: "off", act: "off", screenshot: "off", cookies: "off", confirm: "always" };

export const store = {
    sandbox: async (): Promise<PairedSandbox | undefined> =>
        await read<PairedSandbox | undefined>(KEY_SANDBOX, undefined, (raw) => {
            const value = raw as Partial<PairedSandbox> | undefined;
            return typeof value?.url === "string" && typeof value.token === "string" ? { url: value.url, token: value.token } : undefined;
        }),
    setSandbox: async (sandbox: PairedSandbox): Promise<void> => await chrome.storage.local.set({ [KEY_SANDBOX]: sandbox }),
    forgetSandbox: async (): Promise<void> => await chrome.storage.local.remove([KEY_SANDBOX, KEY_SCOPES]),

    // Defaults come from the contract's own schema, not a second list here, so a switch added there can't be silently
    // absent from enforcement. They answer only for nothing stored; a stored grant that does not parse is locked.
    scopes: async (): Promise<WebExtScopes> => {
        const raw: unknown = (await chrome.storage.local.get([KEY_SCOPES]))[KEY_SCOPES];
        if (raw === undefined) {
            return WebExtScopesSchema.parse({});
        }
        const parsed = WebExtScopesSchema.safeParse(raw);
        if (!parsed.success) {
            console.warn("intentic: the stored permissions do not parse, so every switch is off until the sandbox sends them again", parsed.error);
            return LOCKED_SCOPES;
        }
        return parsed.data;
    },
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

    // The owner's kill switch: only nothing stored is running, and a stored value that is not a boolean holds as paused.
    paused: async (): Promise<boolean> => await read(KEY_PAUSED, false, (raw) => (typeof raw === "boolean" || raw === undefined ? raw : true)),
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

    // One pick at a time, like the request it usually answers; a newer one replaces it.
    setChoice: async (choice: SiteChoice): Promise<void> => await chrome.storage.local.set({ [KEY_CHOICE]: choice }),
    // Spends the pick if it is for `origin` and still fresh; one for another site is left for its own grant.
    takeChoice: async (origin: string, now: number): Promise<SiteChoice | undefined> => {
        const choice = await read<SiteChoice | undefined>(KEY_CHOICE, undefined, (raw) => {
            const parsed = SiteChoiceSchema.safeParse(raw);
            return parsed.success ? parsed.data : undefined;
        });
        if (choice?.origin !== origin) {
            return undefined;
        }
        await chrome.storage.local.remove([KEY_CHOICE]);
        return now >= choice.at && now - choice.at < CHOICE_HOLD_MS ? choice : undefined;
    },

    // A pairing code the sandbox's page handed over, waiting for the popup to finish it: redeeming needs a host
    // permission, which Chrome only grants from a user gesture, so a page can't connect the browser on its own.
    inbox: async (): Promise<PairedSandbox | undefined> =>
        await read<PairedSandbox | undefined>(KEY_INBOX, undefined, (raw) => {
            const value = raw as Partial<PairedSandbox> | undefined;
            return typeof value?.url === "string" && typeof value.token === "string" ? { url: value.url, token: value.token } : undefined;
        }),
    setInbox: async (pairing: PairedSandbox | undefined): Promise<void> =>
        pairing === undefined ? await chrome.storage.local.remove([KEY_INBOX]) : await chrome.storage.local.set({ [KEY_INBOX]: pairing }),

    // Sites the person declined, with when; entries past DECLINE_HOLD_MS are dropped on every write.
    declined: async (): Promise<Record<string, number>> =>
        await read<Record<string, number>>(KEY_DECLINED, {}, (raw) =>
            typeof raw === "object" && raw !== null ? (raw as Record<string, number>) : undefined,
        ),
    decline: async (origin: string, at: number): Promise<void> => {
        const kept = Object.entries(await store.declined()).filter(([, when]) => at - when < DECLINE_HOLD_MS);
        await chrome.storage.local.set({ [KEY_DECLINED]: { ...Object.fromEntries(kept), [origin]: at } });
    },
    forgetDecline: async (origin: string): Promise<void> => {
        const declined = await store.declined();
        if (origin in declined) {
            delete declined[origin];
            await chrome.storage.local.set({ [KEY_DECLINED]: declined });
        }
    },

    settings: async (): Promise<Settings> =>
        await read<Settings>(KEY_SETTINGS, DEFAULT_SETTINGS, (raw) => {
            const value = raw as Partial<Settings> | undefined;
            return typeof value === "object" && value !== null ? { ...DEFAULT_SETTINGS, ...value } : undefined;
        }),
    setSettings: async (settings: Settings): Promise<void> => await chrome.storage.local.set({ [KEY_SETTINGS]: settings }),

    // When the popup last opened itself; kept in storage because the worker that opened it may not live to the next ask.
    promptedAt: async (): Promise<number> => await read(KEY_PROMPTED, 0, (raw) => (typeof raw === "number" ? raw : undefined)),
    setPromptedAt: async (at: number): Promise<void> => await chrome.storage.local.set({ [KEY_PROMPTED]: at }),

    // One kept yes (policy.ts KeptApproval), in storage since the worker that kept it may not be the one the retry
    // reaches. One at a time: it is for the retry of the action that just failed, not a stock of answers.
    keepApproval: async (approval: KeptApproval): Promise<void> => await chrome.storage.local.set({ [KEY_APPROVAL]: approval }),
    // Spends the kept yes if it answers `wanted`; one that doesn't is left for its own retry until it expires.
    passwordsEnabled: async (): Promise<boolean> =>
        await read(KEY_PASSWORDS, false, (raw) => (typeof raw === "boolean" ? raw : undefined)),
    setPasswordsEnabled: async (on: boolean): Promise<void> =>
        on ? await chrome.storage.local.set({ [KEY_PASSWORDS]: true }) : await chrome.storage.local.remove([KEY_PASSWORDS]),

    neverSaveHosts: async (): Promise<string[]> =>
        await read<string[]>(KEY_NEVER_SAVE, [], (raw) => (Array.isArray(raw) ? raw.filter((h) => typeof h === "string") : undefined)),
    setNeverSaveHosts: async (hosts: string[]): Promise<void> => await chrome.storage.local.set({ [KEY_NEVER_SAVE]: hosts }),

    takeApproval: async (wanted: Omit<KeptApproval, "at">, now: number): Promise<boolean> => {
        const kept = await read<KeptApproval | undefined>(KEY_APPROVAL, undefined, (raw) => {
            const parsed = KeptApprovalSchema.safeParse(raw);
            return parsed.success ? parsed.data : undefined;
        });
        if (!approvalCovers(kept, wanted, now)) {
            return false;
        }
        await chrome.storage.local.remove([KEY_APPROVAL]);
        return true;
    },
};
