import { type WebExtGrant, type WebExtScopes, WebExtScopesSchema } from "@intentic/sandbox-contract/webext";
// Named imports, as in mcp.ts: the `z` namespace would keep zod's locales in the bundle.
import { enum as zEnum, number, object, string } from "zod";
import { approvalCovers, type KeptApproval } from "./policy.js";
import { DEFAULT_SETTINGS, type Settings } from "./settings.js";

export { DEFAULT_SETTINGS, type Settings } from "./settings.js";

// Everything this extension remembers, in chrome.storage.local: every paired sandbox's url+token (the only secrets),
// each one's cached scopes, per-site read/act modes, paused (must survive the worker's death), the activity log, the
// sites each sandbox's agent is waiting on, recent declines, the person's own settings and where they put the agent's
// window. In chrome.storage.session, which the browser clears when it quits: each agent window's id (ids start over in
// the next run, so a kept one could name a window of theirs) and the questions the agents are waiting on. Not here:
// which sites are allowed — that's Chrome's live permission store, never mirrored, so a browser revoke is honored
// immediately.
//
// Several sandboxes at once (2026-10-28). Until then this file held ONE sandbox, and pairing a second overwrote the
// first. What a sandbox decides is now kept per sandbox: its token, the switches its card pushes, its agent's window,
// the site its agent asked for, the question its agent is asking. What the person decides about their browser is kept
// once for all of them: the allowed sites and their modes, pause, declines, settings.

const KEY_SANDBOXES = "sandboxes";
// Per sandbox, under `scopes:<sandbox>`: one key each, so two sandboxes pushing their switches at once never write
// over each other.
const KEY_SCOPES_OF = "scopes:";
const KEY_MODES = "modes";
const KEY_PAUSED = "paused";
const KEY_LOG = "log";
const KEY_REQUESTS = "requests";
const KEY_CHOICE = "choice";
const KEY_INBOX = "inbox";
const KEY_DECLINED = "declined";
const KEY_SETTINGS = "settings";
const KEY_PROMPTED = "prompted";
const KEY_APPROVAL = "approval";
const KEY_PASSWORDS = "passwordsOn";
const KEY_NEVER_SAVE = "passwordsNeverHosts";
const KEY_AGENT_WINDOWS = "agentWindows";
const KEY_AGENT_BOUNDS = "agentWindowBounds";
const KEY_ASKING = "asking";
// What a build before 2026-10-28 kept for its one sandbox, moved once by `migrate`.
const LEGACY_SANDBOX = "sandbox";
const LEGACY_SCOPES = "scopes";
const LEGACY_PENDING = "pending";

const KeptApprovalSchema = object({ tabId: number(), url: string(), what: string(), at: number() });
const SiteChoiceSchema = object({ origin: string(), mode: zEnum(["read", "act"]), at: number() });
const WindowIdSchema = number().int();
const BoundsSchema = object({ left: number(), top: number(), width: number(), height: number() });
const AskingSchema = object({ id: string(), sandbox: string(), tabId: number(), origin: string(), question: string(), at: number() });
const PendingSchema = object({ sandbox: string(), origin: string(), reason: string(), at: number() });

// Which paired sandbox something belongs to: its URL without a trailing slash, so a code that carries one and a code
// that does not name the same sandbox.
export type SandboxKey = string;
export const sandboxKey = (url: string): SandboxKey => url.replace(/\/+$/, "");

export interface PairedSandbox {
    readonly url: string;
    readonly token: string;
    // What the sandbox is called, from its pairing code: absent from codes made before 2026-10-28, which are named by
    // their host instead (sandboxName).
    readonly name?: string;
}

// What the popup and the activity list call a sandbox.
export const sandboxName = (sandbox: Pick<PairedSandbox, "url" | "name">): string => {
    if (sandbox.name !== undefined && sandbox.name !== "") {
        return sandbox.name;
    }
    try {
        return new URL(sandbox.url).host;
    } catch {
        return sandbox.url;
    }
};

const pairedOf = (raw: unknown): PairedSandbox | undefined => {
    const value = raw as Partial<PairedSandbox> | undefined;
    if (typeof value?.url !== "string" || typeof value.token !== "string") {
        return undefined;
    }
    return typeof value.name === "string" && value.name !== ""
        ? { url: value.url, token: value.token, name: value.name }
        : { url: value.url, token: value.token };
};

