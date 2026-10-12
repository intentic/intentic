import {
    type AccountState,
    type AgentProvider,
    bindingWindow,
    type ModelRef,
    type ProviderRefusal,
    type RefusalsOnFile,
    refusalVerdict,
    type ServiceFacts,
} from "@intentic/sandbox-contract";
import type { Logger } from "pino";

// The verdict on an account is computed on demand from four stores and published nowhere but the account lists, so the
// moment an account went from ready to spent (and why) was in no log: an agent asked to explain a stuck turn had to call
// the provider's usage API with the account's own token to find a weekly pool at 100. This writes one line per change of
// verdict, naming the account the way a person does (its label or address, not only its id) and the reading that
// decided it: the binding pool's figure, whether the provider rounds it, when it resets, and the refusal on file.
//
// A change, not every judgement: the lists are judged on every page load. Room moving within `ready` is not a change;
// reaching the line (a rounded pool read at 100, which pickers treat differently) is.

// What counts as the same verdict between two judgements.
const shapeOf = (state: AccountState): string => {
    switch (state.kind) {
        case "ready":
            return state.room > 0 ? "ready" : "ready (at the line)";
        case "blocked":
            return `blocked (${state.fix})`;
        default:
            return state.kind;
    }
};

const isoSeconds = (epochSeconds: number | undefined): string | undefined =>
    epochSeconds === undefined ? undefined : new Date(epochSeconds * 1000).toISOString();

// The reading behind a verdict, as fields a grep can join on. Only what decided it: the pool that binds (for this model
// where one was named), the refusal still standing over the account, the block's own words.
const evidence = (facts: ServiceFacts, state: AccountState, refusal: ProviderRefusal | undefined, model: ModelRef | undefined): Record<string, unknown> => {
    const binding = bindingWindow(facts.usage, model);
    return {
        ...(binding === undefined
            ? {}
            : {
                  window: binding.kind,
                  utilization: binding.utilization,
                  ...(binding.rounded === true ? { rounded: true } : {}),
                  ...(binding.resetsAt === undefined ? {} : { windowResetsAt: isoSeconds(binding.resetsAt) }),
              }),
        ...(facts.usage === undefined ? {} : { measuredAt: new Date(facts.usage.measuredAt).toISOString() }),
        ...(facts.usage?.unread === undefined ? {} : { unread: facts.usage.unread.reason }),
        ...(refusal === undefined
            ? {}
            : { refusal: { kind: refusal.kind, at: new Date(refusal.at).toISOString(), message: refusal.message, ...(refusal.model === undefined ? {} : { model: refusal.model }) } }),
        ...(state.kind === "spent" && state.reopensAt !== undefined ? { reopensAt: isoSeconds(state.reopensAt) } : {}),
        ...(state.kind === "blocked" ? { reason: state.reason, ...(state.until === undefined ? {} : { until: isoSeconds(state.until) }) } : {}),
        ...(state.kind === "ready" ? { room: state.room } : {}),
    };
};

const refusalList = (refusals: RefusalsOnFile): readonly ProviderRefusal[] =>
    refusals === undefined ? [] : "kind" in refusals ? [refusals] : refusals;

export interface AccountStateLog {
    // Every account of one provider as just judged together; writes a line for each whose verdict changed since the last
    // judgement on the same question (the same model, or none).
    readonly note: (
        provider: AgentProvider | string,
        facts: readonly ServiceFacts[],
        states: ReadonlyMap<string, AccountState>,
        refusals: RefusalsOnFile,
        model?: ModelRef,
    ) => void;
}

export const createAccountStateLog = (logger: Pick<Logger, "info">, now: () => number = Date.now): AccountStateLog => {
    const last = new Map<string, string>();
    return {
        note: (provider, facts, states, refusals, model) => {
            const standing = refusalList(refusals)
                .filter((refusal) => refusalVerdict(refusal, facts, now()) === "standing")
                .toSorted((left, right) => right.at - left.at);
            for (const entry of facts) {
                const state = states.get(entry.account);
                if (state === undefined) {
                    continue;
                }
                const key = `${provider}\u0000${entry.account}\u0000${model?.id ?? ""}`;
                const shape = shapeOf(state);
                const previous = last.get(key);
                if (previous === shape) {
                    continue;
                }
                last.set(key, shape);
                // A first sight of an account that can serve says nothing worth a line on every boot; a first sight of
                // one that cannot is the fact somebody will come looking for.
                if (previous === undefined && (state.kind === "unknown" || shape === "ready")) {
                    continue;
                }
                const refusal = standing.find((candidate) => (candidate.account ?? entry.account) === entry.account);
                logger.info(
                    {
                        provider,
                        account: entry.account,
                        ...(entry.label === undefined || entry.label === entry.account ? {} : { label: entry.label }),
                        ...(model === undefined ? {} : { model: model.id }),
                        from: previous ?? "unseen",
                        to: shape,
                        ...evidence(entry, state, refusal, model),
                    },
                    `accounts: ${provider} account ${entry.label ?? entry.account} ${previous ?? "unseen"} → ${shape}`,
                );
            }
        },
    };
};

// One tracker per logger, so the daemon keeps one memory of what it last said while each test's logger starts fresh.
const logs = new WeakMap<object, AccountStateLog>();

export const accountStateLogFor = (logger: Pick<Logger, "info">): AccountStateLog => {
    let log = logs.get(logger);
    if (log === undefined) {
        log = createAccountStateLog(logger);
        logs.set(logger, log);
    }
    return log;
};
