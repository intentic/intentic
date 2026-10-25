import { parseJsonOr } from "@intentic/base/json";
import type { AgentErrorCode } from "@intentic/sandbox-contract/events/agent-events";
import type { FailureSaid } from "@intentic/sandbox-contract/events/sandbox-notice";
import { t } from "@intentic/ui/i18n";
import { type FailureKind, kindOfCode } from "./agentStatus-failure";
import { memoryShare } from "./memoryTip";

/* Shared chat/board failure summary: use sandbox-authored (`own`) wording, otherwise localize the kind and keep provider text in details.
 * Continuing warnings keep their own words. Uncoded failures use safeguard detection or a short/provider sentence before falling back to unknown.
 * Authorship must be recorded, never inferred from a code: older rows without `own` count as provider-authored. */

export interface FailureView {
    /** The failure's own line, ahead of the clause its notice adds (what happens next). */
    readonly line: string;
    /** The provider's or the harness's own words, behind the details press; absent where the line already says them. */
    readonly said?: string;
    /** Whether the turn ended on it: every failure does but a warning the runtime went on past. */
    readonly ends: boolean;
}

// The line a provider's words are led by, per kind. A warning has none: its own words are its line.
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
} as const satisfies Record<Exclude<FailureKind, `advisory`>, () => string>;

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
    if (kind === `advisory`) {
        return { ...(spoken(message) ?? { line: message }), ends };
    }
    if (kind !== undefined) {
        return { line: KIND_LINES[kind](), said: message, ends };
    }
    // A code this build does not know (a newer sandbox's) is the unclassified kind: its words were coded, so the
    // sandbox that coded them had something to say beyond them.
    return { ...(error === undefined ? uncoded(message) : unclassified(message)), ends };
};

// Marks only a provider's or a harness's failure carries: a row written before failures were coded is a failure by
// them, and words that carry one are a dump to read for the claim in it, not a sentence to draw whole.
const PROVIDER_MARKERS = [/\bAPI Error\b/, /\bRequest ID:/, /\bsafeguards flagged this\b/i, /\berror result:/i, /\bstderr:/, /\bunexpected status \d{3}\b/i, /\n\s+at /];

// The Claude CLI's sentence for a turn its provider's safety classifier stopped ("Opus 5.5's safeguards flagged this
// session", "… stopped the response above").
const SAFEGUARD = /\bsafeguards (?:flagged this (?:message|session)|stopped the response)\b/i;

// A message this short, on one line, is already its own line: nothing is folded away from it.
const SHORT = 120;
// A first sentence past this is a paragraph without a full stop, and is cut at a word.
const LONGEST = 200;
// A parenthetical longer than this is an aside (an upstream's diagnostics, a list of providers), not part of the claim.
const ASIDE = 30;

// What stands in front of the provider's own words: the Agent SDK's result prefix, then anything up to the CLI's
// "API Error:" and the HTTP status after it. What comes before an "API Error:" is the CLI's guess at a category
// ("Failed to authenticate.") rather than what the provider said, so the line starts after it; the details keep it.
const RESULT_PREFIX = /^Claude Code returned an error result:\s*/i;
const API_ERROR = /^[\s\S]*?\bAPI Error:\s*(?:\d{3}\b\s*)?/;

// A JSON error body a routed provider answered with, read for the sentence it carries.
const BODY_MESSAGE = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/;

