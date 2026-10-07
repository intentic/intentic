import { extensionIdOf } from "@intentic/extension-manifest";
import { EXTENSION_EVENTS_HEARTBEAT_MS, type ExtensionEvent, type ExtensionOwnSettings } from "@intentic/sandbox-contract/extension-protocol";
import type { Context } from "hono";
import { stream } from "hono/streaming";
import type { AppEnv } from "../../app-env.js";
import { callingExtension } from "../../auth/grants.js";
import type { Services } from "../../composition.js";
import { subscribeRefChanges } from "../../git/remote/ref-watch.js";
import { subscribeRepoChanges } from "../../workspace/watch/repo-watch.js";
import { subscribeUnwatchedWrites, subscribeWorkspaceChanges } from "../../workspace/watch/workspace-watch.js";
import { extensionSettingsDocument, type ExtensionSettings, onExtensionSettingsWritten, readAllExtensionSettings } from "../extension-settings.js";
import { type InstalledExtension, installedExtensions } from "../installed-extensions.js";

// What an extension's own code asks the daemon about itself (the contract's extension-protocol): its settings with
// their secret values, and one stream of what moved, its settings and the workspace. Every extension token reaches both
// without declaring them (extension-manifest's EXTENSION_OWN_ROUTES), and each answers only about the extension the
// token was minted for, resolved here again so the check holds on a loopback daemon where no grant middleware runs.

// The calling extension, or the refusal to answer with.
const ownCaller = async (services: Services, c: Context<AppEnv>): Promise<InstalledExtension | Response> => {
    const caller = callingExtension(services.extensionBackend.verifyExtensionToken, (name) => c.req.header(name));
    if (caller === undefined) {
        return c.json({ error: "these routes answer an extension's own token only" }, 403);
    }
    const extension = (await installedExtensions(services)).find((candidate) => candidate.id === caller.id);
    return extension ?? c.json({ error: `no installed extension "${caller.id}"` }, 404);
};

// Its stored values, keyed by its identity like everything else of its settings, secrets rehydrated from the vault.
const settingsOf = async (services: Services, extension: InstalledExtension): Promise<ExtensionSettings> =>
    (await readAllExtensionSettings(services.workspace.root, services.extensionSecretVault))[extensionIdOf(extension.manifest)] ?? {};

// The keys whose value differs between two readings, either way.
const changedKeys = (before: ExtensionSettings, after: ExtensionSettings): string[] =>
    [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((key) => before[key] !== after[key]).toSorted();

export const createExtensionOwnRoutes = (services: Services) => ({
    settings: async (c: Context<AppEnv>): Promise<Response> => {
        const extension = await ownCaller(services, c);
        if (extension instanceof Response) {
            return extension;
        }
        return c.json({ settings: await settingsOf(services, extension) } satisfies ExtensionOwnSettings);
    },

    // One ndjson frame per line until the extension lets go: a heartbeat on a fixed beat, the workspace's file, ref and
    // repository changes as the editor's own stream carries them, and its own settings' changed keys, however they
    // changed (the settings route, an agent, a hand edit of the tracked file).
    events: async (c: Context<AppEnv>): Promise<Response> => {
        const extension = await ownCaller(services, c);
        if (extension instanceof Response) {
            return extension;
        }
        const identity = extensionIdOf(extension.manifest);
        c.header("content-type", "application/x-ndjson");
        return stream(c, async (ndjson) => {
            // Frames go out in order, one write at a time; a write to a stream the extension already closed is dropped.
            let tail: Promise<unknown> = Promise.resolve();
            const send = (event: ExtensionEvent): void => {
                // allow(silent-catch): the only failure is a reader that went away, which the abort below also ends
                tail = tail.then(() => ndjson.writeln(JSON.stringify(event))).catch(() => undefined);
            };
            let known = await settingsOf(services, extension);
            // Re-read and compare rather than trust the trigger: a write that changed nothing, or another extension's,
            // tells this one nothing.
            const compare = async (): Promise<void> => {
                let now: ExtensionSettings;
                try {
                    now = await settingsOf(services, extension);
                } catch (error) {
                    services.logger.warn({ err: error, extension: extension.id }, "extension events: its settings could not be re-read");
                    return;
                }
                const keys = changedKeys(known, now);
                known = now;
                if (keys.length > 0) {
                    send({ kind: "settings", keys });
                }
            };
            // One comparison at a time, in the order the triggers came.
            let checking: Promise<void> = Promise.resolve();
            const recheck = (): void => {
                checking = checking.then(compare);
            };
            const settingsFile = extensionSettingsDocument.path;
            const stops = [
                onExtensionSettingsWritten((written) => {
                    if (written === identity) {
                        recheck();
                    }
                }),
                subscribeWorkspaceChanges((paths) => {
                    send({ kind: "files", paths });
                    if (paths.includes(settingsFile)) {
                        recheck();
                    }
                }),
                subscribeUnwatchedWrites(() => send({ kind: "files", paths: [] })),
                subscribeRefChanges((repos) => send({ kind: "refs", repos })),
                subscribeRepoChanges((repos) => send({ kind: "repos", repos })),
            ];
            send({ kind: "heartbeat" });
            const beat = setInterval(() => send({ kind: "heartbeat" }), EXTENSION_EVENTS_HEARTBEAT_MS);
            try {
                await new Promise<void>((resolve) => ndjson.onAbort(resolve));
            } finally {
                clearInterval(beat);
                for (const stop of stops) {
                    stop();
                }
            }
        });
    },
});
