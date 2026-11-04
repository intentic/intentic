import { within } from "@intentic/base/async";
import { askPerson } from "../asking.js";
import { assertRunning, assertScope, RefusedError, siteOf } from "../policy.js";
import { type ParsedScript, parseUserScript } from "../scripts/header.js";
import { fieldsOf, type InstalledScript, kept, SCRIPT_DECLINE_HOLD_MS, type ScriptLogEntry, type ScriptRequest, sha256, TRY_HOLD_MS } from "../scripts/kept.js";
import {
    availability,
    cspFor,
    scriptsApi,
    stopContext,
    syncScripts,
    type TryOutcome,
    TryOutcomeSchema,
    trySources,
    unavailableMessage,
    whyStopped,
} from "../scripts/runtime.js";
import { owner } from "../site-grants.js";
import { type SandboxKey, sandboxKey, sandboxName, store } from "../store.js";
import { openPanel, refreshBadge } from "./access.js";
import { announce } from "./page.js";
import { targetTab } from "./tab-access.js";

// The agent's script tools and the person's answers to them. The agent writes a script and tries it on a page; the
// person installs it, from the popup, having seen its code, its sites and the hosts it may reach. Once installed it is
// theirs: it runs on every visit to its sites, with the sandbox offline too, until they turn it off or remove it, or
// its agent does for its own. Nothing here widens what a script may do without the person's click: an update that
// keeps the same sites and hosts may skip the question only where they ticked "let it update without asking".

// How long an install waits for the person before answering that it is still waiting: the question stays in the popup
// after that, and the answer still installs it. The same two minutes the page's own questions wait (page.ts).
const REVIEW_WAIT_MS = 120_000;
// script_try: how long the script may run before it is reported as still running, and the ceiling on how long its log
// is collected after it returns.
const TRY_RUN_MS = 10_000;
const TRY_SETTLE_LIMIT_S = 10;

type ReviewAnswer = "installed" | "declined";
// The popup's answer to a request still being waited on, by its id: lives as long as the call that asked.
const reviews = new Map<string, (answer: ReviewAnswer) => void>();

const short = (hash: string): string => hash.slice(0, 12);
const sitesOf = (script: Pick<ParsedScript, "sites">): string => script.sites.map(siteOf).join(", ");
const randomId = (prefix: string): string => `${prefix}${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;

// Everything every script tool needs first: this browser running, the card's switch on, and the browser able to run
// scripts at all.
const gate = async (from: SandboxKey): Promise<void> => {
    assertRunning(await store.paused());
    assertScope(await store.scopes(from), "scripts");
    const state = await availability();
    if (state !== "ready") {
        throw new RefusedError(unavailableMessage(state));
    }
};

// A script may run only where its agent may click and type: every site it names allowed, in "read and act".
const assertSitesAllowed = async (script: ParsedScript): Promise<void> => {
    const { modes } = await stopContext();
    const missing = script.sites.filter((site) => modes.get(site) === undefined);
    if (missing.length > 0) {
        throw new RefusedError(
            `A script runs only on sites you may work on, and ${missing.map(siteOf).join(", ")} ${missing.length === 1 ? "is" : "are"} not allowed. Call ask_access for ${missing.length === 1 ? "it" : "each"} first, with the script as your reason.`,
        );
    }
    const readOnly = script.sites.filter((site) => modes.get(site) === "read");
    if (readOnly.length > 0) {
        throw new RefusedError(
            `A script changes the page, so it needs "read and act", and ${readOnly.map(siteOf).join(", ")} ${readOnly.length === 1 ? "is" : "are"} read only. Ask the person to switch ${readOnly.length === 1 ? "it" : "them"} to Read & act in the extension.`,
        );
    }
};

const parsedOrRefused = (source: string): ParsedScript => {
    const parsed = parseUserScript(source);
    if (!parsed.ok) {
        throw new RefusedError(parsed.message);
    }
    return parsed.script;
};

const ownScript = async (from: SandboxKey, id: string): Promise<InstalledScript> => {
    const script = await kept.script(id);
    if (script === undefined) {
        throw new RefusedError(`There is no script "${id}" in this browser. \`scripts\` lists them.`);
    }
    if (sandboxKey(script.sandbox) !== sandboxKey(from)) {
        const other = await store.sandbox(script.sandbox);
        throw new RefusedError(
            `"${script.name}" was installed from ${other === undefined ? "a sandbox that is no longer connected" : sandboxName(other)}. Only it, or the person, can change it.`,
        );
    }
    return script;
};

const notDeclined = async (hash: string, name: string): Promise<void> => {
    const at = await kept.declinedAt(hash);
    if (at !== undefined && Date.now() - at < SCRIPT_DECLINE_HOLD_MS) {
        throw new RefusedError(`The person declined "${name}" a moment ago. Do not ask again with the same script: ask them what they would change.`);
    }
};

