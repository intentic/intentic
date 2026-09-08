import { errorMessage } from "@intentic/base/errors";
import {
    endpointProvider,
    type ModelChoice,
    type ModelPin,
    modelPinKey,
    type ModelRole,
    type ModelSource,
    NATIVE_PROVIDERS,
    type NativeProvider,
    readyChain,
} from "@intentic/sandbox-contract";
import type { Services } from "../../composition.js";
import { endpointConfigOf } from "../../endpoints/local-model.js";
import { mentionsSpentAllowance } from "../providers/failure-sentences.js";
import { adapterFor } from "../providers/adapter-registry.js";
import { harnessReadyProviders } from "../providers/harness-credentials.js";
import { type RoleAsk, readRoleAnswer, UnusableAnswerError } from "./role-answer.js";
import { rungLimit, spentRung } from "./role-model-quota.js";
import { RoleModelUnsetError } from "./role-model-unset.js";

// Resolves what a role's chain actually runs on (connected accounts, catalogs, the walk itself); the contract
// (model-pins.ts) decides the order, this file supplies the facts and executes it. Every ask names its own role and
// reads that role's list (model-roles.ts) rather than one shared chain.

// One provider's catalog, from the same table `/providers/{provider}/models` serves. A read failure degrades to an
// empty list rather than failing the whole resolution.
const catalogOf = async (services: Services, provider: NativeProvider): Promise<readonly string[]> => {
    const catalog = await services.providerCatalogs[provider].models().catch(() => undefined);
    return catalog?.models.map((model) => model.id) ?? [];
};

// Local-model endpoints as sources: ready simply by being installed, so there is no separate credential to check. One
// with nothing published just never wins.
const endpointSources = async (services: Services): Promise<ModelSource[]> => {
    const endpoints = (await services.capabilities.list()).flatMap((capability) => {
        const config = endpointConfigOf(capability);
        return config === undefined ? [] : [{ id: capability.id, config }];
    });
    return Promise.all(
        endpoints.map(async ({ id, config }) => ({
            provider: endpointProvider(id),
            ready: true,
            models: await services.endpointModels
                .models(id, config)
                .then((catalog) => catalog.models.map((model) => model.id))
                .catch(() => []),
        })),
    );
};

// Every native provider plus every configured endpoint, whether each can run, and what it publishes; catalogs load
// concurrently since they are independent cached reads.
const modelSources = async (services: Services): Promise<ModelSource[]> => {
    const ready = await harnessReadyProviders(services);
    const [native, endpoints] = await Promise.all([
        Promise.all(
            NATIVE_PROVIDERS.map(async (provider) => ({
                provider,
                ready: ready[provider],
                // Skip the catalog read for a provider that cannot run; it will never be picked anyway.
                models: ready[provider] ? await catalogOf(services, provider) : [],
            })),
        ),
        endpointSources(services),
    ]);
    return [...native, ...endpoints];
};

// Whether this role has any models configured, checked against the stored list rather than the resolved chain, for a
// caller that must never start the walk at all.
export const roleModelIsSet = async (services: Services, role: ModelRole): Promise<boolean> =>
    ((await services.sandboxSettings.get()).modelRoles[role] ?? []).length > 0;

// A model that was asked and refused, with the reason it gave; carried up because a fully spent chain is a message only
// this walk can report.
export interface RoleModelRefusal {
    readonly choice: ModelChoice;
    readonly reason: string;
}

export interface RoleModelAnswer<T> {
    // Already unwrapped and judged usable by the ask's own contract; nothing left here for the caller to check.
    readonly value: T;
    readonly choice: ModelChoice;
    // Every rung ahead of `choice` that refused, in the order it was tried; empty on the ordinary path.
    readonly skipped: readonly RoleModelRefusal[];
}

// One rung's live state, for a caller that wants to show the walk in progress; `asking` is in flight, the rest are
// settled with their cost and, for a refusal, its reason.
export interface RoleModelAttempt {
    readonly choice: ModelChoice;
    readonly status: "asking" | "answered" | "refused" | "skipped";
    // When this rung started, the base a ticking duration is measured from; absent for `skipped`.
    readonly at?: number;
    readonly ms?: number;
    readonly reason?: string;
}

