import type { ActivityEvent } from "@intentic/sandbox-contract/schemas/activity";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import { type AgentProvider, AgentProviderSchema } from "@intentic/sandbox-contract/schemas/agent";
import { KeyedProviderSchema } from "@intentic/sandbox-contract/schemas/providers/provider-subscriptions";
import type { ProviderRefusal, UsageWindow } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import { answerCovers, type ServiceFacts } from "@intentic/sandbox-contract/models/plan-pools";
import type { Services } from "../../../composition.js";
import { recordProviderSuccess } from "../../providers/provider-health.js";
import { opt } from "../../../opt.js";
import type { TurnInput } from "../../../seams/turn-starter.js";
import type { FailureWrite } from "./classify-failure.js";
import type { Attribution } from "./frame-decorators.js";
import { accountFactsOf } from "../../../usage/serviceability/serviceability.js";
import { ACCOUNT_WIDE } from "../../../usage/observed-limits.js";
import { FAN_OUT } from "../../subagents/fan-out-governor.js";
import { runOutOf } from "../../../usage/run-outs.js";
import { checkAnswered, readingKeys } from "../../../usage/drift/contradictions.js";
import { runningOn } from "../turn/turn-pulse.js";

// The writes a turn's frames cause beyond the stream: its activity rows, the refusals its first answer disproves, the
// allowance reading it carried, and the records a failure's classification named. Every one fire-and-forget, each
// with its own named failure line, since none may cost the turn its frames.

// One of this turn's rows in the durable activity log, before the turn's identity is stamped on.
export type TurnActivity = Omit<ActivityEvent, "id" | "at" | "provider" | "direction">;

// The row a frame is beyond the turn's start and end: a plan it showed, a failure it hit.
export const activityOf = (event: AgentEvent): TurnActivity | undefined => {
    if (event.kind === "plan") {
        return { type: "turn.plan", content: event.text, extra: { requestId: event.requestId } };
    }
    return event.kind === "error" ? { type: "turn.error", outcome: "error", error: event.message } : undefined;
};

// The writes a frame causes beside its own way out: the account reading it carried, filed so every open window's rings
// move too, and the row it is in the activity log.
export const recordFrame = (
    deps: Pick<Services, "cliProxy" | "headroom" | "logger">,
    event: AgentEvent,
    turn: { readonly provider: AgentProvider; readonly account: string | undefined; readonly record: (event: TurnActivity) => void },
): void => {
    if (event.kind === "account_usage") {
        void fileAccountUsage(deps, turn.provider, turn.account, event.windows);
    }
    const row = activityOf(event);
    if (row !== undefined) {
        turn.record(row);
    }
};

// This turn's rows, each stamped with its identity so its events join as one row; full content stays in the transcript.
export const turnActivity =
    (
        deps: Pick<Services, "activity" | "agents" | "logger">,
        turn: {
            readonly input: TurnInput;
            readonly provider: string;
            readonly turnId: string;
            readonly attribution: Attribution;
            readonly sessionId: () => string | undefined;
        },
    ) =>
    (event: TurnActivity): void => {
        const { input } = turn;
        // Read per row, not captured once: the title namer runs concurrently, mid-turn.
        const title = input.conversationId === undefined ? undefined : deps.agents.entry(input.conversationId)?.social.title?.text;
        void deps.activity
            .append({
                provider: turn.provider,
                direction: "system",
                turnId: turn.turnId,
                ...turn.attribution,
                ...opt("sessionId", turn.sessionId()),
                ...opt("conversationId", input.conversationId),
                ...opt("title", title),
                ...opt("origin", input.origin),
                ...event,
            })
            .catch((error: unknown) => deps.logger.warn({ err: error }, "activity: turn event append failed"));
    };

