import { type FailureKind, failureTraitsOf } from "@intentic/sandbox-contract/policy/failure-codes";
import { t } from "@intentic/ui/i18n";
import type { AgentStanding } from "./agentStatus-standing";

// WHAT KIND OF FAILURE ENDED A TURN, as the reader acts on it, for every surface that says one: the board's corner names
// the kind, and the chat's notice leads a provider's words with the kind's own line (failureView.ts). The daemon codes
// every failure it can classify (agent-events.ts's error codes, carried on the card as `failureCode` and on the notice
// row); the card used to read only two of them and call every other one "Error", so an organization switching Claude Code
// off, a provider timing out and a model that no longer exists all wore the same word as a crash. Which kind each code is
// lives in the contract's failure table (failure-codes.ts), whose row the chat and the daemon read too; a failure nothing
// coded has no kind, and each surface says so in its own words.
export type { FailureKind };

/** The kind a failure code names; undefined for none, and for a code this build does not know. */
export const kindOfCode = (code: string | undefined): FailureKind | undefined => failureTraitsOf(code)?.kind;

// The kind an `error` card's failure is, or undefined for one nothing classified (and for every other status: a refused
// start says "Didn't start" whatever refused it, since that is the half of it the reader did not know).
export const failureKind = (agent: Pick<AgentStanding, "status" | "failureCode">): FailureKind | undefined =>
    agent.status === `error` ? kindOfCode(agent.failureCode) : undefined;

// The corner's word for each kind. Short, since the chip is `shrink-0` beside the agent's name: no longer than the
// longest word the corner already wears ("Question for you").
const kindWords = () =>
    ({
        access: t(`agents.agentStatus.noAccess`),
        signedOut: t(`agents.agentStatus.signedOut`),
        outage: t(`agents.agentStatus.providerDown`),
        model: t(`agents.agentStatus.modelUnavailable`),
        contextFull: t(`agents.agentStatus.contextFull`),
        update: t(`agents.agentStatus.updateNeeded`),
        flagged: t(`agents.agentStatus.flagged`),
        limit: t(`agents.agentStatus.usageLimit`),
        privacy: t(`agents.agentStatus.privacyHold`),
        held: t(`agents.agentStatus.held`),
        cutShort: t(`agents.agentStatus.cutShort`),
        command: t(`agents.agentStatus.unknownCommand`),
        advisory: t(`agents.agentStatus.warned`),
    }) as const satisfies Record<FailureKind, string>;
export const failureWord = (kind: FailureKind): string => kindWords()[kind];

// Where a kind's way on is. Every one but a turn cut short is answered by a choice the conversation offers (another
// account or model, sending again, letting the words through), and the transcript holds nothing to diagnose, so it
// opens the chat, as a spent allowance does. A turn cut short is a report of how far it got: the review.
export const failureOpensChat = (kind: FailureKind): boolean => kind !== `cutShort`;

// The ink of the card's failure glyph: a fault reads as one, a refusal or a wait as something to decide.
export const failureTone = (kind: FailureKind | undefined): `danger` | `warning` =>
    kind === undefined || kind === `cutShort` ? `danger` : `warning`;
