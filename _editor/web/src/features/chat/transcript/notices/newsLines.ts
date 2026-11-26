import type { ChildNewsKind, TranscriptChildNews } from "@intentic/sandbox-contract/events/transcript";
import type { Tone } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";

/* NEWS ABOUT SUBAGENTS, AS LINES: what the sandbox told the agent about one of its subagents between start and report
   (child-news.ts), drawn on the owner's own edge, because it went to the agent the way a prompt does, but as a quiet line
   rather than the owner's bubble (2026-11-26, the owner's pick of two designs). News that arrives back to back is one
   block: a heading saying how many and, where they all say it, what became of them; one line per subagent; and the
   cause, where they share one, said once under them. What the agent was actually told is one press away on each line. */

// How each kind reads at a glance: a failure the agent must act on in red, a move or a question in amber, the rest quiet.
const TONE = {
    movedHere: `warning`,
    stopped: `danger`,
    restarted: `neutral`,
    otherModel: `warning`,
    fellBack: `warning`,
    working: `neutral`,
    notStarted: `danger`,
    allowed: `neutral`,
    messageLost: `danger`,
    answerLost: `danger`,
    question: `warning`,
    landed: `success`,
    landConflict: `danger`,
    drift: `warning`,
} as const satisfies Record<ChildNewsKind, Tone>;

export const newsTone = (news: TranscriptChildNews): Tone => TONE[news.kind];

/** What became of it, in a few words of the reader's language, said after its name. */
export const newsLabel = (news: TranscriptChildNews): string => {
    switch (news.kind) {
        case `movedHere`:
            return t(`chat.noticeNews.kind.movedHere`, { runner: news.runner ?? `` });
        case `otherModel`:
            return t(`chat.noticeNews.kind.otherModel`, { model: news.model ?? `` });
        case `fellBack`:
            return t(`chat.noticeNews.kind.fellBack`, { model: news.model ?? `` });
        default:
            return t(`chat.noticeNews.kind.${news.kind}`);
    }
};

// Worst first: the rail beside a block wears the loudest tone among its lines.
const RANK: readonly Tone[] = [`danger`, `warning`, `info`, `success`, `neutral`];

// A sentence ends at a stop followed by a space or the end, so a version ("0.0.0") or a file name never cuts it.
const SENTENCE = /^[\s\S]*?[.!?](?=\s|$)/u;

/** A cause's first sentence, for the line under a block; the whole of it is in each line's "what the agent was told". */
export const firstSentence = (text: string): string => (SENTENCE.exec(text.trim())?.[0] ?? text).trim();

export interface NewsBlock {
    // Over more than one line: how many, and what became of them where every line says the same. Absent over one.
    readonly heading: string | undefined;
    // Whether the heading already says what became of them, so the lines need not repeat it.
    readonly shared: boolean;
    // The cause the lines share (the one line's own, for one), first sentence only; absent where they differ.
    readonly cause: string | undefined;
    readonly tone: Tone;
    // A runner could not take them: the Devices view is where that runner is updated or looked into.
    readonly devices: boolean;
}

export const newsBlock = (items: readonly TranscriptChildNews[]): NewsBlock => {
    const labels = new Set(items.map(newsLabel));
    const causes = new Set(items.map((news) => news.cause));
    const shared = items.length > 1 && labels.size === 1;
    const cause = causes.size === 1 ? [...causes][0] : undefined;
    const count = t(`chat.noticeNews.count`, { count: items.length }, items.length);
    const tones = new Set(items.map(newsTone));
    return {
        heading: items.length > 1 ? (shared ? `${count} · ${[...labels][0]!}` : count) : undefined,
        shared,
        cause: cause === undefined ? undefined : firstSentence(cause),
        tone: RANK.find((tone) => tones.has(tone)) ?? `neutral`,
        devices: items.some((news) => news.kind === `movedHere`),
    };
};
