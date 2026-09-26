import type { ChildAgentAsk, ChildRun } from "./requests.js";
import type { AgentReply } from "../schemas/providers/plan-limits.js";

// How a child agent's run is compared and replaced, stated once: the card deciding whether the owner changed anything,
// the settle rule recording what started, and the daemon starting it all replace the same fields in the same way.

/** A child's run alone, off anything that carries one; absent fields stay absent rather than arriving as undefined. */
export const childRunOf = (from: ChildRun): ChildRun => {
    const run: ChildRun = { provider: from.provider, model: from.model };
    if (from.harness !== undefined) {
        run.harness = from.harness;
    }
    if (from.account !== undefined) {
        run.account = from.account;
    }
    if (from.effort !== undefined) {
        run.effort = from.effort;
    }
    if (from.thinking !== undefined) {
        run.thinking = from.thinking;
    }
    if (from.fast !== undefined) {
        run.fast = from.fast;
    }
    return run;
};

/**
 * Whether two runs would start the same child. An absent harness is the provider's own loop, as a named `native` is,
 * and an absent speed is the standard one. An absent effort or thinking setting is the model's own default, which is
 * not the same as naming one.
 */
export const sameChildRun = (left: ChildRun, right: ChildRun): boolean =>
    left.provider === right.provider &&
    left.model === right.model &&
    (left.harness ?? "native") === (right.harness ?? "native") &&
    left.account === right.account &&
    left.effort === right.effort &&
    left.thinking === right.thinking &&
    (left.fast ?? false) === (right.fast ?? false);

/**
 * The request as it reads once the owner started the child on `run`: the run replaced whole, with what the agent asked
 * for kept as `proposed`. The same request, unchanged, when `run` is what the agent asked for anyway.
 */
export const repointedChild = (ask: ChildAgentAsk, run: ChildRun): ChildAgentAsk => {
    if (sameChildRun(ask, run)) {
        return ask;
    }
    const {
        provider: _provider,
        model: _model,
        harness: _harness,
        account: _account,
        effort: _effort,
        thinking: _thinking,
        fast: _fast,
        ...about
    } = ask;
    return { ...about, ...childRunOf(run), proposed: childRunOf(ask) };
};

/**
 * A permission card as a reply leaves its child: a start the owner allowed on a run of their own reads what actually
 * started, so a settled card never names the model that didn't. Anything else, a no included, keeps the card as asked.
 */
export const startedChildCard = <P extends { readonly child?: ChildAgentAsk | undefined }>(card: P, reply: AgentReply | undefined): P => {
    const ask = card.child;
    if (ask?.move !== "spawn" || reply?.kind !== "permission" || reply.decision === "deny" || reply.child === undefined) {
        return card;
    }
    return { ...card, child: repointedChild(ask, reply.child) };
};
