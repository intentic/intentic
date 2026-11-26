import { join } from "node:path";
import { errnoCode, errorMessage } from "@intentic/base/errors";
import type { AutomationFire } from "@intentic/extension-api/runtime";
import { declaredReachOf, extensionIdOf } from "@intentic/extension-manifest";
import type { AutomationRun } from "@intentic/sandbox-contract/schemas/automations";
import { z } from "zod";
import { cachedEnabledExtensions } from "../../capabilities/contributions.js";
import type { ExtensionHost } from "../../capabilities/extension-inventory/installed-extensions.js";
import type { Services } from "../../composition.js";
import { opt } from "../../opt.js";
import { defineInFlight } from "../../seams/restart/in-flight.js";
import { defineDocument } from "../../store/evolution/documents.js";
import { openDocument } from "../../store/open-document.js";
import { fireRequestBody } from "./backend-fires.js";
import { BACKEND_HOST_HEADER } from "./backend-host-config.js";
import { backendDown } from "./extension-mcp.js";

// AN AUTOMATION THAT WAKES AN EXTENSION'S CODE (2026-11-26). An automation whose target is `{ kind: "extension" }` fires,
// after the scheduler's admission and holds (automations/fire/run-fire.ts), into the handler the extension's backend
// registered (`api.automations.onFire`) and its manifest declares (`permissions.fires`), through the backend host's
// `POST /fires/<id>` door: the host token alone reaches it, never a person's, a panel's or an agent's bearer, and only
// this module sends to it. The automation names the extension, and only that extension saves one naming itself
// (automations/automation-save.ts), so one extension never wakes another's code.
//
// A fire is tried once as it fires. One the backend cannot take now (the host restarting, the extension still
// activating, its handler not registered yet) is OWED here, under the history root, and tried again with backoff until
// it is taken, a day has passed, or the extension can never take it (switched off, removed, the handler undeclared). A
// daemon that stops meanwhile tries again at its next boot (bootstrap/restart/in-flight-kinds.ts); a fire the daemon died
// under before it was owed is the fire journal's to replay. While one fire of an automation is owed, a later one replaces
// it and counts it (`coalesced`): a clock that ticked twelve times while the backend was down wakes it once. A handler
// may be told a fire twice (taken, then the daemon died before writing that down): `id` is the same on every try.

const OwedFireSchema = z.object({
    id: z.string(),
    extension: z.string(),
    handler: z.string(),
    automationId: z.string(),
    firedAt: z.number(),
    coalesced: z.number(),
    payload: z.string().optional(),
    observed: z.string().optional(),
    prompt: z.string(),
    // When it was last owed (a later fire of the same automation owes it again), and when it is next tried.
    owedAt: z.number(),
    nextAt: z.number(),
    attempts: z.number(),
    lastError: z.string().optional(),
});
type OwedFire = z.infer<typeof OwedFireSchema>;

export const extensionFiresDocument = defineDocument({
    root: "history",
    path: "extension-fires-owed.json",
    // Fires owed to an extension's backend, by automation, kept until it takes them; they travel with the automations.
    portability: "carry",
    granularity: "record",
    schema: OwedFireSchema,
});

type Owed = Readonly<Record<string, OwedFire>>;

// How long a fire is owed before it is given up: a clock's fire that old has been overtaken by the clock.
export const OWED_FIRE_TTL_MS = 24 * 60 * 60_000;
// How long the door may take: a handler that does more holds work (`api.work.hold`) and returns.
const DOOR_DEADLINE_MS = 10 * 60_000;
const BACKOFF_FIRST_MS = 2_000;
// Short beside a channel reply's: a backend that is back should hear its clock within a minute.
const BACKOFF_MAX_MS = 60_000;

const backoffAfter = (attempts: number): number => Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** Math.max(0, attempts - 1));

export type FireDeps = Pick<Services, "extensionBackend" | "automations" | "config" | "logger"> & ExtensionHost;

const owedFile = (services: Pick<Services, "config">) =>
    openDocument(extensionFiresDocument, join(services.config.historyRoot, extensionFiresDocument.path), { fallback: (): Owed => ({}) });

/** Every fire owed now. */
export const owedFires = async (services: Pick<Services, "config">): Promise<readonly OwedFire[]> => Object.values(await owedFile(services).read());

// What one try came to: taken; taken and thrown by the handler; not now; or never.
export type FireTry =
    | { readonly kind: "taken" }
    | { readonly kind: "threw"; readonly error: string }
    | { readonly kind: "later"; readonly why: string }
    | { readonly kind: "never"; readonly why: string };

// The extension a fire is for, by its identity, while it is enabled, has a backend, and declares the handler.
const resolveTarget = async (deps: FireDeps, extension: string, handler: string): Promise<{ readonly id: string } | { readonly never: string }> => {
    const found = (await cachedEnabledExtensions(deps)).find((each) => extensionIdOf(each.manifest) === extension);
    if (found === undefined) {
        return { never: `no enabled extension "${extension}" to wake` };
    }
    if (found.manifest.server === undefined) {
        return { never: `extension "${extension}" has no backend to wake` };
    }
    if (!declaredReachOf(found.manifest.permissions).fires.includes(handler)) {
        return { never: `extension "${extension}" does not declare a "${handler}" handler in permissions.fires` };
    }
    return { id: found.id };
};

