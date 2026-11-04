import { errorMessage } from "@intentic/base/errors";
import type { WebExtGrant } from "@intentic/sandbox-contract/webext";
import { array, boolean, object, string, enum as zEnum } from "zod";
import { siteOf } from "../policy.js";
import { store } from "../store.js";
import { currentGrants } from "../tools/tab-access.js";
import { type InstalledScript, kept, ScriptValueSchema } from "./kept.js";

// How an installed script runs: the browser's userScripts API holds the registrations, rebuilt here from what kept.ts
// holds whenever anything that decides them changes (a script, a site's grant, pause, the extension's own update,
// which clears them). Each script runs in a world of its own, named after it, whose content security policy lets it
// reach only its own sites and the hosts its @connect names: measured on Chrome 156, that policy blocks the world's
// fetch and the images it loads to any other host, while the page's own policy does not apply to it at all.

// Chrome 135: `userScripts.execute`, which script_try needs; worlds of their own came in 133.
const MIN_CHROME = 135;

export type ScriptsAvailability =
    // Installed scripts run and the tools work.
    | "ready"
    // The extension does not hold the optional permission yet: the popup's "Turn on" asks for it.
    | "permission"
    // It holds it, but the browser's own switch for it is off (chrome://extensions, this extension's details).
    | "toggle"
    // Older than Chrome 135.
    | "old";

const chromeMajor = (): number => Number(/(?:Chrome|Chromium)\/(\d+)/.exec(navigator.userAgent)?.[1] ?? "0");

// The browser's own name for the switch: Developer mode before Chrome 138, "Allow User Scripts" since.
export const toggleName = (): string => (chromeMajor() >= 138 ? `"Allow User Scripts"` : `"Developer mode"`);

// The API when it can be used; Chrome leaves `chrome.userScripts` undefined while its switch is off, and a call on it
// may throw synchronously in a build that defines it anyway.
export const scriptsApi = (): chrome.UserScriptsApi | undefined => {
    const api = chrome.userScripts;
    if (api === undefined) {
        return undefined;
    }
    try {
        // allow(silent-catch): an answer that rejects later says nothing about whether the API is there
        void api.getScripts().catch(() => undefined);
        return api;
        // allow(silent-catch): a build that defines the API but throws on calling it has none to use, which is what undefined says
    } catch {
        return undefined;
    }
};

export const availability = async (): Promise<ScriptsAvailability> => {
    if (chromeMajor() < MIN_CHROME) {
        return "old";
    }
    if (!(await chrome.permissions.contains({ permissions: ["userScripts"] }))) {
        return "permission";
    }
    return scriptsApi() === undefined ? "toggle" : "ready";
};

// What the agent is told when scripts cannot run, naming exactly what the person turns on.
export const unavailableMessage = (state: Exclude<ScriptsAvailability, "ready">): string =>
    state === "old"
        ? `This browser is older than Chrome ${MIN_CHROME}, which user scripts need. Say so: updating the browser is the fix.`
        : state === "permission"
          ? `Scripts are not turned on in this browser. The person turns them on in the extension's popup, under Scripts: ask them, and stop until they have.`
          : `Scripts are allowed, but the browser's own ${toggleName()} switch for this extension is off. The person turns it on from the extension's popup, under Scripts: ask them, and stop until they have.`;

// Why an installed script is not running right now, or nothing when it is.
export const whyStopped = (
    script: Pick<InstalledScript, "on" | "offBy" | "sites">,
    context: { readonly ready: boolean; readonly paused: boolean; readonly modes: ReadonlyMap<string, WebExtGrant["mode"]> },
): string | undefined => {
    if (!script.on) {
        return script.offBy === "agent" ? "Turned off by its agent" : "Turned off";
    }
    if (!context.ready) {
        return "Scripts are off in this browser";
    }
    if (context.paused) {
        return "Paused";
    }
    const lost = script.sites.find((site) => context.modes.get(site) === undefined);
    if (lost !== undefined) {
        return `${siteOf(lost)} is no longer allowed`;
    }
    const readOnly = script.sites.find((site) => context.modes.get(site) === "read");
    return readOnly === undefined ? undefined : `${siteOf(readOnly)} is read only`;
};

