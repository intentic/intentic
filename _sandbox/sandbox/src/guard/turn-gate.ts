import { type AgentCapabilities, type CommandJudgeMode, DEFAULT_SAFETY_POLICY } from "@intentic/sandbox-contract";
import { type CommandGate, type CommandGateOptions, createCommandGate } from "./command-gate.js";
import { clearTurnTaint, createTurnTaint, publishTurnTaint, type TurnTaint } from "./turn-taint.js";

// One place every vendor runtime mints a gate and publishes a taint bit, instead of copying it into Codex, OpenCode,
// ACP and Pi. Claude Code builds its own, since only its PostToolUse hook can mark taint mid-turn. Publishing matters
// even where nothing marks: the wallet reads `conversationTainted` from outside the turn generator.

export interface TurnGateInput {
    // The owner's safety policy this turn was planned with; absent gets the shipped default.
    readonly safetyPolicy?: string;
    // How much of the gate is on; absent means `on`, so a request built by hand still judges something.
    readonly judging?: CommandJudgeMode;
    // Ask the judge. Absent ⇒ every triage hit takes the judge-unavailable path; see CommandGateOptions.judge.
    readonly judge?: CommandGateOptions["judge"];
    // Record, amend and remember verdicts; all three absent for a turn with no workspace to write to.
    readonly log?: CommandGateOptions["log"];
    readonly answered?: CommandGateOptions["answered"];
    readonly remember?: CommandGateOptions["remember"];
    // Nobody is at a composer, so an ask refuses instead of parking on a card.
    readonly unattended?: boolean;
    // What caused this wake when the owner didn't write it (a listener, a webchat visitor); taint's birth half.
    readonly outsideWake?: string;
    // Which conversation to publish the bit under; absent means nothing is published (a bench turn, a one-shot).
    readonly conversationId?: string;
    // This runtime's rulebook capability; the gate's shape derives from it, absent defaulting to "hooks".
    readonly rulebook?: AgentCapabilities["rulebook"];
    // Where this turn's commands run, so the gate can check a credential-shaped path against the real file.
    readonly cwd?: string;
    readonly signal: AbortSignal;
}

export interface TurnGate {
    readonly gate: CommandGate;
    readonly taint: TurnTaint;
    // Drop the conversation's published bit; every caller owes this once its turn settles, in a finally.
    readonly release: () => void;
}

// Whether anything could refuse this turn; always true, since the standing hard rule applies to every turn regardless
// of policy. Runtimes read this at turn start to decide whether to enable their approval channel.
export const turnIsGated = (): boolean => true;

// Gate shape derives from the runtime's declared rulebook, never passed in separately:
// none: blind, taint born set and never clears (no consult seam to act on it).
// refuse-only: a hold can't park (the vendor's own inactivity clock), so it refuses instead.
// approval / hooks: the full shape, a hold parks on a card.
const blindFor = (rulebook: TurnGateInput["rulebook"]): boolean => rulebook === "none";
const canParkFor = (rulebook: TurnGateInput["rulebook"]): boolean => rulebook !== "refuse-only" && rulebook !== "none";

export const createTurnGate = (turn: TurnGateInput): TurnGate => {
    const blind = blindFor(turn.rulebook);
    const taint = createTurnTaint(turn.outsideWake ?? (blind ? "a runtime with no command gate" : undefined));
    if (turn.conversationId !== undefined) {
        publishTurnTaint(turn.conversationId, taint, turn.unattended === true);
    }
    return {
        taint,
        gate: createCommandGate({
            policy: turn.safetyPolicy ?? DEFAULT_SAFETY_POLICY,
            judging: turn.judging ?? "on",
            unattended: turn.unattended === true,
            ...(canParkFor(turn.rulebook) ? {} : { canPark: false }),
            ...(turn.cwd === undefined ? {} : { cwd: turn.cwd }),
            signal: turn.signal,
            taint,
            judge: turn.judge,
            log: turn.log,
            answered: turn.answered,
            remember: turn.remember,
        }),
        release: () => {
            if (turn.conversationId !== undefined) {
                clearTurnTaint(turn.conversationId);
            }
        },
    };
};