// Where a sentence stops reading as a claim and starts reading as a dump: a colon followed by a path, a URL or a body.
const DUMP = /:\s+(?=file:|https?:\/\/|\/|\{|\[)/;

const HAS_URL = /https?:\/\//;
// Words that say something: a bare status ("401.") or punctuation says nothing a reader can act on.
const HAS_WORD = /\p{L}/u;

// The provider's own words, without the wrappers the SDK and the CLI put in front of them.
const unwrapped = (said: string): string => {
    const bare = said.trim().replace(RESULT_PREFIX, ``);
    const spokenWords = bare.replace(API_ERROR, ``).trim();
    if (spokenWords.startsWith(`{`)) {
        const inner = BODY_MESSAGE.exec(spokenWords)?.[1];
        if (inner !== undefined) {
            // An escape JSON refuses leaves the body as it was said.
            return String(parseJsonOr(`"${inner}"`, spokenWords));
        }
    }
    return spokenWords === `` ? bare : spokenWords;
};

// The line without its asides: a parenthetical that is long or holds a link goes, and one never closed (a body cut off
// mid-way) ends the line where it opened.
const withoutAsides = (line: string): string => {
    const opened: number[] = [];
    const cuts: [number, number][] = [];
    for (let index = 0; index < line.length; index++) {
        if (line[index] === `(`) {
            opened.push(index);
        } else if (line[index] === `)` && opened.length > 0) {
            const start = opened.pop()!;
            const inside = line.slice(start + 1, index);
            if (opened.length === 0 && (inside.length > ASIDE || HAS_URL.test(inside))) {
                cuts.push([start, index + 1]);
            }
        }
    }
    const end = opened[0] ?? line.length;
    let kept = ``;
    let from = 0;
    for (const [start, stop] of cuts) {
        kept += line.slice(from, start).trimEnd();
        from = stop;
    }
    return (kept + line.slice(from, end)).trim();
};

// Up to the first full stop outside any parentheses that ends a word, not one inside a version ("Opus 5.5's").
const firstSentence = (line: string): string => {
    let depth = 0;
    for (let index = 0; index < line.length; index++) {
        const char = line[index];
        if (char === `(`) {
            depth += 1;
        } else if (char === `)`) {
            depth = Math.max(0, depth - 1);
        } else if (depth === 0 && (char === `.` || char === `!` || char === `?`) && (index + 1 === line.length || /\s/.test(line[index + 1]!))) {
            return line.slice(0, index + 1);
        }
    }
    return line;
};

// Cut at a word near the limit, never mid-word; a line ending in the middle of nothing gets a full stop.
const settled = (line: string): string => {
    const tidy = line.replace(/[\s,;:–—-]+$/u, ``);
    if (tidy.length > LONGEST) {
        const room = tidy.slice(0, LONGEST - 1);
        const space = room.lastIndexOf(` `);
        return `${(space > LONGEST / 2 ? room.slice(0, space) : room).replace(/[\s,;:]+$/, ``)}…`;
    }
    return /[.!?…)"'`]$/.test(tidy) ? tidy : `${tidy}.`;
};

// The first thing the provider said, as one sentence.
const firstClaim = (words: string): string => {
    const line = words.split(`\n`).find((candidate) => candidate.trim() !== ``)?.trim() ?? words.trim();
    const sentence = firstSentence(withoutAsides(line));
    // A dump's own field name goes with it: "…, url: http://…" leaves no dangling "url".
    const dump = DUMP.exec(sentence);
    return settled(dump !== null && dump.index >= 12 ? sentence.slice(0, dump.index).replace(/,\s*[\w-]+$/, ``) : sentence);
};

// A sentence without its closing stop, to compare two that differ only by one.
const unpunctuated = (text: string): string => text.replace(/[\s.!?…]+$/u, ``);

// What words say as a line: the whole of a short sentence that is no provider's dump, else the first thing said after
// the wrappers in front of it, the words whole behind the press. Undefined for words that say nothing.
const spoken = (said: string): Pick<FailureView, `line` | `said`> | undefined => {
    const whole = said.trim();
    if (!HAS_WORD.test(whole)) {
        return undefined;
    }
    if (whole.length <= SHORT && !whole.includes(`\n`) && !PROVIDER_MARKERS.some((marker) => marker.test(whole))) {
        return { line: whole };
    }
    const words = unwrapped(whole);
    // A body with no sentence in it ("API Error: 500 {"type":"error"}") says nothing.
    const line = /^[{[]/.test(words) ? `` : firstClaim(words);
    if (!HAS_WORD.test(line)) {
        return undefined;
    }
    // A line that says all of it, give or take the full stop it was given, folds nothing away and opens no details.
    return unpunctuated(line) === unpunctuated(whole) ? { line: whole } : { line, said };
};

const unclassified = (said: string): Pick<FailureView, `line` | `said`> => ({ line: t(`chat.failure.unclassified`), said });

// A failure nothing coded: a safeguard flag by the CLI's words for one, else what its words say, else unclassified.
const uncoded = (said: string): Pick<FailureView, `line` | `said`> =>
    SAFEGUARD.test(said) ? { line: KIND_LINES.flagged(), said } : (spoken(said) ?? unclassified(said));

/** The failure a row recorded before failures were coded says, by marks no sandbox sentence carries; undefined for any other. */
export const legacyFailure = (text: string): FailureView | undefined =>
    PROVIDER_MARKERS.some((marker) => marker.test(text)) ? { ...uncoded(text), ends: true } : undefined;