// The first real content proves an outage over fleet-wide, releasing every stranded turn at once, and settles what this
// provider and account last refused: content on the wire is the only evidence a refusal no poll can re-check yields to.
// It reopens the model it ran on as well, so the picker stops greying a row whose turns go through.
// A spent allowance is settled for the model that answered (provider-refusals.ts answeredBy), and for any other model
// that spends no pool the answering one does not (settleCovered); an account refused outright is settled by any answer
// on it. The observed ledger is settled the same way: the account's entry for the model it just served, and its
// account-wide refusal. `askedAt` is when the answered request went out: only what was filed before it is settled, since
// a request already in flight when a refusal was filed proves nothing about it (frame-reducers.ts). Undefined settles
// whatever stands, for a caller that cannot say.
export const providerAnswered = (
    deps: Pick<Services, "providerRefusals" | "claudeSeats" | "modelCooldowns" | "observedLimits" | "headroom" | "logger">,
    provider: string,
    account: string | undefined,
    model: string | undefined,
    askedAt?: number,
): void => {
    recordProviderSuccess(provider);
    const served = model === undefined || model === "" ? undefined : model;
    // Proves the lane to the fan-out governor, so a child spawned onto what its parent already runs on starts at once.
    if (served !== undefined) {
        FAN_OUT.served({ provider, model: served });
    }
    void deps.providerRefusals.clear(provider, account, served, askedAt).catch((error: unknown) => deps.logger.warn({ err: error }, "provider refusal: settle failed"));
    if (served !== undefined) {
        void deps.modelCooldowns.clear(provider, served, askedAt).catch((error: unknown) => deps.logger.warn({ err: error }, "model cooldown: settle failed"));
        void settleCovered(deps, provider, account, served, askedAt);
    }
    // The same answer checks the plan-limit readings: one that said this model could not run is wrong (drift/contradictions.ts).
    const routed = AgentProviderSchema.safeParse(provider);
    if (served !== undefined && askedAt !== undefined && routed.success) {
        void checkAnswered(deps, routed.data, readingAccount(provider, account), served, askedAt);
    }
    // Clears the seat mark too, so a re-enabled account rejoins rotation without a reconnect.
    if (account === undefined) {
        return;
    }
    void settleObserved(deps, provider, account, served, askedAt);
    void deps.claudeSeats.clear(account).catch((error: unknown) => deps.logger.warn({ err: error }, "claude account: could not clear the entitlement mark"));
};

// A turn's frame, where it is an answer that settles refusals (TurnFrames.note answers when its request went out), settles
// them as providerAnswered does; any other frame settles nothing.
export const settleAnswered = (
    deps: Parameters<typeof providerAnswered>[0],
    provider: string,
    account: string | undefined,
    model: string | undefined,
    askedAt: number | undefined,
): void => {
    if (askedAt !== undefined) {
        providerAnswered(deps, provider, account, model, askedAt);
    }
};

// The account whose readings an answer speaks for. A translator-routed turn names a label (Codex's
// "codex-subscription"), the key of no reading: the translator picked one of the provider's credentials, unnamed.
const readingAccount = (provider: string, account: string | undefined): string | undefined =>
    KeyedProviderSchema.safeParse(provider).success ? undefined : account;

/* An answer proves open every pool its model spends, so it settles another model's spent allowance as well where that
   model spends no pool the answering one does not (answerCovers): the refusal on file and the bench beside it. Codex
   meters every model from one allowance: a Luna turn went through while Sol stayed refused and benched, and the account
   rail read every Codex account spent over it (2026-10-20). Judged on the readings the answer speaks for: the account it
   named, or for a routed turn, every reading of the provider, each of which must show it, since nothing says which of
   them the translator picked. A model metered by its own slice is never settled by another's answer. Never rejects. */
const settleCovered = async (
    deps: Pick<Services, "providerRefusals" | "modelCooldowns" | "headroom" | "logger">,
    provider: string,
    account: string | undefined,
    served: string,
    askedAt: number | undefined,
): Promise<void> => {
    try {
        const [stored, refusals, cooling] = await Promise.all([deps.headroom.read(), deps.providerRefusals.onFile(), deps.modelCooldowns.cooling(provider)]);
        const readings = readingKeys(stored, provider, readingAccount(provider, account)).flatMap((key) => {
            const usage = stored[key];
            return usage === undefined ? [] : [usage];
        });
        const covered = (model: string): boolean =>
            model !== served && readings.length > 0 && readings.every((usage) => answerCovers(usage, { id: served }, { id: model }));
        const refused = new Set(
            (refusals[provider] ?? []).flatMap((refusal) => (refusal.kind === "limit" && refusal.model !== undefined && covered(refusal.model) ? [refusal.model] : [])),
        );
        await Promise.all([
            ...[...refused].map(async (model) => deps.providerRefusals.clear(provider, account, model, askedAt)),
            ...[...cooling.keys()].filter(covered).map(async (model) => deps.modelCooldowns.clear(provider, model, askedAt)),
        ]);
    } catch (error) {
        deps.logger.warn({ err: error, provider, model: served }, "provider refusal: settling the models an answer covers failed");
    }
};

// The account's own refusals in the observed ledger, settled by its answer: the model it served, and the account-wide
// refusal. Never rejects: a settle that fails is its own line.
const settleObserved = async (
    deps: Pick<Services, "observedLimits" | "logger">,
    provider: string,
    account: string,
    served: string | undefined,
    askedAt: number | undefined,
): Promise<void> => {
    try {
        await Promise.all([ACCOUNT_WIDE, ...(served === undefined ? [] : [served])].map(async (entry) => deps.observedLimits.forget(provider, account, entry, askedAt)));
    } catch (error) {
        deps.logger.warn({ err: error }, "observed limit: settle failed");
    }
};

