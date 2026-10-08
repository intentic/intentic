import type { OpenCodeClient, OpenCodeEvent } from "@opencode/client";
import type { AgentEvent } from "@intentic/sandbox-contract";
import { displayNameOf } from "@intentic/agent-context/tool-calls";
import { type CommandGuard, consultWith, type GuardOutcome, vendorSubject } from "../../guard/command-guard.js";

// Who answers OpenCode's permission asks. The server's rules ask about the commands the owner's rulebook should see
// (opencode-config.ts) and allow everything else; an ask lands on the server's one event stream, and this answers it.

// What answers one session's permission asks: the turn's rulebook gate, where the cards it raises go (the turn's own
// stream, in order with its events), and the turn watchdog's hold, taken while an ask waits on the daemon's answer so a
// card open on a person is not read as a stalled turn.
export interface SessionJudge {
    readonly gate: CommandGuard;
    readonly push: (event: AgentEvent) => void;
    readonly hold: () => () => void;
}

// Who answers each session's asks while its turn runs, keyed by OpenCode session id, the only key the detached stream
// and a turn's rules share; an ask for a session with none gets the standing yes.
export interface SessionJudges {
    readonly register: (sessionId: string, judge: SessionJudge) => void;
    readonly release: (sessionId: string) => void;
}

export interface PermissionAsk {
    readonly id: string;
    readonly sessionID: string;
    // Which action: `shell`, `edit`, or one this config does not mention.
    readonly kind: string;
    // What the classifier reads: the command the metadata names, else the resources the ask is about.
    readonly program: string | undefined;
}

const named = (metadata: Readonly<Record<string, unknown>> | undefined): string | undefined => {
    for (const key of ["command", "cmd", "script", "input"]) {
        const value = metadata?.[key];
        if (typeof value === "string" && value.trim() !== "") {
            return value;
        }
    }
    return undefined;
};

/** The ask an event raises, or undefined for every other event. */
export const permissionAskOf = (event: OpenCodeEvent): PermissionAsk | undefined => {
    if (event.type !== "permission.asked") {
        return undefined;
    }
    const { id, sessionID, action, resources, metadata } = event.data;
    // A shell ask's one resource is the command line it would run (checked against 2.0.26).
    const listed = resources.join(" ");
    return { id, sessionID, kind: action, program: named(metadata) ?? (listed.trim() === "" ? undefined : listed) };
};

// One answer as OpenCode takes it. A refusal carries its reason, which OpenCode hands the model as the call's failure
// and keeps the turn going. Never `always`: OpenCode 2 turns it into a saved rule for the whole project, which every
// later ask there would then skip, the owner's rulebook included.
type PermissionReply = { readonly decision: "once" } | { readonly decision: "reject"; readonly message: string };

// Fail closed: a consult that threw has no verdict to stand on, and an unanswered ask would stall the turn instead.
const CONSULT_FAILED =
    "This could not be checked against your owner's safety policy, so it was refused. " +
    "Do not retry: carry on with what you can do without it, and say plainly what you left undone.";

/**
 * Answers one permission: the owner's rulebook if this session has a judge, the standing yes otherwise. A hold parks
 * on a card like Codex's: the turn's watchdog is held for the whole consult, and the card's frames reach the turn's
 * stream through the judge.
 */
export const answerPermission = async (client: OpenCodeClient, judge: SessionJudge | undefined, ask: PermissionAsk): Promise<void> => {
    const reply = async (answer: PermissionReply): Promise<void> => {
        await client.permission.reply({ sessionID: ask.sessionID, requestID: ask.id, ...answer });
    };
    if (judge === undefined || !judge.gate.enforcing || ask.program === undefined) {
        await reply({ decision: "once" });
        return;
    }
    const release = judge.hold();
    let outcome: GuardOutcome;
    try {
        outcome = await consultWith(judge.gate, ask.program, vendorSubject(displayNameOf(ask.kind)), judge.push);
    } catch {
        // allow(silent-catch): answered below as a refusal naming the failure, the only verdict left to give
        outcome = { allow: false, reason: CONSULT_FAILED };
    } finally {
        release();
    }
    await reply(outcome.allow ? { decision: "once" } : { decision: "reject", message: outcome.reason });
};