export const stopContext = async (): Promise<{ readonly ready: boolean; readonly paused: boolean; readonly modes: ReadonlyMap<string, WebExtGrant["mode"]> }> => {
    const [state, paused, grants] = await Promise.all([availability(), store.paused(), currentGrants()]);
    return { ready: state === "ready", paused, modes: new Map(grants.map((grant) => [grant.origin, grant.mode])) };
};

// Where the script's world may reach: its own sites and its @connect hosts, nothing else. Styles may be inline, since
// restyling a page is most of what user scripts do; eval stays refused, as in every extension world.
// A site's pattern names no port (match patterns ignore it), while a CSP source without one means the scheme's default
// port only: measured on Chrome 156, `http://127.0.0.1` refused the same site's fetch on port 38665. So a site's own
// source takes every port, as its pattern does.
const siteSource = (site: string): string => {
    const origin = site.replace(/\/\*$/, "");
    return /:\d+$/.test(origin) ? origin : `${origin}:*`;
};

export const cspFor = (script: Pick<InstalledScript, "sites" | "connects">): string => {
    const reach = [...script.sites.map(siteSource), ...script.connects].join(" ");
    return [
        `default-src 'none'`,
        `script-src 'self'`,
        `connect-src ${reach}`,
        `img-src ${reach} data: blob:`,
        `media-src ${reach} data: blob:`,
        `font-src ${reach} data:`,
        `style-src ${reach} 'unsafe-inline'`,
        `frame-src ${reach}`,
        `object-src 'none'`,
    ].join("; ");
};

// Values as a person reads them in a log line, in the page: strings as they are, errors with their stack, the rest as
// JSON. Shared by both preambles below.
const WORDS = `const words = (values) => values.map((value) => {
    if (typeof value === "string") return value;
    if (value instanceof Error) return value.stack || String(value);
    try { const text = JSON.stringify(value); return text === undefined ? String(value) : text; } catch { return String(value); }
}).join(" ");`;

// First of a script's three sources: `intentic`, the little it gets from the extension, and the listeners that send what
// goes wrong to its log. The secret travels only inside this world (kept.ts says why).
const installedPreamble = (script: Pick<InstalledScript, "id" | "secret" | "name" | "version">): string => `(() => {
const ID = ${JSON.stringify(script.id)};
const SECRET = ${JSON.stringify(script.secret)};
${WORDS}
const say = (op, fields) => chrome.runtime.sendMessage({ script: ID, secret: SECRET, op, ...fields });
// allow(silent-catch): a line the extension cannot take (it is reloading) has nowhere else to go, and must not throw in the page
const log = (level) => (...values) => { say("log", { level, text: words(values).slice(0, 2000) }).catch(() => undefined); };
const ask = async (op, fields) => {
    const answer = await say(op, fields);
    if (!answer || answer.ok !== true) throw new Error((answer && answer.message) || "The Intentic extension did not answer.");
    return answer.value;
};
globalThis.intentic = Object.freeze({
    script: Object.freeze({ id: ID, name: ${JSON.stringify(script.name)}, version: ${JSON.stringify(script.version)} }),
    log: log("log"),
    warn: log("warn"),
    error: log("error"),
    storage: Object.freeze({
        get: (key) => ask("get", { key: String(key) }),
        set: (key, value) => ask("set", { key: String(key), value: value === undefined ? null : JSON.parse(JSON.stringify(value)) }),
        remove: (key) => ask("set", { key: String(key) }),
    }),
});
addEventListener("error", (event) => log("error")("Uncaught " + ((event.error && event.error.stack) || event.message)));
addEventListener("unhandledrejection", (event) => log("error")("Unhandled rejection: " + words([event.reason])));
globalThis.__intenticRan = false;
})();`;

// The script itself, inside an async function, so it may `await` and `return` at its top level as it would in
// Tampermonkey. The flag is set before its first line: a script that does not parse never sets it. All of that sits on
// the script's own first line, so a line number in an error's stack is the line in the agent's file.
const body = (source: string, flag: string, lead: string, tail: string): string => `${flag} = true; ${lead}(async () => {${source}
})()${tail};`;

const installedSources = (script: InstalledScript): chrome.UserScriptSource[] => [
    { code: installedPreamble(script) },
    {
        code: body(
            script.source,
            "globalThis.__intenticRan",
            "",
            `.catch((error) => intentic.error("Uncaught " + ((error && error.stack) || String(error))))`,
        ),
    },
    { code: `if (globalThis.__intenticRan !== true) intentic.error("This script did not run: it does not parse. script_try shows why.");` },
];

