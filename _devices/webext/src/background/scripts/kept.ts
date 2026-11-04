import { array, boolean, json, number, object, record, string, type ZodType, enum as zEnum } from "zod";
import type { SandboxKey } from "../store.js";
import type { ParsedScript, RunAt } from "./header.js";

// What this extension keeps about user scripts, in chrome.storage.local: the browser keeps registrations too, but
// clears them whenever the extension updates, so this is the record the registrations are rebuilt from
// (runtime.ts syncScripts). Its own module beside store.ts, which keeps everything else, and its own write queue,
// since none of these keys is one store.ts writes.
//
// A script belongs to the person once they install it: it stays when the sandbox that wrote it is disconnected, and
// only they (or that sandbox's agent, for its own) turn it off or remove it.

const KEY_SCRIPTS = "userScripts";
const KEY_REQUESTS = "userScriptRequests";
const KEY_DECLINED = "userScriptDeclines";
const KEY_LOG_OF = "userScriptLog:";
const KEY_DATA_OF = "userScriptData:";
// In chrome.storage.session: a "yes, let it try scripts here" lasts until the browser quits at most.
const KEY_TRIES = "userScriptTries";

// The newest this many lines of what a script logged: enough to debug the last few page loads, never a history.
const LOG_LIMIT = 100;
const LOG_TEXT_LIMIT = 1000;
// What one script may keep with intentic.storage, as JSON; storage.local holds 10 MB for the whole extension.
const DATA_LIMIT = 256_000;
// How long a declined script is not asked again: the same 15 minutes a declined site holds (store.ts DECLINE_HOLD_MS).
export const SCRIPT_DECLINE_HOLD_MS = 15 * 60_000;
// How long a yes to trying scripts on one site lasts, in the "ask for passwords, payments and deleting" mode.
export const TRY_HOLD_MS = 15 * 60_000;

const RunAtSchema = zEnum(["document_start", "document_end", "document_idle"]);

const ScriptFieldsSchema = object({
    name: string(),
    description: string(),
    version: string(),
    matches: array(string()),
    excludeMatches: array(string()),
    runAt: RunAtSchema,
    connects: array(string()),
    sites: array(string()),
    source: string(),
    // SHA-256 of `source`, hex; the first 12 are what a person and the agent compare.
    hash: string(),
    // Where the agent says the source lives in its sandbox ("userscripts/pr-sizes.user.js"); shown, never read.
    from: string().optional(),
});

const InstalledSchema = ScriptFieldsSchema.extend({
    // `us_` and random: Chrome's script ids may not start with "_", and the world is named after the script.
    id: string(),
    sandbox: string(),
    on: boolean(),
    // Who turned it off: a script the person turned off is theirs to turn back on, never the agent's.
    offBy: zEnum(["person", "agent"]).optional(),
    // The person let this sandbox update the code without asking, while its sites and hosts stay the same.
    autoUpdate: boolean(),
    // What only this script's own world knows: its messages to the worker carry it, since Chrome does not say which
    // world a message came from (measured on Chrome 156: no `userScriptWorldId` on the sender).
    secret: string(),
    installedAt: number(),
    updatedAt: number(),
});
export type InstalledScript = ReturnType<typeof InstalledSchema.parse>;

const RequestSchema = ScriptFieldsSchema.extend({
    id: string(),
    sandbox: string(),
    kind: zEnum(["install", "update"]),
    // The installed script an update replaces.
    scriptId: string().optional(),
    at: number(),
});
export type ScriptRequest = ReturnType<typeof RequestSchema.parse>;

// Declines and tries, each a key with when it happened.
const StampsSchema = record(string(), number());
// A script's own values: whatever JSON it handed intentic.storage.set.
export const ScriptValueSchema = json();
export type ScriptValue = ReturnType<typeof ScriptValueSchema.parse>;
const DataSchema = record(string(), ScriptValueSchema);
type ScriptData = ReturnType<typeof DataSchema.parse>;

const LogEntrySchema = object({ at: number(), level: zEnum(["log", "warn", "error"]), text: string(), page: string() });
export type ScriptLogEntry = ReturnType<typeof LogEntrySchema.parse>;

