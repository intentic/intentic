import type { ModelPin, SandboxSettings } from "@intentic/sandbox-contract";
import type { Services } from "../../../composition.js";
import type { CommandGuardOptions } from "../../../guard/command-guard.js";
import { opt } from "../../../opt.js";
import type { TurnBase } from "../../providers/agent-request.js";
import { installGrantsOf, installPlacementOf, PROJECT_INSTALL_RULE } from "../../providers/project-installs.js";

// What every runtime's command gate is built with, set once above the provider split so Claude Code, Codex and Cursor
// are judged alike: the owner's safety policy and its judge, what caused the turn, the install rule with the
// conversation's kept "allow installs", the ledger an image install feeds, and the heavy table a shell's programs are
// queued by. Before 2026-09-29 only the Claude Code plan set these, and a vendor turn ran on the shipped policy with no
// judge and no install rule.

export type TurnSafetyDeps = Pick<
    Services,
    "conversationGrants" | "heavyCommands" | "judgeCommand" | "logger" | "runtimeInstalls" | "safetyLog" | "safetyPolicy" | "workspace"
>;

// A closure over the judge, the policy text and the owner's model pin rather than any of them directly, because the seam
// it fills lives in guard/.
const judgeFor =
    (deps: Pick<Services, "judgeCommand">, policy: string, pins: readonly ModelPin[] | undefined): CommandGuardOptions["judge"] =>
    (program, facts, signal) =>
        // An unpinned role reads as an empty list, which the walk answers with its Auto ladder.
        deps.judgeCommand({ policy, program, facts, pins: pins ?? [] }, signal);

// The turn as the safety layers read it: which conversation, and what woke it when the owner did not.
export interface TurnSafetyInput {
    readonly conversationId?: string | undefined;
    readonly outsideWake?: string | undefined;
}

export const withTurnSafety = async (deps: TurnSafetyDeps, input: TurnSafetyInput, base: TurnBase, settings: SandboxSettings): Promise<TurnBase> => {
    // Read once here and carried on the request, so a turn is judged against one snapshot rather than three versions of a
    // policy someone is mid-edit on.
    const safetyPolicy = await deps.safetyPolicy.text();
    const { conversationId } = input;
    return {
        ...base,
        policy: {
            ...base.policy,
            safetyPolicy,
            judging: settings.commandJudge,
            // Whether outside content caused this turn, the same distinction the admission floor draws, read for the taint.
            ...opt("outsideWake", input.outsideWake),
        },
        tools: {
            ...base.tools,
            // Read per command where the runtime runs its own shell line (Claude Code), per turn where it doesn't.
            heavyCommands: () => deps.heavyCommands.read(),
        },
        hooks: {
            ...base.hooks,
            judge: judgeFor(deps, safetyPolicy, settings.modelRoles[`safety-judge`]),
            // The safety log is the owner's record of what the judge decided; a line it could not keep is said out loud.
            logSafety: (entry) => {
                void deps.safetyLog.record(entry).catch((error: unknown) => deps.logger.warn({ err: error }, "safety log: a judged command was not recorded"));
            },
            safetyAnswered: (at, answer, outcome) => {
                void deps.safetyLog
                    .answered(at, answer, outcome)
                    .catch((error: unknown) => deps.logger.warn({ err: error }, "safety log: the owner's answer was not recorded"));
            },
            rememberSafety: (line) => deps.safetyPolicy.append(line),
            // Every image-scoped install attempt, appended best-effort to the runtime-install ledger; a second distinct
            // session installing the same tool is what earns an auto-drafted overlay step.
            onImageInstall: (installs, command) => {
                void deps.runtimeInstalls
                    .record(installs, command, conversationId, Date.now())
                    .catch((error: unknown) => deps.logger.warn({ err: error }, "runtime-install ledger append failed"));
            },
            projectInstalls: {
                placement: installPlacementOf(base.spec.isolation),
                root: deps.workspace.root,
                mode: settings.projectInstalls,
                canInstall: base.policy.dependencyInstallAllowed === true,
                grants: conversationId === undefined ? undefined : installGrantsOf(deps.conversationGrants, conversationId),
                rule: PROJECT_INSTALL_RULE,
            },
        },
    };
};