// Files a turn's plan-limit reading under the account it describes, so every open window's rings move too. A routed
// turn names only its subscription: its shared key gets it, or every file is re-read when there is none.
export const fileAccountUsage = async (
    deps: Pick<Services, "cliProxy" | "headroom" | "logger">,
    provider: AgentProvider,
    account: string | undefined,
    windows: readonly UsageWindow[],
): Promise<void> => {
    try {
        const routed = KeyedProviderSchema.safeParse(provider);
        if (routed.success) {
            const key = await deps.cliProxy.sharedUsageKey(routed.data);
            await (key === undefined
                ? deps.headroom.refresh({ scope: { providers: [provider] }, maxAgeMs: 0 })
                : deps.headroom.record(provider, key, { windows: [...windows], measuredAt: Date.now() }));
            return;
        }
        if (account !== undefined) {
            await deps.headroom.record(provider, account, { windows: [...windows], measuredAt: Date.now() });
        }
    } catch (error) {
        deps.logger.warn({ err: error }, "account usage: snapshot write failed");
    }
};

type FailureWriteDeps = Pick<
    Services,
    | "providerRefusals"
    | "headroom"
    | "observedLimits"
    | "modelRefusals"
    | "claudeSeats"
    | "modelCooldowns"
    | "logger"
    | "runOuts"
    | "accountUsage"
    | "claudeStore"
    | "cliProxy"
>;

// A spent allowance's refusal is also the moment its window ran out (usage/run-outs.ts): the window the readings show
// ran out, and the agents running on the provider then, which the next spawn listing quotes beside the figure left.
const noteRunOut = async (deps: FailureWriteDeps, provider: string, refusal: ProviderRefusal): Promise<void> => {
    const known = AgentProviderSchema.safeParse(provider);
    const facts = known.success ? await accountFactsOf(deps, known.data).catch((): readonly ServiceFacts[] => []) : [];
    const runOut = runOutOf({
        at: refusal.at,
        model: refusal.model,
        resetsAt: refusal.resetsAt,
        readings: facts.flatMap((fact) => (fact.usage === undefined ? [] : [fact.usage])),
        running: runningOn(provider),
    });
    await deps.runOuts.record(provider, runOut);
};

// Performs what a failure's classification named, in its order, without waiting on any of it: a turn's frames go out
// whatever the records do.
export const performFailureWrites = (deps: FailureWriteDeps, writes: readonly FailureWrite[]): void => {
    void fileFailureWrites(deps, writes);
};

// The same writes, settled once every record is on file (never rejecting: each failure has its own named line), for a
// caller whose next step reads them back, as a sealed request re-planned off the account that just refused does.
export const fileFailureWrites = async (deps: FailureWriteDeps, writes: readonly FailureWrite[]): Promise<void> => {
    await Promise.all(writes.map((write) => performFailureWrite(deps, write)));
};

const performFailureWrite = (deps: FailureWriteDeps, write: FailureWrite): Promise<void> => {
    const warn = (message: string) => (error: unknown) => deps.logger.warn({ err: error }, message);
    switch (write.kind) {
        case "provider-refusal":
            return Promise.all([
                deps.providerRefusals.record(write.provider, write.refusal).catch(warn("provider refusal: write failed")),
                write.refusal.kind === "limit" ? noteRunOut(deps, write.provider, write.refusal).catch(warn("run-out: write failed")) : undefined,
            ]).then(() => undefined);
        case "headroom-refresh":
            // Unwaited even here: a re-measure is the freshest signal, not a record anything reads back at once.
            void deps.headroom.refresh(write.options);
            return Promise.resolve();
        case "observed-limit":
            return (
                deps.observedLimits
                    .record(write.provider, write.account, write.model, write.limit)
                    // Re-read at once, so an open picker's ring moves with the refusal instead of at the next sweep.
                    .then(() => void deps.headroom.refresh({ scope: { providers: [write.provider], account: write.account }, maxAgeMs: 0 }))
                    .catch(warn("observed limit: write failed"))
            );
        case "model-refusal":
            return deps.modelRefusals.record(write.provider, write.model, write.refusal).catch(warn("model refusal: write failed"));
        case "seat-refusal":
            return deps.claudeSeats.refuse(write.account, write.reason).catch(warn("claude account: could not record the entitlement refusal"));
        case "model-cooldown":
            return deps.modelCooldowns.record(write.provider, write.model, write.cooldown).catch(warn("model cooldown: write failed"));
    }
};
