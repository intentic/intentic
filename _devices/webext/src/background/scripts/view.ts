import type { ScriptRequestView, ScriptRow, ScriptsState } from "../messages.js";
import { type PairedSandbox, type SandboxKey, sandboxKey, sandboxName, store } from "../store.js";
import { type InstalledScript, kept, type ScriptRequest } from "./kept.js";
import { followAvailability, stopContext, toggleName, whyStopped } from "./runtime.js";

// The popup's picture of user scripts, in the one round trip it draws from (main.ts readState): what the browser can
// do, every installed script and why one is not running, and every script an agent is waiting on the person for.

const byName = (sandboxes: readonly PairedSandbox[], key: SandboxKey): string => {
    const sandbox = sandboxes.find((each) => sandboxKey(each.url) === sandboxKey(key));
    return sandbox === undefined ? "a sandbox no longer connected" : sandboxName(sandbox);
};

const rowOf = async (script: InstalledScript, by: string, stopped: string | undefined): Promise<ScriptRow> => {
    // This version's lines only: the log is newest first, and each install or update leaves a line saying so.
    const log = await kept.log(script.id);
    const since = log.findIndex((entry) => entry.page === "" && /^(Installed|Updated to) /.test(entry.text));
    const errors = (since === -1 ? log : log.slice(0, since)).filter((entry) => entry.level === "error");
    return {
        id: script.id,
        name: script.name,
        version: script.version,
        description: script.description,
        sites: script.sites,
        connects: script.connects,
        by,
        on: script.on,
        autoUpdate: script.autoUpdate,
        hash: script.hash,
        errors: errors.length,
        updatedAt: script.updatedAt,
        from: script.from,
        stopped: script.on ? stopped : undefined,
        lastError: errors[0]?.text,
    };
};

const requestOf = (request: ScriptRequest, replaced: InstalledScript | undefined): ScriptRequestView => ({
        id: request.id,
        sandbox: request.sandbox,
        kind: request.kind,
        name: request.name,
        version: request.version,
        description: request.description,
        sites: request.sites,
        connects: request.connects,
        runAt: request.runAt,
        hash: request.hash,
        source: request.source,
        newConnects: replaced === undefined ? [] : request.connects.filter((source) => !replaced.connects.includes(source)),
        at: request.at,
        from: request.from,
        previous: replaced?.source,
});

export const scriptsState = async (): Promise<ScriptsState> => {
    const [state, scripts, requests, sandboxes, context] = await Promise.all([
        followAvailability(),
        kept.scripts(),
        kept.requests(),
        store.sandboxes(),
        stopContext(),
    ]);
    const rows = await Promise.all(
        scripts.toSorted((a, b) => a.name.localeCompare(b.name)).map(async (script) => await rowOf(script, byName(sandboxes, script.sandbox), whyStopped(script, context))),
    );
    return {
        availability: state,
        toggle: toggleName(),
        rows,
        requests: requests.map((request) => requestOf(request, scripts.find((script) => script.id === request.scriptId))),
    };
};