const fireOf = (owed: OwedFire): AutomationFire => ({
    id: owed.id,
    automationId: owed.automationId,
    handler: owed.handler,
    firedAt: owed.firedAt,
    coalesced: owed.coalesced,
    ...opt("payload", owed.payload),
    ...opt("observed", owed.observed),
    prompt: owed.prompt,
});

// How the door's answer, or its silence, reads.
const triedBy = async (answered: Response): Promise<FireTry> => {
    if (answered.ok) {
        return { kind: "taken" };
    }
    const text = (await answered.text()).slice(0, 300);
    if (answered.status === 500) {
        return { kind: "threw", error: text };
    }
    // A body the door could not read is this build's own mistake, and trying it again changes nothing.
    return answered.status === 400 ? { kind: "never", why: `the backend could not read it: ${text}` } : { kind: "later", why: `HTTP ${answered.status}: ${text}` };
};

/** One try of one fire through the backend host's door. */
export const tryFire = async (deps: FireDeps, owed: OwedFire): Promise<FireTry> => {
    const target = await resolveTarget(deps, owed.extension, owed.handler);
    if ("never" in target) {
        return { kind: "never", why: target.never };
    }
    const backend = deps.extensionBackend.proxyTarget();
    if (backend === undefined) {
        return { kind: "later", why: backendDown(deps.extensionBackend) };
    }
    try {
        return await triedBy(
            await fetch(`http://127.0.0.1:${backend.port}/fires/${encodeURIComponent(target.id)}`, {
                method: "POST",
                headers: { "content-type": "application/json", [BACKEND_HOST_HEADER]: backend.hostToken },
                body: fireRequestBody(fireOf(owed)),
                signal: AbortSignal.timeout(DOOR_DEADLINE_MS),
            }),
        );
    } catch (error) {
        // Past the deadline the handler may still be at it, and a second try would run it twice beside itself.
        if (error instanceof Error && error.name === "TimeoutError") {
            return { kind: "threw", error: `its handler did not answer within ${DOOR_DEADLINE_MS / 60_000} minutes` };
        }
        const refused = errnoCode(error instanceof Error ? error.cause : undefined) === "ECONNREFUSED";
        return { kind: "later", why: refused ? "its backend host was not listening" : `its backend host did not answer (${errorMessage(error)})` };
    }
};

// The run an outcome records on the automation, for a fire tried after the one that fired it.
const lateRun = (owed: OwedFire, outcome: Exclude<FireTry, { kind: "later" }> | { readonly kind: "expired" }, now: number): AutomationRun => {
    const fired = new Date(owed.firedAt).toISOString();
    const standing = owed.coalesced > 0 ? ` It stood for ${owed.coalesced} earlier fire(s) made while the backend was down.` : "";
    switch (outcome.kind) {
        case "taken":
            return { at: now, outcome: "completed", detail: `Handed to ${owed.extension}'s "${owed.handler}" handler once its backend was back (fired ${fired}).${standing}` };
        case "threw":
            return { at: now, outcome: "error", detail: `${owed.extension}'s "${owed.handler}" handler failed: ${outcome.error}` };
        case "never":
            return { at: now, outcome: "error", detail: `The fire of ${fired} was given up: ${outcome.why}.` };
        case "expired":
            return {
                at: now,
                outcome: "error",
                detail: `The fire of ${fired} was given up: ${owed.extension}'s backend did not take it for a day${owed.lastError === undefined ? "" : ` (last: ${owed.lastError})`}.`,
            };
    }
};

// One pass over what is owed: each due fire tried, what ended recorded on its automation, what did not tried again
// later. Written back over the file as it now stands, so a fire owed meanwhile is kept. Answers when the next falls due.
const drainPass = async (deps: FireDeps, now: number): Promise<number | undefined> => {
    const ended = new Map<string, { readonly owed: OwedFire; readonly run: AutomationRun }>();
    const retry = new Map<string, Pick<OwedFire, "attempts" | "nextAt" | "lastError">>();
    for (const owed of await owedFires(deps)) {
        if (now - owed.owedAt > OWED_FIRE_TTL_MS) {
            ended.set(owed.id, { owed, run: lateRun(owed, { kind: "expired" }, now) });
            continue;
        }
        if (owed.nextAt > now) {
            continue;
        }
        const tried = await tryFire(deps, owed);
        if (tried.kind === "later") {
            const attempts = owed.attempts + 1;
            retry.set(owed.id, { attempts, nextAt: Date.now() + backoffAfter(attempts), lastError: tried.why });
        } else {
            ended.set(owed.id, { owed, run: lateRun(owed, tried, Date.now()) });
        }
    }
    const left = await owedFile(deps).update((owed) =>
        Object.fromEntries(
            Object.entries(owed).flatMap(([automationId, entry]) => {
                if (ended.has(entry.id)) {
                    return [];
                }
                const again = retry.get(entry.id);
                return [[automationId, again === undefined ? entry : { ...entry, ...again }]];
            }),
        ),
    );
    for (const { owed, run } of ended.values()) {
        await deps.automations.recordRun(owed.automationId, run).catch((error: Error) => deps.logger.warn({ err: error, automation: owed.automationId }, "owed fire: its run not recorded"));
    }
    const due = Object.values(left).map((entry) => entry.nextAt);
    return due.length === 0 ? undefined : Math.min(...due);
};