const warningsOf = (script: ParsedScript): string => (script.warnings.length === 0 ? "" : `\n\nNote: ${script.warnings.join(" ")}`);

// Leaves the request in the popup and waits for the person, as long as REVIEW_WAIT_MS.
const review = async (request: ScriptRequest): Promise<ReviewAnswer | "waiting"> => {
    await kept.setRequest(request);
    await refreshBadge();
    await openPanel();
    const answered = new Promise<ReviewAnswer>((resolve) => {
        reviews.set(request.id, resolve);
    });
    try {
        return await within(answered, REVIEW_WAIT_MS, "waiting" as const);
    } finally {
        reviews.delete(request.id);
    }
};

const reviewed = (answer: ReviewAnswer | "waiting", script: Pick<ParsedScript, "name" | "sites">, verb: "install" | "update"): string => {
    switch (answer) {
        case "installed":
            return `The person ${verb === "install" ? "installed" : "accepted the update to"} "${script.name}". It runs on ${sitesOf(script)} from the next page load there: reload a tab that is already open to see it. \`script_logs\` shows what it logs and every error it hits.`;
        case "declined":
            return `The person declined "${script.name}". Do not ask again with the same script: ask them what they would change.`;
        case "waiting":
            return `"${script.name}" is waiting for the person in their extension, with its code, its sites and the hosts it may reach. Tell them it is there, and stop: \`scripts\` lists it once they ${verb} it.`;
    }
};

// Who is asking, for the line every answer starts with.
export const describeScripts = async (from: SandboxKey): Promise<string> => {
    assertScope(await store.scopes(from), "scripts");
    const state = await availability();
    const [scripts, context, requests, sandboxes] = await Promise.all([kept.scripts(), stopContext(), kept.requests(), store.sandboxes()]);
    const nameOf = (key: SandboxKey): string => {
        const sandbox = sandboxes.find((each) => sandboxKey(each.url) === sandboxKey(key));
        return sandbox === undefined ? "a sandbox no longer connected" : sandboxName(sandbox);
    };
    const lines = scripts
        .toSorted((a, b) => a.name.localeCompare(b.name))
        .map((script) => {
            const mine = sandboxKey(script.sandbox) === sandboxKey(from);
            const stopped = whyStopped(script, context);
            return [
                `${mine ? `[${script.id}] ` : ""}${script.name}${script.version === "" ? "" : ` ${script.version}`} (${short(script.hash)})`,
                stopped === undefined ? "running" : `stopped: ${stopped}`,
                sitesOf(script),
                mine ? "yours" : `from ${nameOf(script.sandbox)}`,
                ...(mine && script.autoUpdate ? ["you may update its code without asking"] : []),
            ].join(" · ");
        });
    const waiting = requests.filter((request) => sandboxKey(request.sandbox) === sandboxKey(from));
    return [
        state === "ready" ? "" : unavailableMessage(state),
        lines.length === 0 ? "No scripts are installed in this browser." : `Scripts in this browser:\n${lines.map((line) => `  ${line}`).join("\n")}`,
        ...waiting.map((request) => `Waiting for the person: ${request.kind === "install" ? "installing" : "updating to"} "${request.name}" (${short(request.hash)}).`),
    ]
        .filter((line) => line !== "")
        .join("\n");
};

export const installScript = async (from: SandboxKey, source: string, path: string | undefined): Promise<string> => {
    await gate(from);
    const script = parsedOrRefused(source);
    await assertSitesAllowed(script);
    const existing = (await kept.scripts()).find((each) => sandboxKey(each.sandbox) === sandboxKey(from) && each.name === script.name);
    if (existing !== undefined) {
        throw new RefusedError(`"${script.name}" is installed already, as ${existing.id}. Change it with script_update { id: "${existing.id}" }.`);
    }
    const hash = await sha256(source);
    await notDeclined(hash, script.name);
    const request: ScriptRequest = { ...fieldsOf({ ...script, hash, from: path }), id: randomId("rq_"), sandbox: sandboxKey(from), kind: "install", at: Date.now() };
    return `${reviewed(await review(request), script, "install")}${warningsOf(script)}`;
};

// Whether an update keeps to what the person already allowed: the same sites, no host it may reach that it could not.
const keepsWithin = (script: InstalledScript, next: ParsedScript): boolean =>
    script.sites.join(" ") === next.sites.join(" ") && next.connects.every((source) => script.connects.includes(source));

const markInstalled = async (id: string, hash: string, verb: string): Promise<void> => {
    await kept.appendLog(id, { at: Date.now(), level: "log", text: `${verb} ${short(hash)}. Lines from here on are this version's.`, page: "" });
};

