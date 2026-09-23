import type { Services } from "../../../composition.js";
import { commandRuleFindings, touchedRepos, workspaceRelative } from "../../../rules/turn-ending.js";
import { nudgeUnverifiedWork } from "../../verification/verify-nudge.js";
import type { TurnActivity } from "../frames/frame-effects.js";
import type { DaemonStopTurn, SettlementPlan } from "./turn-settlement.js";

// Carries a settlement plan out in the order a turn's exit always has: the resume records first, then the rows and
// re-reads, each fire-and-forget with its own named failure line. The daemon's Stop alone is awaited, since the land
// decision reads the verdict its rules record and the follow-up carries what they found.

// What the turn.ending command rules found on a daemon-stopped isolated turn, worded for the model; empty when the
// turn is not one, is unisolated (the main tree is everyone's), or the rules passed. Their verdict is recorded through
// `onCheckRun` as it runs, which is what the land decision reads.
export const daemonStopFindings = async (deps: Pick<Services, "logger">, turn: DaemonStopTurn): Promise<string[]> => {
    if (turn.conversationId === undefined || !turn.isolated) {
        return [];
    }
    const { request } = turn;
    try {
        const changed = request.hooks.changedPaths === undefined ? [] : await request.hooks.changedPaths().catch((): readonly string[] => []);
        const rules = request.policy.turnEndingRules ?? [];
        const paths = [...new Set([...turn.edited.map((path) => workspaceRelative(path, turn.cwd)), ...changed])];
        return await commandRuleFindings(
            rules,
            // Same facts the hook path builds at its own Stop, repositories included, or the same rule would mean two
            // different things depending on which runtime ran the turn.
            { paths, draw: Math.random(), repos: await touchedRepos(rules, paths, { repos: request.hooks.turnRepos }) },
            {
                runCommand: request.hooks.runRuleCommand,
                onCheckRun: request.hooks.onCheckRun,
                onFired: request.hooks.onRuleFired,
                installing: request.hooks.dependencyInstalling,
                cwd: turn.cwd,
                ...(turn.isolation !== undefined ? { isolation: turn.isolation.plan } : {}),
            },
        );
    } catch (error) {
        deps.logger.warn({ err: error, conversationId: turn.conversationId }, "turn-ending checks: could not run after the turn");
        return [];
    }
};

// What the turn's exit leaves for the resume pass, told to the conversation it belongs to: a credential to re-mint, an
// outage to wait out, a held turn, or proof the run got somewhere.
const recordResumes = (deps: Pick<Services, "conversations">, plan: SettlementPlan): void => {
    const { authFailure, outageFailure, hold } = plan;
    if (authFailure !== undefined) {
        deps.conversations.send(authFailure.input.conversationId, { kind: "auth-refused", failure: authFailure });
    }
    if (outageFailure !== undefined) {
        deps.conversations.send(outageFailure.input.conversationId, { kind: "outage-stranded", failure: outageFailure });
    }
    if (hold?.kind === "held") {
        deps.conversations.send(hold.held.input.conversationId, { kind: "turn-held", held: hold.held });
    } else if (hold?.kind === "got-somewhere") {
        deps.conversations.send(hold.conversationId, { kind: "turn-got-somewhere" });
    }
};

export const performSettlement = async (
    deps: Pick<Services, "usage" | "headroom" | "events" | "logger" | "conversations">,
    plan: SettlementPlan,
    turn: {
        // Appends one of the turn's own rows to the activity log.
        readonly record: (event: TurnActivity) => void;
        // Records the outbound calls whose results never arrived.
        readonly flush: () => void;
    },
): Promise<void> => {
    recordResumes(deps, plan);
    turn.record(plan.completion);
    if (plan.headroomRefresh !== undefined) {
        void deps.headroom.refresh(plan.headroomRefresh);
    }
    void deps.usage.record(plan.usage).catch((error: unknown) => deps.logger.warn({ err: error }, "usage: ledger append failed"));
    const findings = await daemonStopFindings(deps, plan.daemonStop.findings);
    if (plan.daemonStop.nudge !== undefined) {
        void nudgeUnverifiedWork({ ...plan.daemonStop.nudge, findings }).catch((error: unknown) =>
            deps.logger.warn({ err: error }, "verify nudge: could not be decided"),
        );
    }
    turn.flush();
    if (plan.snapshot !== undefined) {
        deps.events.publish("tree.changed", { label: plan.snapshot });
    }
};
