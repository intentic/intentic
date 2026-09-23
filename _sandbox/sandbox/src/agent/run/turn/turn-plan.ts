import type { UsageTurn } from "@intentic/sandbox-contract";
import type { Services } from "../../../composition.js";
import type { TurnArmPlan, TurnContext, TurnRefusal } from "../../providers/adapter.js";
import type { TurnBriefing } from "../../prompt/turn-briefing.js";
import type { TurnTrimState } from "../../prompt/window/context-trim.js";
import { standing } from "../../../rules/rules.js";
import { armSupervisor } from "../../subagents/children.js";
import { turnEndingHooksOf } from "../harness/harness-hooks.js";
import { dependencyDirForCommand } from "../../tools/agent-deps.js";
import type { TurnBase } from "../../providers/agent-request.js";
import { decideTurn } from "../decide/turn-decision.js";
import { gatherTurnFacts } from "../decide/turn-facts.js";
import { opt } from "../../../opt.js";
import type { TurnInput } from "../../../seams/turn-starter.js";

// Plans a turn: gatherTurnFacts reads what it stands on, decideTurn decides it without I/O (both in ../decide), and the
// adapter its (provider, harness) row names preflights it. A refusal is a value (`ok: false` + code) the route turns
// into the composer's connect-gate error frame. The adapters sit below this file and never import it.

// What planning measured about this turn, in the LEDGER's own field names so the route spreads it whole: a stamp the
// experiments registry declares (decide/experiments.ts) reaches usage.jsonl by existing, never by being listed again.
export type TurnExperimentStamps = Partial<
    Pick<
        UsageTurn,
        | "turnIndex"
        | "iqSearchArm"
        | "iqSearchCohort"
        | "mapArm"
        | "mapChars"
        | "notesArm"
        | "notesChars"
        | "notesCohort"
        | "turnContext"
        | "turnContextMs"
        | "guidanceArm"
        | "guidanceCohort"
    >
>;

// What planTurn answers: the arm's own plan plus the facts only planning holds.
export type TurnPlan =
    | TurnRefusal
    | (Extract<TurnArmPlan, { readonly ok: true }> & {
          // Every per-turn experiment reading as one object: arms are conversation-level (fixed once a skill enters a
          // provider session), costs are per-turn, and an absent field means unmeasured rather than zero.
          readonly experiments: TurnExperimentStamps;
          // Which preamble notes this turn's card still wants. Carried out of planning because two of them (the repo
          // sync advisory, the hand-off state) only exist after it, in the route.
          readonly briefing: TurnBriefing;
          // What the model's window would not pay for and what it has taken so far, so the route can hold the two
          // notes it adds after planning to the same window and disclose one list. Absent when nothing was trimmed,
          // which is every model whose window holds a full turn.
          readonly contextTrim?: TurnTrimState;
      });

// Facts, then a decision with no I/O, then the arm: dispatched through the adapter table composition wires rather than an
// if/else chain, so the set of runtimes has one declaration and the picker's health probe sits beside the arm it predicts.
export const planTurn = async (services: Services, input: TurnInput, context: TurnContext): Promise<TurnPlan> => {
    const decision = decideTurn(await gatherTurnFacts(services, input, context), input, context);
    for (const { fields, message } of decision.warnings) {
        services.logger.warn(fields, message);
    }
    // children.routes.ts reads this arming as its gate, so a turn whose persona may not delegate never records one.
    if (decision.spawn && context.children !== undefined && input.conversationId !== undefined) {
        armSupervisor(services.conversations, input.conversationId, context.children);
    }
    if (!decision.ok) {
        const { warnings: _logged, spawn: _armed, ...refusal } = decision;
        return refusal;
    }
    // Every runtime's: the Claude Code loop reads these at its own Stop hook, the daemon for the rest once the frames end.
    const turnEndingRules = standing(decision.context.settings?.rules ?? [], "turn.ending");
    const base: TurnBase = {
        ...decision.context.base,
        policy: { ...decision.context.base.policy, ...(turnEndingRules.length > 0 ? { turnEndingRules } : {}) },
        hooks: {
            ...decision.context.base.hooks,
            // The request's one live seam, asked of the main checkout at the start folder when a command fails.
            dependencyIssue: (command) =>
                services.dependencies.issueAt(dependencyDirForCommand(decision.dependencyDir, services.workspace.root, command)),
            ...turnEndingHooksOf(services, decision.input, decision.context, turnEndingRules),
        },
    };
    const plan = await services.adapters
        .for(decision.provider, decision.harness)
        .preflight(services, decision.input, { ...decision.context, base }, decision.granted);
    if (!plan.ok) {
        return plan;
    }
    // Carried past the arm, so the two notes the route adds after planning face the same card and the same window.
    return { ...plan, briefing: decision.briefing, ...opt("contextTrim", decision.contextTrim), experiments: decision.experiments };
};
