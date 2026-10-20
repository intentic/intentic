import { errorMessage } from "@intentic/base/errors";
import { endpointProvider } from "@intentic/sandbox-contract/models/agent-catalog";
import { type ModelChoice, modelPinKey, type ModelSource, readyChain } from "@intentic/sandbox-contract/models/model-pins";
import type { ModelPin } from "@intentic/sandbox-contract/schemas/agent";
import type { ModelRole } from "@intentic/sandbox-contract/models/model-roles";
import { NATIVE_PROVIDERS, type NativeProvider } from "@intentic/sandbox-contract/models/provider-specs";
import { ladderIsEmpty, ladderPins, roleLadder, type SetupLadder } from "@intentic/sandbox-contract/models/model-setups";
import type { Services } from "../../composition.js";
import { endpointConfigOf } from "../../endpoints/local-model.js";
import { mentionsSpentAllowance } from "../../engines/failure-sentences.js";
import { type DeclaredWindow, declaredWindow, helperOverflow, helperPromptRoom } from "../prompt/window/context-budget.js";
import { type RoleAsk, readRoleAnswer, UnusableAnswerError } from "../../engines/role-answer.js";
import { rungCapacity, spentRung } from "./role-model-quota.js";
import { RoleModelUnsetError } from "../../seams/role-model-unset.js";
import { runSealedRequest } from "../run/sealed/sealed-request.js";
import { opt } from "../../opt.js";
import { AgentDomainRefusedError, assertAgentExecutionContext, type AgentExecutionContext } from "../../workload/agent-execution.js";
import { createRepeatGate } from "../../logs/repeat-gate.js";

// Resolves what a role's chain actually runs on (connected accounts, catalogs, the walk itself); the contract
// (model-setups.ts, model-pins.ts) decides the setup and the order, this file supplies the facts and executes it. Every
// ask names its own role and reads that role's setup rather than one shared chain.