export const updateScript = async (from: SandboxKey, id: string, source: string, path: string | undefined): Promise<string> => {
    await gate(from);
    const script = await ownScript(from, id);
    const next = parsedOrRefused(source);
    await assertSitesAllowed(next);
    const hash = await sha256(source);
    if (hash === script.hash) {
        return `"${script.name}" already runs exactly this code (${short(hash)}). Nothing changed.`;
    }
    await notDeclined(hash, next.name);
    if (script.autoUpdate && keepsWithin(script, next)) {
        await kept.changeScript(id, (each) => ({ ...each, ...fieldsOf({ ...next, hash, from: path ?? each.from }), updatedAt: Date.now() }));
        await markInstalled(id, hash, "Updated to");
        await syncScripts();
        await owner(`Let ${sandboxName((await store.sandbox(from)) ?? { url: from })} update “${next.name}” without asking`);
        return `Updated "${next.name}" to ${short(hash)} without asking: the person lets you change its code while its sites and hosts stay the same. It runs from the next page load.${warningsOf(next)}`;
    }
    const request: ScriptRequest = {
        ...fieldsOf({ ...next, hash, from: path ?? script.from }),
        id: randomId("rq_"),
        sandbox: sandboxKey(from),
        kind: "update",
        scriptId: id,
        at: Date.now(),
    };
    return `${reviewed(await review(request), next, "update")}${warningsOf(next)}`;
};

export const removeScript = async (from: SandboxKey, id: string): Promise<string> => {
    assertRunning(await store.paused());
    const script = await ownScript(from, id);
    await kept.removeScript(id);
    await syncScripts();
    return `Removed "${script.name}" from this browser. It stops on the next page load there.`;
};

export const toggleScript = async (from: SandboxKey, id: string, on: boolean): Promise<string> => {
    assertRunning(await store.paused());
    const script = await ownScript(from, id);
    if (on && !script.on && script.offBy === "person") {
        throw new RefusedError(`The person turned "${script.name}" off. Only they turn it back on, from the extension: ask them if it should run again.`);
    }
    await kept.changeScript(id, (each) => {
        const { offBy: _offBy, ...rest } = each;
        return on ? { ...rest, on: true } : { ...rest, on: false, offBy: "agent" };
    });
    await syncScripts();
    return on ? `Turned "${script.name}" on: it runs from the next page load.` : `Turned "${script.name}" off: it stops on the next page load.`;
};

const logLine = (entry: ScriptLogEntry): string => {
    // zone-checked: a log line's clock time for the agent, which compares lines with each other rather than with a zone.
    const time = new Date(entry.at).toISOString().slice(11, 19);
    return `${time} ${entry.level.padEnd(5)} ${entry.page === "" ? "" : `${entry.page}  `}${entry.text}`;
};

export const scriptLogs = async (from: SandboxKey, id: string, clear: boolean): Promise<string> => {
    const script = await ownScript(from, id);
    const [log, context] = await Promise.all([kept.log(id), stopContext()]);
    if (clear) {
        await kept.clearLog(id);
    }
    const stopped = whyStopped(script, context);
    return [
        `"${script.name}" (${short(script.hash)}) is ${stopped === undefined ? "running" : `stopped: ${stopped}`}.`,
        log.length === 0 ? "It has logged nothing yet. Its errors land here, and anything it passes to intentic.log." : `Newest first:\n${log.map(logLine).join("\n")}`,
        ...(clear ? ["(cleared)"] : []),
    ].join("\n");
};

// The person's yes to trying scripts on one site: every time when they asked to be asked about everything, once per
// TRY_HOLD_MS in the default mode, never when they trust the agent to act unasked.
const tryConsent = async (from: SandboxKey, tab: { readonly id: number; readonly url: string }, site: string): Promise<void> => {
    const scopes = await store.scopes(from);
    if (scopes.confirm === "never") {
        return;
    }
    const at = await kept.triedAt(sandboxKey(from), site);
    if (scopes.confirm === "sensitive" && at !== undefined && Date.now() - at < TRY_HOLD_MS) {
        return;
    }
    const question =
        scopes.confirm === "always"
            ? `Your agent wants to run a script it is writing on this page, to test it. Allow it?`
            : `Your agent wants to run scripts it is writing on ${siteOf(site)}, to test them. Allow it for the next ${TRY_HOLD_MS / 60_000} minutes?`;
    if (!(await askPerson(from, tab, question, REVIEW_WAIT_MS))) {
        throw new RefusedError(`The person said no (or did not answer) to running a script here. Do not try another way round it; ask them.`);
    }
    await kept.allowTries(sandboxKey(from), site, Date.now());
};

