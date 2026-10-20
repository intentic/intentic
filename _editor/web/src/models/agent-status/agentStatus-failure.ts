import type { AgentErrorCode } from "@intentic/sandbox-contract/events/agent-events";
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
// surface draws a failure it has no word for.
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
    "privacy-unshielded": `privacy`,
    "privacy-instructions": `privacy`,
    "workspace-setup": `held`,
    "turn-cap": `cutShort`,
    "harness-incomplete": `cutShort`,
} as const satisfies Record<AgentErrorCode, FailureKind>;
// Looked up by a bare string, since the roster and a row carry the code as one: a newer sandbox's code this build has no
// word for reads as no kind, never as a wrong one.
const KIND_OF_CODE = new Map<string, FailureKind>(Object.entries(KINDS_BY_CODE));

/** The kind a failure code names; undefined for none, and for a code this build does not know. */
export const kindOfCode = (code: string | undefined): FailureKind | undefined => (code === undefined ? undefined : KIND_OF_CODE.get(code));

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

// A sentence ends at a stop followed by the start of another (an upper-case letter, a bracket or a quote), so "e.g. check
// quota" and "version 2.1.233" stay whole; a refusal that joins its advice on with a middle dot ("… for Claude Code ·
// Use an API key instead") ends there too, and so does a line break.
const SENTENCE_END = /(?<=[.!?])\s+(?=[\p{Lu}"'([])|\s+·\s+|\n/u;

// The first sentence of someone else's words, for a line with room for one: what a card says of a failure at rest, the
// whole of it left to the hover. Its closing stop goes, as a label's would. Whitespace runs fold, so an indented stack
// trace reads as its first line rather than as blank space.
export const failureGist = (words: string): string => {
    const flat = words.trim();
    const first = flat.split(SENTENCE_END)[0] ?? flat;
    return first.replace(/\s+/gu, ` `).replace(/\.$/u, ``).trim();
};
