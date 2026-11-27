import { serialLock } from "@intentic/base/async";
import { declaredReachOf, type ExtensionDeclaredEvent, extensionIdOf } from "@intentic/extension-manifest";
import {
    EXTENSION_EVENTS_HEARTBEAT_MS,
    EXTENSION_EVENTS_KINDS_PARAM,
    EXTENSION_RUN_CLOSING_MAX,
    type ExtensionEvent,
    ExtensionDeclaredEventSchema,
    type ExtensionOwnSettings,
} from "@intentic/sandbox-contract/extension-protocol";
import type { Context } from "hono";
import { stream } from "hono/streaming";
import type { AppEnv } from "../../app-env.js";
import { callingExtension } from "../../auth/grants.js";
import type { Services } from "../../composition.js";
import { subscribeRefChanges } from "../../git/remote/ref-watch.js";
import { subscribeRepoChanges } from "../../workspace/watch/repo-watch.js";
import { subscribeUnwatchedWrites, subscribeWorkspaceChanges } from "../../workspace/watch/workspace-watch.js";
import { extensionSettingsDocument, type ExtensionSettings, onExtensionSettingsWritten, readAllExtensionSettings } from "../extension-settings.js";
import { type InstalledExtension, installedExtensions } from "../../capabilities/extension-inventory/installed-extensions.js";
import { defineRawRoutes } from "../../http/raw-route-server.js";
import { opt } from "../../opt.js";
import { subscribeCiFeed } from "../../seams/ci-feed-bus.js";
import type { DomainEventMap } from "../../seams/domain-events.js";
import { extensionThatStarted } from "./extension-conversations.js";
import { createExtensionDoors } from "./own-doors.js";
import { createExtensionSleepDoors } from "./own-sleep.js";

// What an extension's own code asks the daemon about itself (the contract's extension-protocol): its settings with
// their secret values, and one stream of what moved, its settings and the workspace, and (2026-11-26) the kinds its
// manifest declares in `permissions.events`: its own conversations' runs ending, whether any turn runs, and the CI feed. Every
// extension token reaches both without declaring them (extension-manifest's EXTENSION_OWN_ROUTES), and each answers only
// about the extension the token was minted for, resolved here again so the check holds on a loopback daemon where no
// grant middleware runs.

// The calling extension, or the refusal to answer with.
export const ownCaller = async (services: Services, c: Context<AppEnv>): Promise<InstalledExtension | Response> => {
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

// The declared kinds a stream asks for (`?kinds=run,activity`), or the refusal: a kind this build does not know, or one
// the manifest does not declare. None asked: none sent, which is what a runtime from before them gets.
const askedKinds = (c: Context<AppEnv>, extension: InstalledExtension): ReadonlySet<ExtensionDeclaredEvent> | Response => {
    const asked = (c.req.query(EXTENSION_EVENTS_KINDS_PARAM) ?? "").split(",").filter((kind) => kind !== "");
    const declared = declaredReachOf(extension.manifest.permissions).events;
    const kinds = new Set<ExtensionDeclaredEvent>();
    for (const kind of asked) {
        const known = ExtensionDeclaredEventSchema.safeParse(kind);
        if (!known.success) {
            return c.json({ error: `no event kind "${kind}": an extension may ask for ${ExtensionDeclaredEventSchema.options.join(", ")}` }, 400);
        }
        if (!declared.includes(known.data)) {
            return c.json({ error: `extension "${extension.id}" did not declare the event kind "${kind}": add it to permissions.events in its manifest` }, 403);
        }
        kinds.add(known.data);
    }
    return kinds;
};

// A settled run as the extension hears it.
const runFrame = (event: DomainEventMap["run.settled"]): ExtensionEvent => ({
    kind: "run",
    conversationId: event.conversationId,
    run: event.run,
    outcome: event.stopped === true ? "stopped" : event.failure === undefined ? "done" : "failed",
    ...opt("error", event.failure),
    closing: event.closing.slice(0, EXTENSION_RUN_CLOSING_MAX),
});

// How often whether a turn runs is read again besides the events: a spawned child's own turns start through the port's
// `run` and announce nothing (work-signal.ts reads the same way).
const ACTIVITY_POLL_MS = 10_000;

// Whether any agent turn runs in the sandbox, told to `send` now and again each time it flips; answers the stop. The
// question the maintenance extension's probe sweep asks before it measures anything (its src/server/probe-runner.ts),
// which the daemon asked itself while the sweep was its own.
const watchActivity = (services: Pick<Services, "conversations" | "events">, send: (live: boolean) => void): (() => void) => {
    const live = (): boolean => services.conversations.liveSessionIds().length > 0;
    let told = live();
    send(told);
    const look = (): void => {
        const now = live();
        if (now !== told) {
            told = now;
            send(now);
        }
    };
    // After the event has been handled, so the actor's own state already says whether the turn runs.
    const soon = (): void => {
        setTimeout(look, 0).unref();
    };
    const stops = [services.events.subscribe("run.started", soon), services.events.subscribe("run.settled", soon), services.events.subscribe("turn.finished", soon)];
    const poll = setInterval(look, ACTIVITY_POLL_MS);
    poll.unref();
    return () => {
        clearInterval(poll);
        for (const stop of stops) {
            stop();
        }
    };
};

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
        const kinds = askedKinds(c, extension);
        if (kinds instanceof Response) {
            return kinds;
        }
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
            const inOrder = serialLock();
            const recheck = (): void => {
                void inOrder(compare);
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
                // Runs ending in the conversations this extension started, and no other's.
                ...(kinds.has("run")
                    ? [
                          services.events.subscribe("run.settled", async (event) => {
                              if ((await extensionThatStarted(services.config.historyRoot, event.conversationId)) === identity) {
                                  send(runFrame(event));
                              }
                          }),
                      ]
                    : []),
            ];
            // (2026-11-26) Every CI feed frame as it is heard (seams/ci-feed-bus.ts), the same the feed's own stream sends.
            if (kinds.has("ci")) {
                stops.push(subscribeCiFeed((event) => send({ kind: "ci", event })));
            }
            send({ kind: "heartbeat" });
            if (kinds.has("activity")) {
                stops.push(watchActivity(services, (live) => send({ kind: "activity", live })));
            }
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

// What an extension's own code asks about itself (its settings with their secrets, its event stream) and the two doors
// its other declarations open (holding work, running a command). Every extension token reaches them undeclared in
// `permissions.daemon`; each answers only about the extension the token was minted for, and a door checks its own
// declaration.
export const extensionOwnRawRoutes = defineRawRoutes((services: Services) => {
    const extensionOwnRoutes = createExtensionOwnRoutes(services);
    const doors = createExtensionDoors(services, (c: Context<AppEnv>) => ownCaller(services, c));
    const sleep = createExtensionSleepDoors(services, (c: Context<AppEnv>) => ownCaller(services, c));
    return {
        "GET /extension/settings": extensionOwnRoutes.settings,
        "GET /extension/events": extensionOwnRoutes.events,
        "POST /extension/work/hold": doors.hold,
        "POST /extension/exec": doors.exec,
        "POST /extension/activity": doors.activity,
        // (2026-11-27) Hosted sleep (own-sleep.ts).
        "POST /extension/sleep/wake-url": sleep.wakeUrl,
        "GET /extension/sleep/boot": sleep.boot,
        "POST /extension/sleep/watch": sleep.watch,
        "POST /extension/sleep/ready": sleep.ready,
        "POST /extension/sleep/heard": sleep.heard,
    };
});
