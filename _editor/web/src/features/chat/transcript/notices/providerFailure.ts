import { t } from "@intentic/ui/i18n";

/*
 * A failure as a person reads it in the chat: one line saying what happened, and the rest of what was said one press
 * away. A provider answers a stopped turn with anything from a clause to six paragraphs (the Claude CLI's safeguard flag
 * runs to 630 characters: a policy link, an apology, advice, a help article, a category and two ids), and the row drew
 * all of it as one centred run with its paragraph breaks gone. The line keeps the first sentence, or this build's own
 * words for a failure it knows; the details keep everything, word for word, with the ids a support request asks for
 * pulled out to copy.
 */

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

// The Claude CLI's safeguard flag, with the model it names: "Opus 5.5's safeguards flagged this session".
const SAFEGUARD = /^(.{1,40}?)'s safeguards flagged this (message|session)\b/i;

// A JSON error body a routed provider answered with, read for the sentence it carries.
const BODY_MESSAGE = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/;

// Where a sentence stops reading as a claim and starts reading as a dump: a colon followed by a path, a URL or a body.
const DUMP = /:\s+(?=file:|https?:\/\/|\/|\{|\[)/;

const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/g;
const HAS_URL = /https?:\/\//;

// What the Claude CLI appends under its message, each on a line of its own (or run together on a CLI that flattens them).
const FACTS = [
    { key: `category`, pattern: /\bDetails:\s*`?\[([^\]`\s]+)\]`?/ },
    { key: `request`, pattern: /\bRequest ID:\s*([\w-]+)/ },
    { key: `message`, pattern: /\bMessage ID:\s*([\w-]+)/ },
] as const;
const LEARN_MORE = /\bLearn more:\s*(https?:\/\/\S+)/;

// Marks only a provider's or a harness's failure carries, for a row that carries no code to say it is one: a sandbox
// older than its failure codes, or a provider's words the sandbox does not name.
const PROVIDER_MARKERS = [/\bAPI Error\b/, /\bRequest ID:/, /\bsafeguards flagged this\b/i, /\berror result:/i, /\bstderr:/, /\bunexpected status \d{3}\b/i, /\n\s+at /];

export type FailureFactKey = (typeof FACTS)[number][`key`];

export interface FailureFact {
    readonly key: FailureFactKey;
    readonly value: string;
}

/** One run of the details' prose: words, or a link the provider gave. */
export type FailureRun = { readonly text: string } | { readonly url: string; readonly label: string };

export interface FailureDetails {
    /** Everything said but the facts below, its paragraphs kept, its links live. */
    readonly prose: readonly FailureRun[];
    /** The category, request id and message id, in that order, each only where the provider gave it. */
    readonly facts: readonly FailureFact[];
    /** The help article the provider pointed to ("Learn more: …"). */
    readonly learnMore?: string;
}

/** Whether a row with no code is a provider's or a harness's failure, by marks no sandbox sentence carries. */
export const looksLikeProviderFailure = (text: string): boolean => PROVIDER_MARKERS.some((marker) => marker.test(text));

// The provider's own words, without the wrappers the SDK and the CLI put in front of them.
const unwrapped = (said: string): string => {
    const bare = said.trim().replace(RESULT_PREFIX, ``);
    const spoken = bare.replace(API_ERROR, ``).trim();
    if (spoken.startsWith(`{`)) {
        const inner = BODY_MESSAGE.exec(spoken)?.[1];
        if (inner !== undefined) {
            try {
                return String(JSON.parse(`"${inner}"`));
            } catch {
                // allow(silent-catch): an escape JSON refuses leaves the body as it was said.
                return spoken;
            }
        }
    }
    return spoken === `` ? bare : spoken;
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
const firstClaim = (spoken: string): string => {
    const line = spoken.split(`\n`).find((candidate) => candidate.trim() !== ``)?.trim() ?? spoken.trim();
    const sentence = firstSentence(withoutAsides(line));
    // A dump's own field name goes with it: "…, url: http://…" leaves no dangling "url".
    const dump = DUMP.exec(sentence);
    return settled(dump !== null && dump.index >= 12 ? sentence.slice(0, dump.index).replace(/,\s*[\w-]+$/, ``) : sentence);
};

// This build's own words for a safeguard flag, naming the model where the CLI did.
const safeguardLine = (spoken: string, code: string | undefined): string | undefined => {
    const flagged = SAFEGUARD.exec(spoken);
    if (flagged !== null) {
        const model = flagged[1]!.trim();
        return flagged[2]!.toLowerCase() === `session`
            ? t(`chat.providerFailure.flaggedSession`, { model })
            : t(`chat.providerFailure.flaggedMessage`, { model });
    }
    return code === `safeguard-flagged` ? t(`chat.providerFailure.flagged`) : undefined;
};

// A sentence without its closing stop, to compare two that differ only by one.
const unpunctuated = (text: string): string => text.replace(/[\s.!?…]+$/u, ``);

/**
 * The one line a failure is drawn as, in the reader's language where this build knows the failure, else the first
 * thing the provider said; undefined where the message is already short enough to be its own line.
 */
export const failureHeadline = (said: string, code?: string): string | undefined => {
    const whole = said.trim();
    if (whole.length <= SHORT && !whole.includes(`\n`)) {
        return undefined;
    }
    const spoken = unwrapped(whole);
    const line = safeguardLine(spoken, code) ?? firstClaim(spoken);
    // A line that says all of it, give or take the full stop it was given, folds nothing away and opens no details.
    return unpunctuated(line) === unpunctuated(whole) ? undefined : line;
};

// A link's words: its address without the scheme, the `www.` or a closing slash.
const linkLabel = (url: string): string => url.replace(/^https?:\/\/(?:www\.)?/, ``).replace(/\/$/, ``);

// The prose as runs, its links live; a full stop or a bracket closing the sentence is not part of the address.
const runs = (prose: string): FailureRun[] => {
    const out: FailureRun[] = [];
    let from = 0;
    for (const match of prose.matchAll(URL_PATTERN)) {
        const url = match[0].replace(/[.,;:!?)\]]+$/, ``);
        const start = match.index;
        if (start > from) {
            out.push({ text: prose.slice(from, start) });
        }
        out.push({ url, label: linkLabel(url) });
        from = start + url.length;
    }
    if (from < prose.length) {
        out.push({ text: prose.slice(from) });
    }
    return out;
};

/** Everything a failure said, laid out to read: its prose with live links, and the facts it carried pulled out. */
export const failureDetails = (said: string): FailureDetails => {
    let prose = said.trim();
    const facts: FailureFact[] = [];
    for (const { key, pattern } of FACTS) {
        const found = pattern.exec(prose);
        if (found !== null) {
            facts.push({ key, value: key === `category` ? found[1]!.replace(/_/g, ` `) : found[1]! });
            prose = prose.replace(found[0], ``);
        }
    }
    const learnMore = LEARN_MORE.exec(prose);
    if (learnMore !== null) {
        prose = prose.replace(learnMore[0], ``);
    }
    // What taking the facts out left: trailing spaces, doubled spaces, and blank lines where they stood.
    const tidy = prose
        .split(`\n`)
        .map((line) => line.replace(/ {2,}/g, ` `).trimEnd())
        .join(`\n`)
        .replace(/\n{3,}/g, `\n\n`)
        .trim();
    const details = { prose: runs(tidy), facts };
    return learnMore === null ? details : { ...details, learnMore: learnMore[1]!.replace(/[.,;:!?)\]]+$/, ``) };
};