export type ScriptFields = Omit<ParsedScript, "warnings"> & { readonly hash: string; readonly from?: string | undefined };

export const fieldsOf = (script: ScriptFields): ReturnType<typeof ScriptFieldsSchema.parse> => {
    const fields: ReturnType<typeof ScriptFieldsSchema.parse> = {
        name: script.name,
        description: script.description,
        version: script.version,
        matches: [...script.matches],
        excludeMatches: [...script.excludeMatches],
        runAt: script.runAt satisfies RunAt,
        connects: [...script.connects],
        sites: [...script.sites],
        source: script.source,
        hash: script.hash,
    };
    if (script.from !== undefined) {
        fields.from = script.from;
    }
    return fields;
};

// A list kept in storage, read entry by entry: one that no longer parses is dropped, the rest stand.
const listOf = <T>(entry: ZodType<T>) => array(entry.optional().catch(undefined)).catch([]);
const ScriptsSchema = listOf(InstalledSchema);
const RequestsSchema = listOf(RequestSchema);
const LogSchema = listOf(LogEntrySchema);
const present = <T>(each: T | undefined): each is T => each !== undefined;

// What one key holds, as its schema reads it, or `fallback`.
const readAs = async <T>(area: chrome.storage.Area, key: string, schema: ZodType<T>, fallback: T): Promise<T> =>
    schema.safeParse((await area.get([key]))[key]).data ?? fallback;

type Stamps = ReturnType<typeof StampsSchema.parse>;
// The stamps still inside `hold` of `at`, with `key` stamped at `at`.
const stamped = (kept: Stamps, key: string, at: number, hold: number): Stamps => {
    const fresh: Stamps = Object.fromEntries(Object.entries(kept).filter(([, when]) => at - when < hold));
    fresh[key] = at;
    return fresh;
};

let queue: Promise<unknown> = Promise.resolve();
const locked = async <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next;
    return await next;
};

const readScripts = async (): Promise<InstalledScript[]> => (await readAs(chrome.storage.local, KEY_SCRIPTS, ScriptsSchema, [])).filter(present);
const readRequests = async (): Promise<ScriptRequest[]> => (await readAs(chrome.storage.local, KEY_REQUESTS, RequestsSchema, [])).filter(present);
const readLog = async (key: string): Promise<ScriptLogEntry[]> => (await readAs(chrome.storage.local, key, LogSchema, [])).filter(present);
const readData = async (key: string): Promise<ScriptData> => await readAs(chrome.storage.local, key, DataSchema, {});
const readStamps = async (area: chrome.storage.Area, key: string): Promise<Stamps> => await readAs(area, key, StampsSchema, {});

export const sha256 = async (text: string): Promise<string> => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