// One line in the popup's activity list; `detail` is already redacted by the caller (audit.ts), so nothing typed
// into a page reaches this file. `detail` is a sentence a person reads ("Typed 86 characters"), `note` the reason a
// call failed. Entries written before that split hold the call's JSON in `detail` and no note.
export interface ActivityEntry {
    readonly at: number;
    readonly tool: string;
    readonly detail: string;
    readonly ok: boolean;
    readonly note?: string;
    // The sandbox whose agent made the call, or whose link it was; absent for what the person did, and from entries
    // written before several sandboxes could be paired.
    readonly sandbox?: SandboxKey;
}


// Where the person last put the agent's window, so the next one opens there (agent-window.ts).
export interface WindowBounds {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
}

// The question the agent is waiting on the person for (asking.ts): shown in the popup, which can answer it, while the
// page it is about may be in a window they cannot see.
export interface Asking {
    readonly id: string;
    // The sandbox whose agent is asking.
    readonly sandbox: SandboxKey;
    readonly tabId: number;
    // The page's site as a match pattern (policy.ts originPattern), what the popup names and shows the icon of.
    readonly origin: string;
    readonly question: string;
    readonly at: number;
}

// How long a "no" holds: long enough that an agent can't re-ask in a loop, short enough that a new task on the same
// site is not refused by a decision about an old one.
export const DECLINE_HOLD_MS = 15 * 60_000;

// A site an agent asked for, unanswered; one per sandbox, since a queue is one nobody reads and each agent is blocked on
// its first request anyway. A sandbox's newer request replaces its older one, never another sandbox's.
export interface PendingAccess {
    readonly sandbox: SandboxKey;
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

// Read-modify-writes, one at a time. Several sandboxes call at once (two agents appending to the log, two links pushing
// at startup), and chrome.storage has no transactions: two interleaved writes of the same key keep only the later. The
// worker is one thread, so a queue here is enough. Nothing run under it may call something else that takes it.
let queue: Promise<unknown> = Promise.resolve();
const locked = async <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next;
    return await next;
};

const readSandboxes = async (): Promise<PairedSandbox[]> =>
    await read<PairedSandbox[]>(KEY_SANDBOXES, [], (raw) =>
        Array.isArray(raw) ? raw.map(pairedOf).filter((paired): paired is PairedSandbox => paired !== undefined) : undefined,
    );

const readRequests = async (): Promise<PendingAccess[]> =>
    await read<PendingAccess[]>(KEY_REQUESTS, [], (raw) =>
        Array.isArray(raw) ? raw.flatMap((each) => {
            const parsed = PendingSchema.safeParse(each);
            return parsed.success ? [parsed.data] : [];
        }) : undefined,
    );

const readAsking = async (): Promise<Asking[]> => {
    const raw: unknown = (await chrome.storage.session.get([KEY_ASKING]))[KEY_ASKING];
    return Array.isArray(raw) ? raw.flatMap((each) => {
        const parsed = AskingSchema.safeParse(each);
        return parsed.success ? [parsed.data] : [];
    }) : [];
};

const readAgentWindows = async (): Promise<Record<SandboxKey, number>> => {
    const raw: unknown = (await chrome.storage.session.get([KEY_AGENT_WINDOWS]))[KEY_AGENT_WINDOWS];
    if (typeof raw !== "object" || raw === null) {
        return {};
    }
    return Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, number] => WindowIdSchema.safeParse(entry[1]).success));
};

// Every switch off and every action asked: a stored grant that no longer parses holds a choice the owner made, which
// the defaults may be wider than. The sandbox's next push replaces it.
const LOCKED_SCOPES: WebExtScopes = { read: "off", act: "off", screenshot: "off", cookies: "off", confirm: "always" };