// One drain per daemon, found by its automations store as the channel replies' is: a kick during a pass runs one more
// pass after it, and a timer wakes it when the next owed fire falls due.
interface Drainer {
    running: Promise<void> | undefined;
    again: boolean;
    timer: ReturnType<typeof setTimeout> | undefined;
}
const drainers = new WeakMap<object, Drainer>();
const drainerOf = (deps: Pick<Services, "automations">): Drainer => {
    const found = drainers.get(deps.automations);
    if (found !== undefined) {
        return found;
    }
    const made: Drainer = { running: undefined, again: false, timer: undefined };
    drainers.set(deps.automations, made);
    return made;
};

/** Tries what is owed now and keeps trying until nothing is. Never rejects: a failed pass is logged and tried again. */
export const drainOwedFires = (deps: FireDeps): Promise<void> => {
    const drainer = drainerOf(deps);
    if (drainer.running !== undefined) {
        drainer.again = true;
        return drainer.running;
    }
    clearTimeout(drainer.timer);
    drainer.timer = undefined;
    const run = async (): Promise<void> => {
        let due: number | undefined;
        do {
            drainer.again = false;
            due = await drainPass(deps, Date.now()).catch((error: Error) => {
                deps.logger.warn({ err: error }, "owed extension fires: a pass failed, tried again shortly");
                return Date.now() + BACKOFF_FIRST_MS;
            });
        } while (drainer.again);
        drainer.running = undefined;
        if (due !== undefined) {
            drainer.timer = setTimeout(() => void drainOwedFires(deps), Math.max(0, due - Date.now()));
            drainer.timer.unref();
        }
    };
    drainer.running = run();
    return drainer.running;
};

// A fire as the automation made it, before it is tried.
export interface ExtensionFireAsked {
    // The fire's own id, the same however often it is tried (its journal row's, when it has one).
    readonly id: string;
    readonly extension: string;
    readonly handler: string;
    readonly automationId: string;
    readonly prompt: string;
    readonly payload?: string | undefined;
    readonly observed?: string | undefined;
}

// What firing came to, as the automation's run records it.
export type ExtensionFireOutcome =
    | { readonly outcome: "completed"; readonly detail: string }
    | { readonly outcome: "carried"; readonly detail: string }
    | { readonly outcome: "error"; readonly detail: string };

/**
 * Fires an automation into its extension's handler: tried once now, and owed when the backend cannot take it yet. The
 * automations engine calls this alone, after the fire passed its admission and holds.
 */
export const fireExtension = async (deps: FireDeps, asked: ExtensionFireAsked, now = Date.now()): Promise<ExtensionFireOutcome> => {
    const fire: OwedFire = { ...asked, firedAt: now, coalesced: 0, owedAt: now, nextAt: now, attempts: 0 };
    const tried = await tryFire(deps, fire);
    switch (tried.kind) {
        case "taken":
            return { outcome: "completed", detail: `Handed to ${asked.extension}'s "${asked.handler}" handler.` };
        case "threw":
            return { outcome: "error", detail: `${asked.extension}'s "${asked.handler}" handler failed: ${tried.error}` };
        case "never":
            return { outcome: "error", detail: `Nothing to wake: ${tried.why}.` };
        case "later":
            break;
    }
    await owedFile(deps).update((owed) => {
        const earlier = owed[asked.automationId];
        // The same fire again (replayed after a restart) stands for what it stood for; a new one for the earlier too.
        const coalesced = earlier === undefined ? 0 : earlier.id === fire.id ? earlier.coalesced : earlier.coalesced + 1;
        return { ...owed, [asked.automationId]: { ...fire, coalesced, nextAt: Date.now() + BACKOFF_FIRST_MS, attempts: 1, lastError: tried.why } };
    });
    void drainOwedFires(deps);
    return { outcome: "carried", detail: `${asked.extension}'s backend could not take it now (${tried.why}); it is kept and handed over once it can.` };
};

// What an earlier daemon still owed when it stopped: tried again once the gate opens, all of it at once, since the backoff
// it waited out belonged to the daemon that stopped.
export const owedFiresInFlight = defineInFlight({
    name: "extension fires owed",
    read: async (services: Pick<Services, "config">) => owedFires(services),
    recover: async (services: Services) => {
        await owedFile(services).update((owed) => Object.fromEntries(Object.entries(owed).map(([automationId, entry]) => [automationId, { ...entry, nextAt: 0 }])));
        await drainOwedFires(services);
    },
});