export const kept = {
    scripts: async (): Promise<InstalledScript[]> => await readScripts(),
    script: async (id: string): Promise<InstalledScript | undefined> => (await readScripts()).find((script) => script.id === id),
    // Writes one script, replacing the one with its id.
    putScript: async (script: InstalledScript): Promise<void> =>
        await locked(async () => {
            const others = (await readScripts()).filter((each) => each.id !== script.id);
            await chrome.storage.local.set({ [KEY_SCRIPTS]: [...others, script] });
        }),
    // Changes one script by id; false when there is none.
    changeScript: async (id: string, change: (script: InstalledScript) => InstalledScript): Promise<boolean> =>
        await locked(async () => {
            const scripts = await readScripts();
            const at = scripts.findIndex((script) => script.id === id);
            if (at === -1) {
                return false;
            }
            scripts[at] = change(scripts[at]!);
            await chrome.storage.local.set({ [KEY_SCRIPTS]: scripts });
            return true;
        }),
    // Removes a script with what it logged and kept.
    removeScript: async (id: string): Promise<boolean> =>
        await locked(async () => {
            const scripts = await readScripts();
            if (!scripts.some((script) => script.id === id)) {
                return false;
            }
            await chrome.storage.local.set({ [KEY_SCRIPTS]: scripts.filter((script) => script.id !== id) });
            await chrome.storage.local.remove([`${KEY_LOG_OF}${id}`, `${KEY_DATA_OF}${id}`]);
            return true;
        }),

    // One request per sandbox, as with sites (store.ts setPending): its newer one replaces its older one.
    requests: async (): Promise<ScriptRequest[]> => await readRequests(),
    request: async (id: string): Promise<ScriptRequest | undefined> => (await readRequests()).find((request) => request.id === id),
    setRequest: async (request: ScriptRequest): Promise<void> =>
        await locked(async () => {
            const others = (await readRequests()).filter((each) => each.sandbox !== request.sandbox);
            await chrome.storage.local.set({ [KEY_REQUESTS]: [...others, request] });
        }),
    // Withdraws a request; one for another sandbox, or already answered, is left alone.
    dropRequest: async (id: string): Promise<ScriptRequest | undefined> =>
        await locked(async () => {
            const requests = await readRequests();
            const found = requests.find((request) => request.id === id);
            if (found !== undefined) {
                await chrome.storage.local.set({ [KEY_REQUESTS]: requests.filter((request) => request.id !== id) });
            }
            return found;
        }),
    dropRequestsOf: async (sandbox: SandboxKey): Promise<void> =>
        await locked(async () => {
            const requests = await readRequests();
            if (requests.some((request) => request.sandbox === sandbox)) {
                await chrome.storage.local.set({ [KEY_REQUESTS]: requests.filter((request) => request.sandbox !== sandbox) });
            }
        }),

    // Declined scripts by hash, so the same code is not asked again at once; a changed script is a new question.
    declinedAt: async (hash: string): Promise<number | undefined> => (await readStamps(chrome.storage.local, KEY_DECLINED))[hash],
    decline: async (hash: string, at: number): Promise<void> =>
        await locked(async () => {
            const declined = await readStamps(chrome.storage.local, KEY_DECLINED);
            await chrome.storage.local.set({ [KEY_DECLINED]: stamped(declined, hash, at, SCRIPT_DECLINE_HOLD_MS) });
        }),

    log: async (id: string): Promise<ScriptLogEntry[]> => await readLog(`${KEY_LOG_OF}${id}`),
    appendLog: async (id: string, entry: ScriptLogEntry): Promise<void> =>
        await locked(async () => {
            const key = `${KEY_LOG_OF}${id}`;
            const log = await readLog(key);
            const line = { ...entry, text: entry.text.slice(0, LOG_TEXT_LIMIT) };
            await chrome.storage.local.set({ [key]: [line, ...log].slice(0, LOG_LIMIT) });
        }),
    clearLog: async (id: string): Promise<void> => await chrome.storage.local.remove([`${KEY_LOG_OF}${id}`]),

    data: async (id: string): Promise<ScriptData> => await readData(`${KEY_DATA_OF}${id}`),
    // Writes one key of a script's values (undefined removes it); refused past DATA_LIMIT rather than trimmed, since a
    // value cut short is a value the script cannot trust.
    setData: async (id: string, key: string, value: ScriptValue | undefined): Promise<{ ok: true } | { ok: false; message: string }> =>
        await locked(async () => {
            const name = `${KEY_DATA_OF}${id}`;
            const data = { ...(await readData(name)) };
            if (value === undefined) {
                delete data[key];
            } else {
                data[key] = value;
            }
            const size = JSON.stringify(data).length;
            if (size > DATA_LIMIT) {
                return { ok: false, message: `intentic.storage is full for this script: ${Math.round(size / 1000)} kB of ${DATA_LIMIT / 1000} kB.` };
            }
            await chrome.storage.local.set({ [name]: data });
            return { ok: true };
        }),

    // The sites a sandbox's agent may try scripts on for a while without asking again, by when the person said yes.
    triedAt: async (sandbox: SandboxKey, site: string): Promise<number | undefined> =>
        (await readStamps(chrome.storage.session, KEY_TRIES))[`${sandbox} ${site}`],
    allowTries: async (sandbox: SandboxKey, site: string, at: number): Promise<void> =>
        await locked(async () => {
            const tries = await readStamps(chrome.storage.session, KEY_TRIES);
            await chrome.storage.session.set({ [KEY_TRIES]: stamped(tries, `${sandbox} ${site}`, at, TRY_HOLD_MS) });
        }),
};