// One provider's catalog, from the same table `/providers/{provider}/models` serves, less what cannot run a turn: a
// preset setup is worked out from it and feeds whole sessions too. A read failure degrades to an empty list rather than
// failing the whole resolution.
const catalogOf = async (services: Services, provider: NativeProvider): Promise<readonly string[]> => {
    const catalog = await services.providerCatalogs[provider].models().catch(() => undefined);
    return catalog?.models.filter((model) => model.helperOnly === undefined).map((model) => model.id) ?? [];
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
    const ready = await services.providerReadiness();
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

// What a setup runs on right now: a written list as written, a preset worked out from what is connected. Catalogs are
// read only for a preset, the one ladder that needs them.
export const ladderPinsNow = async (services: Services, ladder: SetupLadder): Promise<readonly ModelPin[]> =>
    ladder.kind === "pins" ? ladder.pins : ladderPins(ladder, await modelSources(services));

// Whether this role has any models to run on, read off its setup rather than the resolved chain, for a caller that must
// never start the walk at all.
export const roleModelIsSet = async (services: Services, role: ModelRole): Promise<boolean> =>
    (await ladderPinsNow(services, roleLadder(await services.sandboxSettings.get(), role))).length > 0;

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

// A role whose whole chain failed (a commit subject, a title, a judge's verdict) handed the error to whoever asked and
// logged nothing, so a commit box that kept failing on Composer had no line to explain it. The walk's outcome is logged
// here, for every role at once: a warn when nothing answered, with each rung's refusal; an info when an answer came only
// after rungs refused. Gated per role, so a job retried every minute on a dead chain writes one line an hour plus a count.
const roleOutcomes = createRepeatGate();

// One rung as the outcome line names it; a reason is the provider's sentence, clipped so a pasted body cannot flood it.
const REASON_CHARS = 300;
const stepOf = (attempt: RoleModelAttempt): Record<string, unknown> => ({
    provider: attempt.choice.provider,
    model: attempt.choice.model,
    status: attempt.status,
    ...(attempt.reason === undefined ? {} : { reason: attempt.reason.slice(0, REASON_CHARS) }),
});

// What each rung of the chain will accept, resolved once before the walk rather than per ask: the walk runs twice when
// a memo skipped everything, and two reads could disagree across a catalog refresh between them. A native provider
// publishes no window and resolves to undefined, which reads as unmeasured everywhere below.
const chainWindows = async (services: Services, chain: readonly ModelChoice[]): Promise<Map<string, DeclaredWindow | undefined>> =>
    new Map(
        await Promise.all(
            chain.map(async (choice): Promise<[string, DeclaredWindow | undefined]> => [
                modelPinKey(choice),
                // Unknown rather than fatal: a catalog that cannot be read must not stop the job. Logged rather than
                // silent, because "unknown window" is also what a BUG here looks like, and a quiet one reads as a
                // helper that simply never checks.
                await declaredWindow(services, choice.provider, choice.model).catch((error: unknown) => {
                    services.logger.debug({ err: error, model: choice.model }, "role model: could not read this rung's window, treating it as unknown");
                    return undefined;
                }),
            ]),
        ),
    );

// The prompt as this rung would receive it: built to its room when the ask can size itself, taken whole when it cannot.
const promptFor = <T>(ask: RoleAsk<T>, room: number): string => (typeof ask.prompt === `function` ? ask.prompt(room) : ask.prompt);

// One rung asked as a sealed request (agent/run/sealed/sealed-request.ts), on the same arm, loop, privacy shield and
// failure records a turn on that model would meet. Runtime is decided by the adapter table/capabilitiesOf, never here,
// so a provider that refuses a harness always lands on its own regardless of the pin. Effort, thinking and fast ride
// along unchanged. The issued execution context rides with it: the request runs in that admitted view or refuses.
const askRung = (
    services: Services,
    execution: AgentExecutionContext,
    pin: ModelPin,
    prompt: string,
    signal: AbortSignal,
    conversationId: string | undefined,
): Promise<string> => {
    assertAgentExecutionContext(execution);
    return runSealedRequest(services, {
        execution,
        provider: pin.provider,
        harness: pin.harness ?? `claude-code`,
        prompt,
        model: pin.model,
        ...opt("effort", pin.effort),
        ...opt("thinking", pin.thinking),
        ...opt("fast", pin.fast),
        ...opt("conversationId", conversationId),
        signal,
    });
};

// Every refusal (allowance, credential, outage, or a wrong-shaped reply) is stepped over the same way, asking the next
// rung; a user cancel stops the walk outright.
export interface RoleModelOptions {
    // Caller-supplied snapshot of this role's setup instead of a fresh read; absent means read settings now.
    readonly ladder?: SetupLadder | undefined;
    readonly onProgress?: RoleModelProgress | undefined;
    // The conversation the job is for, where it has one (a land's commit subject, a chat's title): a provider the owner
    // let read that conversation reads this job about it too.
    readonly conversationId?: string | undefined;
}

export const askRoleModel = async <T>(
    services: Services,
    execution: AgentExecutionContext,
    role: ModelRole,
    ask: RoleAsk<T>,
    signal: AbortSignal,
    options: RoleModelOptions = {},
): Promise<RoleModelAnswer<T>> => {
    assertAgentExecutionContext(execution);
    const onProgress = options.onProgress;
    // An emptied setup means the job is off; refuse before touching a catalog, unlike accounts that are simply gone. A
    // preset that nothing connected offers a model for is off the same way.
    const ladder = options.ladder ?? roleLadder(await services.sandboxSettings.get(), role);
    if (ladderIsEmpty(ladder)) {
        throw new RoleModelUnsetError(role);
    }
    const sources = await modelSources(services);
    const pinned = ladderPins(ladder, sources);
    if (pinned.length === 0) {
        throw new RoleModelUnsetError(role);
    }
    const chain = readyChain(sources, pinned);
    if (chain.length === 0) {
        throw new Error(`Every model set for this job names an account this sandbox no longer has: set one in Sandbox ▸ Agent ▸ Models.`);
    }
    // What each rung will accept, read once for both passes of the walk below.
    const windows = await chainWindows(services, chain);
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
        const capacity = await rungCapacity(services, choice);
        if (capacity?.kind === `serving` && (capacity.roomMeasuredAt ?? 0) > held.at) {
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
            // Built for THIS rung's window, since the next one down the chain may have a different one.
            const declared = windows.get(modelPinKey(choice));
            const room = helperPromptRoom(declared);
            const prompt = promptFor(ask, room);
            // A prompt the rung cannot hold is stepped over here rather than sent and refused. Sending it costs a
            // provider round trip, earns a ten-minute memo (`remember` below), and comes back as the server's own 400
            // instead of the two numbers and the two switches that change the answer — so the same job reads as
            // intermittent rather than as mis-sized. Never honourSkips-gated: this one is a fact about the request,
            // not a memo that can go stale.
            const overflow = helperOverflow(prompt, room, declared);
            if (overflow !== undefined) {
                skipped.push({ choice, reason: overflow });
                attempts.push({ choice, status: `skipped`, reason: overflow });
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
                const text = await askRung(services, execution, choice, prompt, signal, options.conversationId);
                // Reply is validated here, not by the caller, so a bad-shaped answer is stepped over like a refusal.
                const value = readRoleAnswer(ask.answer, text);
                // Clears any memo: an answer proves whatever this rung refused for before is over.
                refusals.delete(key);
                services.perf.record("role.model", spent(), { role, provider: choice.provider, model: choice.model });
                settle({ choice, status: `answered`, at: from, ms: spent() });
                return { answer: { value, choice, skipped }, asked };
            } catch (error) {
                if (signal.aborted || error instanceof AgentDomainRefusedError) {
                    // Cancellation or execution refusal is not a provider's failure: no memo, retry or next rung.
                    throw error;
                }
                services.perf.record("role.model", spent(), { role, provider: choice.provider, model: choice.model }, true);
                // An unusable reply earns no memo: a bad sample, not a lasting condition, unlike other refusals.
                if (!(error instanceof UnusableAnswerError)) {
                    remember(key, refusalText(error), Date.now());
                }
                services.logger.debug({ err: error, role, model: choice.model }, "role model: refused, trying the next in the chain");
                skipped.push({ choice, reason: refusalText(error) });
                settle({ choice, status: `refused`, at: from, ms: spent(), reason: refusalText(error) });
            }
        }
        return { asked };
    };

    const context = options.conversationId === undefined ? {} : { conversationId: options.conversationId };
    const answered = (answer: RoleModelAnswer<T>): RoleModelAnswer<T> => {
        const outage = roleOutcomes.clear(`${role}:failed`);
        const refused = attempts.filter((attempt) => attempt.status === `refused`);
        if (outage !== undefined) {
            services.logger.info(
                { role, ...context, provider: answer.choice.provider, model: answer.choice.model, repeated: outage.repeated },
                `role model: ${role} answered again, on ${answer.choice.model}`,
            );
        } else if (refused.length > 0) {
            const verdict = roleOutcomes.check(`${role}:fallback`, attempts.map((attempt) => `${modelPinKey(attempt.choice)}=${attempt.status}`).join(` `));
            if (verdict.log) {
                services.logger.info(
                    { role, ...context, provider: answer.choice.provider, model: answer.choice.model, steps: attempts.map(stepOf), repeated: verdict.repeated },
                    `role model: ${role} answered on ${answer.choice.model} after ${refused.length} ${refused.length === 1 ? `model` : `models`} refused`,
                );
            }
        }
        return answer;
    };

    const walked = await walk(true);
    if (walked.answer !== undefined) {
        return answered(walked.answer);
    }
    // Memo or quota may skip a rung, never be why nothing is asked at all: a stale one retries the whole chain.
    if (!walked.asked) {
        const everything = await walk(false);
        if (everything.answer !== undefined) {
            return answered(everything.answer);
        }
    }
    const verdict = roleOutcomes.check(`${role}:failed`, attempts.map((attempt) => `${modelPinKey(attempt.choice)}: ${attempt.reason ?? attempt.status}`).join(`; `));
    if (verdict.log) {
        services.logger.warn(
            { role, ...context, steps: attempts.map(stepOf), repeated: verdict.repeated },
            `role model: ${role} failed on every model in its chain`,
        );
    }
    throw new Error(skipped.map((refusal) => `${refusal.choice.model}: ${refusal.reason}`).join(`; `));
};