// Called with the whole attempt list after each transition, so a consumer holds a snapshot rather than replaying
// events. A listener's throw must not kill the walk it only watches.
export type RoleModelProgress = (attempts: readonly RoleModelAttempt[]) => void;

// Every throw this walk catches already carries a user-facing sentence; this only keeps a non-Error from becoming
// "[object Object]" in the report.
const refusalText = (error: unknown): string => errorMessage(error);

// In-memory memo: a spent allowance lasts REFUSED_FOR_MS; any other refusal lasts OTHER_REFUSED_FOR_MS.
export const REFUSED_FOR_MS = 2 * 60 * 60 * 1000;
export const OTHER_REFUSED_FOR_MS = 10 * 60 * 1000;

interface Memo {
    readonly at: number;
    readonly until: number;
    readonly reason: string;
    readonly kind: "limit" | "other";
}

const refusals = new Map<string, Memo>();

const remember = (key: string, reason: string, now: number): void => {
    const kind = mentionsSpentAllowance(reason) ? "limit" : "other";
    refusals.set(key, { at: now, until: now + (kind === "limit" ? REFUSED_FOR_MS : OTHER_REFUSED_FOR_MS), reason, kind });
};

// What this rung last refused with, while the memo still stands; undefined means ask it (expired, or never refused).
const cooling = (choice: ModelChoice, now: number): Memo | undefined => {
    const held = refusals.get(modelPinKey(choice));
    return held !== undefined && held.until > now ? held : undefined;
};

// Runtime is decided by adapterFor/capabilitiesOf, never here, so a provider that refuses a harness always lands on its
// own regardless of the pin. Effort, thinking and fast ride along unchanged.
const askRung = async (services: Services, pin: ModelPin, prompt: string, signal: AbortSignal): Promise<string> => {
    const adapter = adapterFor(pin.provider, pin.harness ?? `claude-code`);
    if (adapter.oneShot === undefined) {
        throw new Error(`${adapter.runtime} runs no helper, so there is nothing to ask it one line with.`);
    }
    return adapter.oneShot(services, {
        provider: pin.provider,
        prompt,
        cwd: services.workspace.root,
        model: pin.model,
        ...(pin.effort === undefined ? {} : { effort: pin.effort }),
        ...(pin.thinking === undefined ? {} : { thinking: pin.thinking }),
        ...(pin.fast === undefined ? {} : { fast: pin.fast }),
        signal,
    });
};

// Every refusal (allowance, credential, outage, or a wrong-shaped reply) is stepped over the same way, asking the next
// rung; a user cancel stops the walk outright.
export interface RoleModelOptions {
    // Caller-supplied snapshot of this role's list instead of a fresh read; absent means read settings now.
    readonly pins?: readonly ModelPin[] | undefined;
    readonly onProgress?: RoleModelProgress | undefined;
}