const registrationOf = (script: InstalledScript): chrome.RegisteredUserScript => ({
    id: script.id,
    matches: [...script.matches],
    excludeMatches: [...script.excludeMatches],
    js: installedSources(script),
    runAt: script.runAt,
    worldId: script.id,
});

// Brings the browser's registrations in line with what is kept, one pass at a time: a change that lands mid-pass asks
// for one more rather than racing it. Nothing to do while the API is off: the browser runs nothing then anyway.
let syncing: Promise<void> | undefined;
let syncAgain = false;

const syncOnce = async (): Promise<void> => {
    const api = scriptsApi();
    if (api === undefined) {
        return;
    }
    const [scripts, context] = await Promise.all([kept.scripts(), stopContext()]);
    const running = scripts.filter((script) => whyStopped(script, context) === undefined);
    const registered = new Set((await api.getScripts()).map((each) => each.id));
    const wanted = new Set(running.map((script) => script.id));
    const stale = [...registered].filter((id) => !wanted.has(id));
    if (stale.length > 0) {
        await api.unregister({ ids: stale });
    }
    for (const script of running) {
        await api.configureWorld({ worldId: script.id, messaging: true, csp: cspFor(script) });
        await (registered.has(script.id) ? api.update([registrationOf(script)]) : api.register([registrationOf(script)]));
    }
};

export const syncScripts = async (): Promise<void> => {
    if (syncing !== undefined) {
        syncAgain = true;
        return await syncing;
    }
    syncing = (async () => {
        do {
            syncAgain = false;
            try {
                await syncOnce();
            } catch (error) {
                console.warn("intentic: user scripts could not be brought in line with what is installed", error);
            }
        } while (syncAgain);
    })();
    try {
        await syncing;
    } finally {
        syncing = undefined;
    }
};

// Follows the person turning scripts on, which no event announces when it is the browser's own switch: asked on the
// worker's start, its alarm and whenever the popup draws, it brings every installed script in once the API appears.
let wasReady: boolean | undefined;
export const followAvailability = async (): Promise<ScriptsAvailability> => {
    const state = await availability();
    const ready = state === "ready";
    if (ready && wasReady !== true) {
        listenToScripts();
        await syncScripts();
    }
    wasReady = ready;
    return state;
};

// What a script's world may say to the worker. Anything else is refused before a field of it is read.
const MessageSchema = object({
    script: string().max(64),
    secret: string().max(128),
    op: zEnum(["log", "get", "set"]),
    level: zEnum(["log", "warn", "error"]).optional(),
    text: string().max(4000).optional(),
    key: string().max(200).optional(),
    value: ScriptValueSchema.optional(),
});

// A script that logs in a loop would otherwise write storage on every line.
const LOG_LINES_PER_MINUTE = 60;
const logBudget = new Map<string, { minute: number; lines: number }>();
const withinLogBudget = (id: string, now: number): boolean => {
    const minute = Math.floor(now / 60_000);
    const spent = logBudget.get(id);
    const lines = spent?.minute === minute ? spent.lines + 1 : 1;
    logBudget.set(id, { minute, lines });
    return lines <= LOG_LINES_PER_MINUTE;
};

// The page a line came from, without its query string: enough to say where, never what was searched for.
const pageOf = (url: string | undefined): string => {
    try {
        const parsed = new URL(url ?? "");
        return `${parsed.host}${parsed.pathname}`.slice(0, 120);
        // allow(silent-catch): an address that does not parse names no page, which is what the empty string says
    } catch {
        return "";
    }
};

export const handleUserScriptMessage = async (raw: chrome.UserScriptMessageIn, sender: { url?: string }): Promise<chrome.UserScriptAnswer> => {
    const parsed = MessageSchema.safeParse(raw);
    if (!parsed.success) {
        return { ok: false, message: "The Intentic extension did not understand that." };
    }
    const message = parsed.data;
    const script = await kept.script(message.script);
    if (script?.secret !== message.secret) {
        return { ok: false, message: "This script is not installed any more." };
    }
    switch (message.op) {
        case "log": {
            const now = Date.now();
            if (withinLogBudget(script.id, now)) {
                await kept.appendLog(script.id, { at: now, level: message.level ?? "log", text: message.text ?? "", page: pageOf(sender.url) });
            }
            return { ok: true };
        }
        case "get":
            return { ok: true, value: (await kept.data(script.id))[message.key ?? ""] ?? null };
        case "set": {
            const written = await kept.setData(script.id, message.key ?? "", message.value ?? undefined);
            return written.ok ? { ok: true } : { ok: false, message: written.message };
        }
    }
};