export const store = {
    // Moves what a build before 2026-10-28 kept for its one sandbox into the list, once, on the worker's start: its
    // pairing becomes the first entry and its switches that entry's. The site it had asked for is dropped, since the
    // call that asked went with the old worker.
    migrate: async (): Promise<void> =>
        await locked(async () => {
            const stored = await chrome.storage.local.get([LEGACY_SANDBOX, LEGACY_SCOPES, LEGACY_PENDING, KEY_SANDBOXES]);
            const legacy = pairedOf(stored[LEGACY_SANDBOX]);
            if (legacy !== undefined && !Array.isArray(stored[KEY_SANDBOXES])) {
                await chrome.storage.local.set({
                    [KEY_SANDBOXES]: [legacy],
                    ...(stored[LEGACY_SCOPES] === undefined ? {} : { [`${KEY_SCOPES_OF}${sandboxKey(legacy.url)}`]: stored[LEGACY_SCOPES] }),
                });
            }
            if (LEGACY_SANDBOX in stored || LEGACY_SCOPES in stored || LEGACY_PENDING in stored) {
                await chrome.storage.local.remove([LEGACY_SANDBOX, LEGACY_SCOPES, LEGACY_PENDING]);
            }
        }),

    // Every paired sandbox, in the order they were paired.
    sandboxes: async (): Promise<PairedSandbox[]> => await readSandboxes(),
    sandbox: async (key: SandboxKey): Promise<PairedSandbox | undefined> =>
        (await readSandboxes()).find((paired) => sandboxKey(paired.url) === sandboxKey(key)),
    // Pairing a sandbox that is already paired replaces its token and keeps its place; any other is added after the rest.
    addSandbox: async (sandbox: PairedSandbox): Promise<void> =>
        await locked(async () => {
            const key = sandboxKey(sandbox.url);
            const list = await readSandboxes();
            const at = list.findIndex((paired) => sandboxKey(paired.url) === key);
            const next = at === -1 ? [...list, sandbox] : list.map((paired, index) => (index === at ? sandbox : paired));
            await chrome.storage.local.set({ [KEY_SANDBOXES]: next });
        }),
    // Forgets one sandbox: its token, its switches, the site its agent asked for, its window. The others are untouched.
    forgetSandbox: async (key: SandboxKey): Promise<void> =>
        await locked(async () => {
            const forgotten = sandboxKey(key);
            const list = await readSandboxes();
            await chrome.storage.local.set({
                [KEY_SANDBOXES]: list.filter((paired) => sandboxKey(paired.url) !== forgotten),
                [KEY_REQUESTS]: (await readRequests()).filter((request) => request.sandbox !== forgotten),
            });
            await chrome.storage.local.remove([`${KEY_SCOPES_OF}${forgotten}`]);
            const windows = await readAgentWindows();
            delete windows[forgotten];
            await chrome.storage.session.set({ [KEY_AGENT_WINDOWS]: windows });
        }),

    // One sandbox's switches, as its card last pushed them. Defaults come from the contract's own schema, not a second
    // list here, so a switch added there can't be silently absent from enforcement. They answer only for nothing
    // stored; a stored grant that does not parse is locked.
    scopes: async (key: SandboxKey): Promise<WebExtScopes> => {
        const name = `${KEY_SCOPES_OF}${sandboxKey(key)}`;
        const raw: unknown = (await chrome.storage.local.get([name]))[name];
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
    setScopes: async (key: SandboxKey, scopes: WebExtScopes): Promise<void> =>
        await chrome.storage.local.set({ [`${KEY_SCOPES_OF}${sandboxKey(key)}`]: scopes }),

    modes: async (): Promise<Record<string, WebExtGrant["mode"]>> =>
        await read<Record<string, WebExtGrant["mode"]>>(KEY_MODES, {}, (raw) =>
            typeof raw === "object" && raw !== null ? (raw as Record<string, WebExtGrant["mode"]>) : undefined,
        ),
    setMode: async (origin: string, mode: WebExtGrant["mode"]): Promise<void> =>
        await locked(async () => {
            const modes = await store.modes();
            await chrome.storage.local.set({ [KEY_MODES]: { ...modes, [origin]: mode } });
        }),
    forgetMode: async (origin: string): Promise<void> =>
        await locked(async () => {
            const modes = await store.modes();
            delete modes[origin];
            await chrome.storage.local.set({ [KEY_MODES]: modes });
        }),

    // The owner's kill switch: only nothing stored is running, and a stored value that is not a boolean holds as paused.
    paused: async (): Promise<boolean> => await read(KEY_PAUSED, false, (raw) => (typeof raw === "boolean" || raw === undefined ? raw : true)),
    setPaused: async (paused: boolean): Promise<void> => await chrome.storage.local.set({ [KEY_PAUSED]: paused }),

    log: async (): Promise<ActivityEntry[]> =>
        await read<ActivityEntry[]>(KEY_LOG, [], (raw) => (Array.isArray(raw) ? (raw as ActivityEntry[]) : undefined)),
    append: async (entry: ActivityEntry): Promise<void> =>
        await locked(async () => {
            const log = await store.log();
            await chrome.storage.local.set({ [KEY_LOG]: [entry, ...log].slice(0, LOG_LIMIT) });
        }),

    // Every site an agent is waiting on, oldest first, at most one per sandbox.
    pending: async (): Promise<PendingAccess[]> => await readRequests(),
    pendingFor: async (key: SandboxKey): Promise<PendingAccess | undefined> =>
        (await readRequests()).find((request) => request.sandbox === sandboxKey(key)),
    // A sandbox's request replaces its own earlier one; undefined withdraws it.
    setPending: async (key: SandboxKey, pending: Omit<PendingAccess, "sandbox"> | undefined): Promise<void> =>
        await locked(async () => {
            const sandbox = sandboxKey(key);
            const others = (await readRequests()).filter((request) => request.sandbox !== sandbox);
            await chrome.storage.local.set({ [KEY_REQUESTS]: pending === undefined ? others : [...others, { ...pending, sandbox }] });
        }),
    // The person allowed `origin`: every agent waiting on it is answered at once.
    answerPending: async (origin: string): Promise<void> =>
        await locked(async () => {
            const requests = await readRequests();
            if (requests.some((request) => request.origin === origin)) {
                await chrome.storage.local.set({ [KEY_REQUESTS]: requests.filter((request) => request.origin !== origin) });
            }
        }),

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
    inbox: async (): Promise<PairedSandbox | undefined> => await read<PairedSandbox | undefined>(KEY_INBOX, undefined, pairedOf),
    setInbox: async (pairing: PairedSandbox | undefined): Promise<void> =>
        pairing === undefined ? await chrome.storage.local.remove([KEY_INBOX]) : await chrome.storage.local.set({ [KEY_INBOX]: pairing }),

    // Sites the person declined, with when; entries past DECLINE_HOLD_MS are dropped on every write.
    declined: async (): Promise<Record<string, number>> =>
        await read<Record<string, number>>(KEY_DECLINED, {}, (raw) =>
            typeof raw === "object" && raw !== null ? (raw as Record<string, number>) : undefined,
        ),
    decline: async (origin: string, at: number): Promise<void> =>
        await locked(async () => {
            const kept = Object.entries(await store.declined()).filter(([, when]) => at - when < DECLINE_HOLD_MS);
            await chrome.storage.local.set({ [KEY_DECLINED]: { ...Object.fromEntries(kept), [origin]: at } });
        }),
    forgetDecline: async (origin: string): Promise<void> =>
        await locked(async () => {
            const declined = await store.declined();
            if (origin in declined) {
                delete declined[origin];
                await chrome.storage.local.set({ [KEY_DECLINED]: declined });
            }
        }),

    settings: async (): Promise<Settings> =>
        await read<Settings>(KEY_SETTINGS, DEFAULT_SETTINGS, (raw) => {
            const value = raw as Partial<Settings> | undefined;
            return typeof value === "object" && value !== null ? { ...DEFAULT_SETTINGS, ...value } : undefined;
        }),
    setSettings: async (settings: Settings): Promise<void> => await chrome.storage.local.set({ [KEY_SETTINGS]: settings }),

    // Each sandbox's agent works in a window of its own, so two agents never point the same tab two ways.
    agentWindows: async (): Promise<Record<SandboxKey, number>> => await readAgentWindows(),
    agentWindowId: async (key: SandboxKey): Promise<number | undefined> => (await readAgentWindows())[sandboxKey(key)],
    setAgentWindowId: async (key: SandboxKey, id: number | undefined): Promise<void> =>
        await locked(async () => {
            const windows = await readAgentWindows();
            if (id === undefined) {
                delete windows[sandboxKey(key)];
            } else {
                windows[sandboxKey(key)] = id;
            }
            await chrome.storage.session.set({ [KEY_AGENT_WINDOWS]: windows });
        }),
    agentWindowBounds: async (): Promise<WindowBounds | undefined> =>
        await read<WindowBounds | undefined>(KEY_AGENT_BOUNDS, undefined, (raw) => {
            const parsed = BoundsSchema.safeParse(raw);
            return parsed.success ? parsed.data : undefined;
        }),
    setAgentWindowBounds: async (bounds: WindowBounds | undefined): Promise<void> =>
        bounds === undefined ? await chrome.storage.local.remove([KEY_AGENT_BOUNDS]) : await chrome.storage.local.set({ [KEY_AGENT_BOUNDS]: bounds }),

    // Every question an agent is waiting on, oldest first: two agents may each be asking one.
    asking: async (): Promise<Asking[]> => await readAsking(),
    addAsking: async (asking: Asking): Promise<void> =>
        await locked(async () => {
            await chrome.storage.session.set({ [KEY_ASKING]: [...(await readAsking()), asking] });
        }),
    // Withdraws the questions named; none named withdraws every one.
    removeAsking: async (ids?: readonly string[]): Promise<void> =>
        await locked(async () => {
            const kept = ids === undefined ? [] : (await readAsking()).filter((asking) => !ids.includes(asking.id));
            await chrome.storage.session.set({ [KEY_ASKING]: kept });
        }),

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
