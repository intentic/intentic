import { type ActivityEvent, type AgentEvent, type AgentProvider, KeyedProviderSchema, type UsageWindow } from "@intentic/sandbox-contract";
import type { Services } from "../../../composition.js";
import { recordProviderSuccess } from "../../providers/provider-health.js";
import { opt } from "../../../opt.js";
import type { TurnInput } from "../../../seams/turn-starter.js";
import type { FailureWrite } from "./classify-failure.js";
import type { Attribution } from "./frame-decorators.js";

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
export const providerAnswered = (
    deps: Pick<Services, "providerRefusals" | "claudeSeats" | "modelCooldowns" | "logger">,
    provider: string,
    account: string | undefined,
    model: string | undefined,
): void => {
    recordProviderSuccess(provider);
    void deps.providerRefusals.clear(provider, account).catch((error: unknown) => deps.logger.warn({ err: error }, "provider refusal: settle failed"));
    if (model !== undefined && model !== "") {
        void deps.modelCooldowns.clear(provider, model).catch((error: unknown) => deps.logger.warn({ err: error }, "model cooldown: settle failed"));
    }
    // Clears the seat mark too, so a re-enabled account rejoins rotation without a reconnect.
    if (account === undefined) {
        return;
    }
    void deps.claudeSeats.clear(account).catch((error: unknown) => deps.logger.warn({ err: error }, "claude account: could not clear the entitlement mark"));
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

type FailureWriteDeps = Pick<Services, "providerRefusals" | "headroom" | "observedLimits" | "modelRefusals" | "claudeSeats" | "modelCooldowns" | "logger">;

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
            return deps.providerRefusals.record(write.provider, write.refusal).catch(warn("provider refusal: write failed"));
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
