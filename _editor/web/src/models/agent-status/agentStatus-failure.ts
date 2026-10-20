import type { AgentErrorCode } from "@intentic/sandbox-contract/events/agent-events";
import { isPrivacyRefusal, type PrivacyRefusalCode } from "@intentic/sandbox-contract/schemas/privacy-egress";
import { t } from "@intentic/ui/i18n";
import type { AgentStanding } from "./agentStatus-standing";

// WHAT KIND OF FAILURE ENDED A TURN, as the reader acts on it, for every surface that says one: the board's corner names
// the kind, and the chat's notice leads a provider's words with the kind's own line (failureView.ts). The daemon codes
// every failure it can classify (agent-events.ts's error codes, carried on the card as `failureCode` and on the notice
// row); the card used to read only two of them and call every other one "Error", so an organization switching Claude Code
// off, a provider timing out and a model that no longer exists all wore the same word as a crash. Grouped by what the
// reader does next, not by provider; a failure nothing coded has no kind, and each surface says so in its own words.
export type FailureKind =
    // The account signs in but is refused service: an organization or plan that switched it off.
    | `access`
    // The account's credential is dead or missing; a reconnect fixes it.
    | `signedOut`
    // The provider failed and kept failing past the retries.
    | `outage`
    // The model the turn named is not served to this account, or cannot run this kind of turn.
    | `model`
    // The turn is bigger than the model's window.
    | `contextFull`
    // The installed engine is older than the model requires.
    | `update`
    // The provider's safety classifier stopped the turn.
    | `flagged`
    // A spent allowance the `rate_limit` code does not cover (the free trial's day).
    | `limit`
    // The privacy shield held the words back before anything was read.
    | `privacy`
    // Held at the door for want of room, as a memory hold is.
    | `held`
    // The runtime stopped partway without failing outright; the work may be half done.
    | `cutShort`
    // The harness read the message as a slash command it does not have; the model never saw it.
    | `command`
    // The runtime warned about a turn it went on with: a note, not an ending.
    | `advisory`;

// Every code the wire names, each with its kind: a code added to the contract fails the build here until it has one, so no
// surface draws a failure it has no word for. The shield's own refusals are the contract's to name (isPrivacyRefusal),
// and are all the privacy kind.
const KINDS_BY_CODE = {
    rate_limit: `limit`,
    "session-not-found": `cutShort`,
    "codex-advisory": `advisory`,
    "unknown-command": `command`,
    "agent-busy": `held`,
    "sandbox-memory-low": `held`,
    "sandbox-disk-low": `held`,
    "tools-unenforced": `held`,
    "agent-domain-refused": `held`,
    "claude-not-entitled": `access`,
    "account-not-entitled": `access`,
    "subscription-required": `access`,
    "claude-reauth": `signedOut`,
    "codex-reauth": `signedOut`,
    "claude-token-refused": `signedOut`,
    "acp-auth-required": `signedOut`,
    "provider-outage": `outage`,
    "trial-unavailable": `outage`,
    "grok-model-invalid": `model`,
    "codex-model-invalid": `model`,
    "model-unavailable": `model`,
    "trial-model-unavailable": `model`,
    "model-helper-only": `model`,
    "context-window-too-small": `contextFull`,
    "context-overflow": `contextFull`,
    "engine-version-floor": `update`,
    "safeguard-flagged": `flagged`,
    "trial-exhausted": `limit`,
    "workspace-setup": `held`,
    "turn-cap": `cutShort`,
    "harness-incomplete": `cutShort`,
} as const satisfies Record<Exclude<AgentErrorCode, PrivacyRefusalCode>, FailureKind>;
// Looked up by a bare string, since the roster and a row carry the code as one: a newer sandbox's code this build has no
// word for reads as no kind, never as a wrong one.
const KIND_OF_CODE = new Map<string, FailureKind>(Object.entries(KINDS_BY_CODE));

/** The kind a failure code names; undefined for none, and for a code this build does not know. */
export const kindOfCode = (code: string | undefined): FailureKind | undefined => {
    if (isPrivacyRefusal(code)) {
        return `privacy`;
    }
    return code === undefined ? undefined : KIND_OF_CODE.get(code);
};

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