const answerScript = async (message: chrome.UserScriptMessageIn, sender: { url?: string }): Promise<chrome.UserScriptAnswer> => {
    try {
        return await handleUserScriptMessage(message, sender);
    } catch (error) {
        return { ok: false, message: errorMessage(error) };
    }
};

// Listens for scripts' messages once the API is there to send them. Chrome defines the event only while it is, which
// may be after this worker started (the person turned the switch on), so this is asked again whenever that may have
// changed rather than only at the top of the worker.
let listening = false;
export const listenToScripts = (): void => {
    const event = chrome.runtime.onUserScriptMessage;
    if (listening || event === undefined) {
        return;
    }
    listening = true;
    event.addListener((message, sender, respond) => {
        void answerScript(message, sender).then(respond);
        return true;
    });
};

// What the third of script_try's sources answers, as read back in the worker.
export const TryOutcomeSchema = object({
    parsed: boolean(),
    ok: boolean().optional(),
    pending: boolean().optional(),
    value: string().optional(),
    error: string().optional(),
    logs: array(object({ level: string(), text: string() })).catch([]),
});
export type TryOutcome = ReturnType<typeof TryOutcomeSchema.parse>;

// The sources script_try runs once, in a world of its own per sandbox: the same `intentic` as an installed script, but
// its log comes back in the answer and its storage starts empty and is thrown away. The third source reports from
// inside the page, since Chrome answers a script that threw or did not parse with a bare null.
export const trySources = (code: string, waitMs: number, settleMs: number): chrome.UserScriptSource[] => [
    {
        code: `(() => {
${WORDS}
const logs = [];
const log = (level) => (...values) => { if (logs.length < 200) logs.push({ level, text: words(values).slice(0, 1000) }); };
const memory = new Map();
globalThis.intentic = Object.freeze({
    script: Object.freeze({ id: "try", name: "(being tried)", version: "" }),
    log: log("log"),
    warn: log("warn"),
    error: log("error"),
    storage: Object.freeze({
        get: async (key) => (memory.has(String(key)) ? memory.get(String(key)) : null),
        set: async (key, value) => { memory.set(String(key), JSON.parse(JSON.stringify(value === undefined ? null : value))); },
        remove: async (key) => { memory.delete(String(key)); },
    }),
});
globalThis.__intenticTry = { logs, started: false, run: undefined };
if (!globalThis.__intenticTryListening) {
    globalThis.__intenticTryListening = true;
    const note = (text) => { const tried = globalThis.__intenticTry; if (tried && tried.logs.length < 200) tried.logs.push({ level: "error", text: text.slice(0, 1000) }); };
    addEventListener("error", (event) => note("Uncaught " + ((event.error && event.error.stack) || event.message)));
    addEventListener("unhandledrejection", (event) => note("Unhandled rejection: " + words([event.reason])));
}
})();`,
    },
    { code: body(code, "globalThis.__intenticTry.started", "globalThis.__intenticTry.run = ", "") },
    {
        code: `(async () => {
const tried = globalThis.__intenticTry;
if (!tried || !tried.started) return { parsed: false, logs: tried ? tried.logs : [] };
const pending = Symbol("pending");
const text = (value) => {
    if (value === undefined) return undefined;
    if (typeof Node !== "undefined" && value instanceof Node) return "<" + String(value.nodeName).toLowerCase() + ">";
    try { const json = JSON.stringify(value); return json === undefined ? String(value) : json; } catch { return String(value); }
};
try {
    const value = await Promise.race([tried.run, new Promise((resolve) => setTimeout(() => resolve(pending), ${waitMs}))]);
    await new Promise((resolve) => setTimeout(resolve, ${settleMs}));
    if (value === pending) return { parsed: true, ok: true, pending: true, logs: tried.logs };
    const shown = text(value);
    return { parsed: true, ok: true, value: shown === undefined ? undefined : shown.slice(0, 8000), logs: tried.logs };
} catch (error) {
    return { parsed: true, ok: false, error: String((error && error.stack) || error).slice(0, 4000), logs: tried.logs };
}
})()`,
    },
];