export const askRoleModel = async <T>(
    services: Services,
    role: ModelRole,
    ask: RoleAsk<T>,
    signal: AbortSignal,
    options: RoleModelOptions = {},
): Promise<RoleModelAnswer<T>> => {
    const onProgress = options.onProgress;
    // An empty list means the job is off; refuse before touching a catalog, unlike accounts that are simply gone.
    const pinned = options.pins ?? (await services.sandboxSettings.get()).modelRoles[role] ?? [];
    if (pinned.length === 0) {
        throw new RoleModelUnsetError(role);
    }
    const chain = readyChain(await modelSources(services), pinned);
    if (chain.length === 0) {
        throw new Error(`Every model set for this job names an account this sandbox no longer has: set one in Sandbox ▸ Agent ▸ Models.`);
    }
    // Resent after every beat; wrapped so a throwing listener can't break the walk it is only watching.
    const attempts: RoleModelAttempt[] = [];
    const tell = (): void => {
        try {
            onProgress?.([...attempts]);
        } catch {
            // A broken listener forfeits its updates, nothing else.
        }
    };
    const now = Date.now();
    const skipped: RoleModelRefusal[] = [];
    // Reason not to ask this rung: the memo from its last refusal, or (if unheld) the account reading. A reading with
    // room measured after a `limit` memo's timestamp overrides it; other refusal kinds are unaffected.
    const stepOverReason = async (choice: ModelChoice): Promise<string | undefined> => {
        const held = cooling(choice, now);
        if (held?.kind === `other`) {
            return held.reason;
        }
        if (held === undefined) {
            return (await spentRung(services, choice, now))?.reason;
        }
        const limit = await rungLimit(services, choice);
        if (limit !== undefined && limit.withHeadroom > 0 && (limit.roomMeasuredAt ?? 0) > held.at) {
            refusals.delete(modelPinKey(choice));
            return undefined;
        }
        return held.reason;
    };
    // One pass over the chain; `honourSkips` picks between the two calls below. `asked` tells the caller whether
    // anything was attempted, since a chain skipped entirely and one refused entirely both end with no answer.
    const walk = async (honourSkips: boolean): Promise<{ answer?: RoleModelAnswer<T>; asked: boolean }> => {
        // Rebuilt, not appended: a second pass retracts the first's skips rather than reporting each rung twice.
        attempts.length = 0;
        skipped.length = 0;
        let asked = false;
        for (const choice of chain) {
            // Stepped over without asking, reported with the reason that stood in the way.
            const stepOver = honourSkips ? await stepOverReason(choice) : undefined;
            if (stepOver !== undefined) {
                skipped.push({ choice, reason: stepOver });
                attempts.push({ choice, status: `skipped`, reason: stepOver });
                tell();
                continue;
            }
            asked = true;
            // Every rung is timed and named as it is spent, the only way to see which model made a call slow.
            const from = Date.now();
            const spent = (): number => Date.now() - from;
            const key = modelPinKey(choice);
            // Reported before the wait, not after, so a listener can show which model is currently taking the time.
            attempts.push({ choice, status: `asking`, at: from });
            tell();
            // Replaces the in-flight entry in place; one rung is one entry in the timeline.
            const settle = (attempt: RoleModelAttempt): void => {
                attempts[attempts.length - 1] = attempt;
                tell();
            };
            try {
                // A credential failing at resolution is the same dead end as one failing outright.
                const text = await askRung(services, choice, ask.prompt, signal);
                // Reply is validated here, not by the caller, so a bad-shaped answer is stepped over like a refusal.
                const value = readRoleAnswer(ask.answer, text);
                // Clears any memo: an answer proves whatever this rung refused for before is over.
                refusals.delete(key);
                services.perf.record("role.model", spent(), { role, provider: choice.provider, model: choice.model });
                settle({ choice, status: `answered`, at: from, ms: spent() });
                return { answer: { value, choice, skipped }, asked };
            } catch (error) {
                if (signal.aborted) {
                    // A user cancel earns no memo: the next call must ask this rung as if nothing happened.
                    throw error;
                }
                services.perf.record("role.model", spent(), { role, provider: choice.provider, model: choice.model }, true);
                // An unusable reply earns no memo: a bad sample, not a lasting condition, unlike other refusals.
                if (!(error instanceof UnusableAnswerError)) {
                    remember(key, refusalText(error), Date.now());
                }
                services.logger.debug({ err: error, model: choice.model }, "role model: refused, trying the next in the chain");
                skipped.push({ choice, reason: refusalText(error) });
                settle({ choice, status: `refused`, at: from, ms: spent(), reason: refusalText(error) });
            }
        }
        return { asked };
    };

    const walked = await walk(true);
    if (walked.answer !== undefined) {
        return walked.answer;
    }
    // Memo or quota may skip a rung, never be why nothing is asked at all: a stale one retries the whole chain.
    if (!walked.asked) {
        const everything = await walk(false);
        if (everything.answer !== undefined) {
            return everything.answer;
        }
    }
    throw new Error(skipped.map((refusal) => `${refusal.choice.model}: ${refusal.reason}`).join(`; `));
};
