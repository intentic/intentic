import type { AgentErrorCode } from "@intentic/sandbox-contract/events/agent-events";
import type { FailureSaid } from "@intentic/sandbox-contract/events/sandbox-notice";
import { t } from "@intentic/ui/i18n";
import { type FailureKind, kindOfCode } from "./agentStatus-failure";
import { memoryShare } from "./memoryTip";

/*
 * A FAILURE AS A PERSON READS IT, IN THE CHAT AND ON THE BOARD, for every failure whatever path it came by: one line in the reader's
 * language, and what the provider or the harness said one press away. The line is never someone else's words. Where the
 * sandbox worded the failure itself (the row's `own`), its sentence is the line; where it is the provider's or the
 * harness's (a six-paragraph safeguard flag, a JSON body, a stack trace, a vendor's "Click Continue"), the line is this
 * build's own for the failure's kind (agentStatus-failure.ts, the same kinds the board names), and those words are the
 * details. A failure nothing coded is the unclassified kind, said as such. Before this, the line was guessed out of the
 * provider's words by their first sentence, and rows that carried no code were recognised by marks in them: whatever
 * slipped past both reached the chat as raw text (2026-10-06, 10-19, 10-20). The board card's line is this same line
 * (agentStatus-chips.ts cardFailure), so the two surfaces cannot word one failure two ways.
 *
 * Authorship is recorded, never inferred: a row or an ending from before `own` was kept (2026-10-20) reads as the
 * provider's, its kind's line leading and its words behind the press, the sandbox's sentence included. Inferring it from
 * the code was rejected: the same code is the sandbox's sentence on one path and a provider's on another (`agent-busy`
 * from Cursor's SDK, `privacy-unshielded` from a masking failure), and promoting a provider's words to the line is the
 * one failure this rule exists to make impossible.
 */

export interface FailureView {
    /** The failure's own line, ahead of the clause its notice adds (what happens next). */
    readonly line: string;
    /** The provider's or the harness's own words, behind the details press; absent where the line already says them. */
    readonly said?: string;
    /** Whether the turn ended on it: every failure does but a warning the runtime went on past. */
    readonly ends: boolean;
}

// The line a provider's words are led by, per kind, and for a failure nothing named.
const KIND_LINES = {
    access: () => t(`chat.failure.access`),
    signedOut: () => t(`chat.failure.signedOut`),
    outage: () => t(`chat.failure.outage`),
    model: () => t(`chat.failure.model`),
    contextFull: () => t(`chat.failure.contextFull`),
    update: () => t(`chat.failure.update`),
    flagged: () => t(`chat.failure.flagged`),
    limit: () => t(`chat.failure.limit`),
    privacy: () => t(`chat.failure.privacy`),
    held: () => t(`chat.failure.held`),
    cutShort: () => t(`chat.failure.cutShort`),
    command: () => t(`chat.failure.command`),
    advisory: () => t(`chat.failure.advisory`),
} as const satisfies Record<FailureKind, () => string>;

// The sandbox's own sentences this build says in the reader's language rather than the sandbox's English: a memory hold
// keeps its figures, in a few characters.
const WORDED = {
    "agent-busy": () => t(`chat.sandboxNotice.agentBusy`),
    "sandbox-memory-low": (said: string) => {
        const share = memoryShare(said);
        return share === undefined ? t(`chat.sandboxNotice.memoryLow`) : t(`chat.sandboxNotice.memoryLowShare`, { share });
    },
} as const satisfies Partial<Record<AgentErrorCode, (said: string) => string>>;
// Looked up by the row's code, a bare string on the wire.
const WORDED_BY_CODE = new Map<string, (said: string) => string>(Object.entries(WORDED));

/** A failure's line, details and ending, from the facts its notice carries. */
export const failureView = ({ message, error, own }: FailureSaid): FailureView => {
    const ends = error !== `codex-advisory`;
    const worded = error === undefined ? undefined : WORDED_BY_CODE.get(error);
    if (worded !== undefined) {
        return { line: worded(message), ends };
    }
    if (own === true) {
        return { line: message, ends };
    }
    const kind = kindOfCode(error);
    return { line: kind === undefined ? t(`chat.failure.unclassified`) : KIND_LINES[kind](), said: message, ends };
};

// Marks only a provider's or a harness's failure carries, for a row written before failures were coded: such a row is
// the unclassified kind, its words the details. Nothing written since needs reading this way (failure-rows.ts).
const PROVIDER_MARKERS = [/\bAPI Error\b/, /\bRequest ID:/, /\bsafeguards flagged this\b/i, /\berror result:/i, /\bstderr:/, /\bunexpected status \d{3}\b/i, /\n\s+at /];

/** The failure a row recorded before failures were coded says, by marks no sandbox sentence carries; undefined for any other. */
export const legacyFailure = (text: string): FailureView | undefined =>
    PROVIDER_MARKERS.some((marker) => marker.test(text)) ? { line: t(`chat.failure.unclassified`), said: text, ends: true } : undefined;