// What a try came to, as the agent reads it: where it ran, how it ended, and what it logged.
const tryAnswer = (outcome: TryOutcome, where: string): string => {
    const said = outcome.logs.map((line) => `  ${line.level.padEnd(5)} ${line.text}`);
    const head = !outcome.parsed
        ? `The script does not parse, so none of it ran.${said.length === 0 ? " Check its brackets and quotes around where you last changed it." : ""}`
        : outcome.pending === true
          ? `It ran on ${where} and was still going after ${TRY_RUN_MS / 1000}s.`
          : outcome.ok === true
            ? `It ran on ${where}${outcome.value === undefined ? "." : ` and returned ${outcome.value}`}`
            : `It threw on ${where}:\n${outcome.error ?? ""}`;
    return [head, ...(said.length === 0 ? [] : ["What it logged:", ...said])].join("\n");
};

export const tryScript = async (from: SandboxKey, source: string, settleSeconds: number, tabId?: number): Promise<string> => {
    await gate(from);
    const api = scriptsApi();
    if (api?.execute === undefined) {
        throw new RefusedError(unavailableMessage("old"));
    }
    const tab = await targetTab(from, "act", tabId);
    const site = `${new URL(tab.url).origin}/*`;
    // A source with a header reaches what its header says; a bare snippet only its page's own site.
    const connects = source.includes("==UserScript==") ? parsedOrRefused(source).connects : [];
    await tryConsent(from, tab, site);
    const worldId = `try-${(await sha256(sandboxKey(from))).slice(0, 12)}`;
    await api.configureWorld({ worldId, messaging: false, csp: cspFor({ sites: [site], connects: [...connects] }) });
    announce(tab.id, `Your agent is trying a script it is writing`);
    const settleMs = Math.round(Math.min(Math.max(settleSeconds, 0), TRY_SETTLE_LIMIT_S) * 1000);
    const results = await within(
        api.execute({ target: { tabId: tab.id }, js: trySources(source, TRY_RUN_MS, settleMs), worldId, injectImmediately: true }),
        TRY_RUN_MS + settleMs + 5000,
        undefined,
    );
    const outcome = TryOutcomeSchema.safeParse(results?.[0]?.result).data;
    if (outcome === undefined) {
        throw new RefusedError(`The page did not answer. It may have navigated while the script ran; open it again and retry.`);
    }
    return tryAnswer(outcome, tab.title === "" ? tab.url : `"${tab.title}"`);
};

// --- The person, in the popup ---

// The person's answer to a request. False when it is gone (answered elsewhere, or its sandbox disconnected).
export const answerScriptRequest = async (id: string, accept: boolean, autoUpdate: boolean): Promise<boolean> => {
    const request = await kept.dropRequest(id);
    if (request === undefined) {
        return false;
    }
    await refreshBadge();
    if (!accept) {
        await kept.decline(request.hash, Date.now());
        await owner(`Declined the script “${request.name}”`);
        reviews.get(id)?.("declined");
        return true;
    }
    const fields = fieldsOf(request);
    const now = Date.now();
    const updated =
        request.kind === "update" &&
        request.scriptId !== undefined &&
        (await kept.changeScript(request.scriptId, (script) => ({ ...script, ...fields, autoUpdate, updatedAt: now })));
    const scriptId = updated ? request.scriptId! : randomId("us_");
    if (!updated) {
        await kept.putScript({
            ...fields,
            id: scriptId,
            sandbox: request.sandbox,
            on: true,
            autoUpdate,
            secret: crypto.randomUUID(),
            installedAt: now,
            updatedAt: now,
        });
    }
    await markInstalled(scriptId, request.hash, updated ? "Updated to" : "Installed");
    await syncScripts();
    await owner(`${updated ? "Updated" : "Installed"} the script “${request.name}”`);
    reviews.get(id)?.("installed");
    return true;
};

export const personToggle = async (id: string, on: boolean): Promise<void> => {
    const script = await kept.script(id);
    await kept.changeScript(id, (each) => {
        const { offBy: _offBy, ...rest } = each;
        return on ? { ...rest, on: true } : { ...rest, on: false, offBy: "person" };
    });
    await syncScripts();
    if (script !== undefined) {
        await owner(`Turned the script “${script.name}” ${on ? "on" : "off"}`);
    }
};

export const personRemove = async (id: string): Promise<void> => {
    const script = await kept.script(id);
    await kept.removeScript(id);
    await syncScripts();
    if (script !== undefined) {
        await owner(`Removed the script “${script.name}”`);
    }
};

export const personAutoUpdate = async (id: string, on: boolean): Promise<void> => {
    await kept.changeScript(id, (each) => ({ ...each, autoUpdate: on }));
};
