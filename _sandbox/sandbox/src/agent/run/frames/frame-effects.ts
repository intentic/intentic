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
// provider and account were refused before it (provider-refusals.ts settledBy): content on the wire is the only evidence
// a refusal no poll can re-check yields to. A spent allowance is settled for the model that answered, and for any other
// model that spends no pool the answering one does not (coverOf); an account refused outright is settled by any answer
// on it. Every surface judges by that one ledger, so the picker stops greying a row whose turns go through the moment
// the account rows do. `askedAt` is when the answered request went out: only what was filed before it is settled, since
// a request already in flight when a refusal was filed proves nothing about it (frame-reducers.ts). Undefined settles
// whatever stands, for a caller that cannot say.
export const providerAnswered = (
    deps: Pick<Services, "providerRefusals" | "claudeSeats" | "headroom" | "logger">,
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
    void settleRefusals(deps, provider, account, served, askedAt);
    // The same answer checks the plan-limit readings: one that said this model could not run is wrong (drift/contradictions.ts).
    const routed = AgentProviderSchema.safeParse(provider);
    if (served !== undefined && askedAt !== undefined && routed.success) {
        void checkAnswered(deps, routed.data, readingAccount(provider, account), served, askedAt);
    }
    // Clears the seat mark too, so a re-enabled account rejoins rotation without a reconnect.
    if (account !== undefined) {
        void deps.claudeSeats.clear(account).catch((error: unknown) => deps.logger.warn({ err: error }, "claude account: could not clear the entitlement mark"));
    }
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
   model spends no pool the answering one does not (answerCovers). Codex meters every model from one allowance: a Luna
   turn went through while Sol stayed refused, and the account rail read every Codex account spent over it (2026-10-20).
   Judged on the readings the answer speaks for: the account it named, or for a routed turn, every reading of the
   provider, each of which must show it, since nothing says which of them the translator picked. A model metered by its
   own slice is never settled by another's answer, and nothing read proves nothing. */
const coverOf = async (deps: Pick<Services, "headroom">, provider: string, account: string | undefined, served: string): Promise<(model: string) => boolean> => {
    const stored = await deps.headroom.read();
    const readings = readingKeys(stored, provider, readingAccount(provider, account)).flatMap((key) => {
        const usage = stored[key];
        return usage === undefined ? [] : [usage];
    });
    return (model) => model !== served && readings.length > 0 && readings.every((usage) => answerCovers(usage, { id: served }, { id: model }));
};

// Settles what the answer proves over, the models it covers included. Never rejects: a settle that fails is its own line.
const settleRefusals = async (
    deps: Pick<Services, "providerRefusals" | "headroom" | "logger">,
    provider: string,
    account: string | undefined,
    served: string | undefined,
    askedAt: number | undefined,
): Promise<void> => {
    try {
        // allow(silent-catch): an unreadable reading costs the answer only the other models it would have covered.
        const covers = served === undefined ? undefined : await coverOf(deps, provider, account, served).catch(() => undefined);
        await deps.providerRefusals.settle(provider, { account, model: served, askedAt, covers });
    } catch (error) {
        deps.logger.warn({ err: error, provider, ...opt("model", served) }, "provider refusal: settle failed");
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
    "providerRefusals" | "headroom" | "modelRefusals" | "claudeSeats" | "logger" | "runOuts" | "accountUsage" | "claudeStore" | "cliProxy" | "providerAccounts"
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
        case "model-refusal":
            return deps.modelRefusals.record(write.provider, write.model, write.refusal).catch(warn("model refusal: write failed"));
        case "seat-refusal":
            return deps.claudeSeats.refuse(write.account, write.reason).catch(warn("claude account: could not record the entitlement refusal"));
    }
};
