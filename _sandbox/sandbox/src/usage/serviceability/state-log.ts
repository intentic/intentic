import type { AccountState, ProviderRefusal } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import { bindingWindow, type ModelRef, type RefusalsOnFile, reopensAtOf, refusalVerdict, type ServiceFacts } from "@intentic/sandbox-contract/models/plan-pools";
import type { Logger } from "pino";
import { opt } from "../../opt.js";

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

/** An account that could not serve and now can: the moment a parent waiting on capacity wants to hear. */
export interface AccountReopened {
    readonly provider: string;
    readonly account: string;
    readonly label?: string;
    // The verdict it came back from, in the log's words ("spent", "blocked (wait)").
    readonly from: string;
}

// Heard by whoever subscribes (agent/subagents/capacity-reopened.ts): a change this log writes was, until it, the only
// sign an account came back, and a parent waiting on capacity sat on until a person read the log for it (2026-10-17).
const reopenedListeners = new Set<(event: AccountReopened) => void>();

/** Hears every account that comes back to `ready` from spent or blocked; answers its own unsubscribe. */
export const onAccountReopened = (listener: (event: AccountReopened) => void): (() => void) => {
    reopenedListeners.add(listener);
    return () => reopenedListeners.delete(listener);
};

const cameBack = (previous: string | undefined, shape: string): boolean =>
    shape === "ready" && previous !== undefined && (previous === "spent" || previous.startsWith("blocked"));

// Tells every listener of an account that came back, once per change the log writes.
const announceReopened = (provider: string, entry: ServiceFacts, previous: string | undefined, shape: string): void => {
    if (previous === undefined || !cameBack(previous, shape)) {
        return;
    }
    const event: AccountReopened = { provider, account: entry.account, ...opt("label", entry.label), from: previous };
    for (const listener of reopenedListeners) {
        listener(event);
    }
};

/* A KNOWN REOPEN IS JUDGED AT ITS INSTANT. A verdict is judged only when something asks (a page load, a spawn, the
   resume pass), and the idle usage refresh comes every fifteen minutes, so an account whose spent pool reopened at a
   known instant was said to be back only at whichever came next (2026-10-20). Every judgement now arms one timer per
   provider for the soonest reopen it saw ahead (a spent pool's reset, a block's end), and at it the listeners below judge
   that provider again, which writes the change and tells whoever waits on it (onAccountReopened). */

const reopenDueListeners = new Set<(provider: string) => void>();

/** Hears a provider whose soonest known reopen has come, to judge its accounts again; answers its own unsubscribe. */
export const onReopenDue = (listener: (provider: string) => void): (() => void) => {
    reopenDueListeners.add(listener);
    return () => reopenDueListeners.delete(listener);
};

// A moment past the instant itself, so the judgement it wakes reads the pool reopened rather than a second short of it.
const REOPEN_GRACE_MS = 1_000;

// When an account that cannot serve says it can again (epoch ms); undefined where its verdict names no instant.
const reopenOf = (state: AccountState): number | undefined => {
    const at = reopensAtOf(state);
    return at === undefined ? undefined : at * 1000;
};

// One timer per provider and question (a model's pools, or none), armed for the soonest reopen still ahead among its
// accounts as last judged on that question: a judgement for one model must not move the timer another's set.
const reopenTimers = (now: () => number): ((provider: string, model: ModelRef | undefined, states: ReadonlyMap<string, AccountState>) => void) => {
    const armed = new Map<string, { readonly at: number; readonly timer: NodeJS.Timeout }>();
    return (provider, model, states) => {
        const key = `${provider}\u0000${model?.id ?? ""}`;
        const ahead = [...states.values()].flatMap((state) => {
            const at = reopenOf(state);
            return at !== undefined && at > now() ? [at] : [];
        });
        const at = ahead.length === 0 ? undefined : Math.min(...ahead);
        const current = armed.get(key);
        if (current?.at === at) {
            return;
        }
        clearTimeout(current?.timer);
        armed.delete(key);
        if (at === undefined) {
            return;
        }
        const timer = setTimeout(
            () => {
                armed.delete(key);
                for (const listener of reopenDueListeners) {
                    listener(provider);
                }
            },
            // setTimeout's ceiling: a reopen further out fires early, and the judgement it wakes arms the rest.
            Math.min(2_147_483_647, at - now() + REOPEN_GRACE_MS),
        );
        timer.unref();
        armed.set(key, { at, timer });
    };
};

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
    const armReopen = reopenTimers(now);
    return {
        note: (provider, facts, states, refusals, model) => {
            armReopen(provider, model, states);
            const standing = refusals
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
                announceReopened(provider, entry, previous, shape);
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
