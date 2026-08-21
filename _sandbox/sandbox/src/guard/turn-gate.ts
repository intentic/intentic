import type { AdmissionRule, AgentCapabilities, CommandClass } from "@intentic/sandbox-contract";
import { type CommandGate, createCommandGate } from "./command-gate.js";
import { clearTurnTaint, createTurnTaint, publishTurnTaint, type TurnTaint } from "./turn-taint.js";

/* ONE PLACE EVERY VENDOR RUNTIME BUILDS ITS SAFETY WIRING, so the five lines that mint a gate and publish a
 * taint bit are written once instead of copied into Codex, OpenCode, ACP and Pi.
 *
 * The Claude Code loop does NOT come through here, and the difference is real rather than historical: it builds
 * its own taint bit because it is the only runtime that can also MARK one mid-turn (its PostToolUse hook wraps
 * what the agent pulls in, guard/outside-results.ts), and it hands that same bit to both the wrapper and the
 * gate. A vendor runtime has no such seam, so its bit is whatever the wake carried and stays that way.
 *
 * WHY PUBLISHING MATTERS EVEN WHERE NOTHING CAN MARK. `conversationTainted` is read from outside the turn
 * generator, by the wallet's payment gate (wallet/payment-offer.ts), and it used to answer `false` for every
 * runtime but one, because only the Claude path published. So a Codex turn woken by a stranger kept the owner's
 * standing auto-approve band, which is the exact grant that band was never meant to cover. Publishing here
 * closes that for all four.
 */

export interface TurnGateInput {
    // SandboxSettings.commandRules as this turn was planned with. Absent ⇒ the owner wrote none.
    readonly commandRules?: Partial<Readonly<Record<CommandClass, AdmissionRule>>>;
    // Nobody is at a composer, so a hold refuses instead of parking on a card.
    readonly unattended?: boolean;
    // What caused this wake, when it was something the owner did not write (a listener message, a webchat
    // visitor). The birth half of the taint bit; see guard/turn-taint.ts.
    readonly outsideWake?: string;
    // Which conversation to publish the bit under. Absent ⇒ nothing is published (a bench turn, a one-shot).
    readonly conversationId?: string;
    /* What this runtime can DO about the rulebook, from its own capability record, carried on the request by
     * turn-plan.ts. This is the whole reason the record's `rulebook` axis is enforced rather than descriptive:
     * the shape below is DERIVED from the declaration, so changing the declaration changes the behaviour, and a
     * row that lies about itself is a row that breaks a test rather than one that merely misinforms a user.
     *
     * Absent ⇒ "hooks", the ceiling, which is the safe default for a caller that builds a request by hand. */
    readonly rulebook?: AgentCapabilities["rulebook"];
    readonly signal: AbortSignal;
}

export interface TurnGate {
    readonly gate: CommandGate;
    readonly taint: TurnTaint;
    // Drop the conversation's published bit. Owed by every caller once its turn settles, in a `finally`.
    readonly release: () => void;
}

/* Whether the OWNER'S RULEBOOK could refuse anything on this turn, answerable before the turn starts.
 *
 * Read by the runtimes whose gate is the vendor's approval channel, because turning that channel on is a
 * decision at turn start rather than per call. Kept beside createTurnGate so the two cannot disagree about what
 * "could refuse anything" means. */
export const turnIsGated = (turn: TurnGateInput): boolean => Object.keys(turn.commandRules ?? {}).length > 0 || turn.outsideWake !== undefined;

/* Mint this turn's gate and publish its taint bit.
 *
 * The gate emits its own frames by YIELDING them (see CommandGate.consult), so nothing about how this runtime
 * reaches its client belongs here.
 *
 * THE SHAPE IS DERIVED FROM THE DECLARATION, never passed in, which is what stops the record and the wiring
 * drifting apart (the capability ledger's enforced/descriptive split turns on exactly this):
 *
 * "none"        ⇒ BLIND. No consult seam at all (Pi). The bit is born set and cannot be cleared, because a turn
 *                 nothing can gate has no later moment where "has this read a stranger's words" could be acted
 *                 on: the honest reading is to treat every such turn as carrying outside content, so the wallet
 *                 asks in chat rather than spending on a delegation that assumed a gate existed. It costs a
 *                 runtime that was never gated nothing it had.
 * "refuse-only" ⇒ CANNOT PARK. The vendor puts a clock on a paused approval (OpenCode's inactivity watchdog),
 *                 so a hold arrives as a refusal naming the rule. See CommandGateOptions.canPark.
 * "approval" /  ⇒ the full shape: a hold parks on a card and the vendor waits.
 * "hooks"
 *
 * "none" cannot park EITHER, which is belt to the braces rather than a behaviour anything relies on: such a
 * runtime never consults its gate at all (Pi takes only the taint bit), so this is what happens if one ever
 * does. A runtime declaring no seam has nowhere to hold a call open, and refusing is the safe direction of that. */
const blindFor = (rulebook: TurnGateInput["rulebook"]): boolean => rulebook === "none";
const canParkFor = (rulebook: TurnGateInput["rulebook"]): boolean => rulebook !== "refuse-only" && rulebook !== "none";

export const createTurnGate = (turn: TurnGateInput): TurnGate => {
    const blind = blindFor(turn.rulebook);
    const taint = createTurnTaint(turn.outsideWake ?? (blind ? "a runtime with no command gate" : undefined));
    if (turn.conversationId !== undefined) {
        publishTurnTaint(turn.conversationId, taint);
    }
    return {
        taint,
        gate: createCommandGate({
            rules: turn.commandRules ?? {},
            unattended: turn.unattended === true,
            ...(canParkFor(turn.rulebook) ? {} : { canPark: false }),
            signal: turn.signal,
            taint,
        }),
        release: () => {
            if (turn.conversationId !== undefined) {
                clearTurnTaint(turn.conversationId);
            }
        },
    };
};
