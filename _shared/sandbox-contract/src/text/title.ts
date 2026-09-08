// The title a chat tab, fleet card and agent detail header show until a model names the conversation. Reads the prompt
// as prose first, stripping openers, quotes and fences, and cuts on a sentence or word boundary rather than truncating
// at a fixed length. Browser and daemon both call this so a prompt titles the same regardless of where it enters.

// Storage cap mirroring agents-registry MAX_TITLE_LENGTH and the rename input's maxlength.
const MAX_LENGTH = 80;
// Below this length a sentence-shaped cut is more likely an abbreviation (`e.g.`) than a real sentence.
const MIN_SENTENCE = 12;
// A word-boundary cut before this point strands a fragment; cutting mid-word beats a near-empty title.
const MIN_WORD_CUT = MAX_LENGTH * 0.6;

// Fence and quote markers; a fence toggles open/closed, so an unterminated one swallows the rest of the prompt.
const FENCE = /^\s*(?:```|~~~)/;
const QUOTE = /^\s*>/;

// Ways an ask opens without starting; stripped repeatedly, so `Hey, can you please …` unwinds one layer per pass.
const OPENERS: readonly RegExp[] = [
    /^(?:hey|hi|hello|yo|ok|okay|so|well|also|btw|now|next|then)\b[\s,.:;!—–-]*/i,
    /^(?:please|pls)\b[\s,.:;!—–-]*/i,
    /^(?:can|could|would|will)\s+(?:you|u|we)\b\s*(?:please|pls)?[\s,.:;!—–-]*/i,
    /^i(?:'d|\s+would)?\s+(?:want|need|like)\s+(?:you\s+)?to\b[\s,.:;!—–-]*/i,
    /^(?:let'?s|lets)\b[\s,.:;!—–-]*/i,
    /^we\s+(?:need|have|ought)\s+to\b[\s,.:;!—–-]*/i,
    /^(?:quick\s+(?:one|question|q)|one\s+more\s+thing)\b[\s,.:;!—–-]*/i,
];

// Terminal punctuation followed by a break; keeps `v1.2` and `foo.ts` intact while still ending `Why is it red?`.
const SENTENCE_END = /[.!?](?=\s|$)/;

// Matches a first sentence reporting past work (`We just landed…`); that is scene-setting, not the ask.
const NARRATION =
    /^(?:(?:recently|previously|earlier|today|yesterday|lately)[\s,]+)?(?:we|i)(?:'ve|'d|'m|'re)?(?:\s+(?:have|had|am|are|was|were|been|just|recently|already|earlier|previously|also|finally|now|currently|still))*\s+(?!(?:need|feed|speed|shed|heed|breed|bleed|embed|proceed|exceed|succeed)\b)(?:\w+ed|\w{3,}ing|built|wrote|rewrote|made|found|saw|thought|began|got|kept|put|set|sent|split|ran|did|redid|went|came|gave|held|hit|cut|let|read|understood|broke|chose|became|brought|spent|meant|lost|forgot|rebuilt|told|taught|stood|drew|grew|knew|threw|took|left|felt|hid)\b/i;

// Curated imperative verbs coding asks lead with, not full grammar: English underdetermines verb/noun forms.
const IMPERATIVE =
    /^(?:add|fix|make|implement|create|build|write|rewrite|refactor|rename|remove|delete|drop|update|change|convert|migrate|move|extract|split|merge|rebase|revert|restore|wire|connect|integrate|support|handle|improve|clean|simplify|redesign|rework|rethink|investigate|analyze|analyse|debug|find|figure|check|verify|test|run|try|document|describe|explain|propose|design|draft|prepare|stop|prevent|ensure|allow|enable|disable|introduce|replace|swap|optimize|optimise|reduce|bump|upgrade|deploy|ship|release|adjust|tweak|polish|finish|complete|continue|extend|unify|dedupe|deduplicate|cache|persist|expose|hide|show|render|port|automate|wrap|inline|audit|review|profile|measure|instrument|validate|parse|generate|turn|look|think|come|consider|help|start|use|keep|avoid|teach|harden|tighten|localize|localise|translate)\b/i;

// An unmistakable ask: an instruction verb, or a question mark.
const isAsk = (sentence: string): boolean => sentence.endsWith("?") || IMPERATIVE.test(sentence);

const collapse = (text: string): string =>
    text
        .replaceAll(/[\p{Cc}\p{Cf}]+/gu, " ")
        .replaceAll(/\s+/g, " ")
        .trim();

// Prompt lines minus fenced code blocks and quoted lines; those are evidence attached to the ask, not the ask itself.
const proseLines = (prompt: string): string[] => {
    const lines: string[] = [];
    let fenced = false;
    for (const line of prompt.split(/\r?\n/)) {
        if (FENCE.test(line)) {
            fenced = !fenced;
            continue;
        }
        if (!fenced && !QUOTE.test(line)) {
            lines.push(line);
        }
    }
    return lines;
};

// Strips openers only when a multi-word remnant is left; a one-word remnant (`Hi there`) or an empty one means the line
// was pure greeting, so the original line stands or the caller reads on.
const withoutOpener = (line: string): string => {
    let text = line;
    for (let pass = 0; pass < OPENERS.length; pass++) {
        const stripped = OPENERS.reduce((current, opener) => current.replace(opener, ""), text);
        if (stripped === text) {
            break;
        }
        text = stripped;
    }
    const remnant = text.trim();
    if (text === line || remnant === "") {
        return text;
    }
    return remnant.includes(" ") ? text : line;
};

// A URL's last meaningful path segment, or the host when there is no path; a purely numeric last segment keeps the
// segment before it (`merge_requests/42`).
const shortUrl = (token: string): string => {
    let url: URL;
    try {
        url = new URL(token);
    } catch {
        return token;
    }
    const segments = url.pathname.split("/").filter((segment) => segment !== "");
    const last = segments.at(-1);
    if (last === undefined) {
        return url.hostname.replace(/^www\./, "");
    }
    const previous = segments.at(-2);
    return /^\d+$/.test(last) && previous !== undefined ? `${previous}/${last}` : last;
};

// A path's basename once the path is deep enough that the leading segments are just scaffolding.
const shortPath = (token: string): string => {
    const segments = token.replace(/^@/, "").split("/");
    return segments.length > 2 ? (segments.findLast((segment) => segment !== "") ?? token) : token;
};

// Sets trailing punctuation aside across shortening a URL or path token and reattaches it after.
const shortReference = (token: string): string => {
    const match = /^(.*?)([\s,.;:!?)\]]*)$/s.exec(token);
    const core = match?.[1] ?? token;
    const tail = match?.[2] ?? "";
    if (/^https?:\/\//i.test(core)) {
        return `${shortUrl(core)}${tail}`;
    }
    if (core.includes("/")) {
        return `${shortPath(core)}${tail}`;
    }
    return token;
};

const collapseReferences = (text: string): string => text.split(" ").map(shortReference).join(" ");

const firstSentence = (text: string): string => {
    const end = text.search(SENTENCE_END);
    if (end < MIN_SENTENCE) {
        return text;
    }
    // Keep `?`/`!`; drop a trailing `.` as noise on a title.
    const terminator = text[end];
    return terminator === "." ? text.slice(0, end) : text.slice(0, end + 1);
};

// Splits text into sentences with the same terminator rule as firstSentence; no abbreviation guard, since a fragment
// split at `e.g.` never starts with an imperative.
const sentencesOf = (text: string): string[] => {
    const parts: string[] = [];
    let rest = text;
    while (rest !== "") {
        const end = rest.search(SENTENCE_END);
        if (end === -1) {
            parts.push(rest);
            break;
        }
        parts.push(rest[end] === "." ? rest.slice(0, end) : rest.slice(0, end + 1));
        rest = rest.slice(end + 1).trimStart();
    }
    return parts;
};

// Cuts to MAX_LENGTH including the ellipsis: AgentTurnSchema.title enforces this as a hard cap, so appending `…` after
// truncating can exceed it. Falls back to a mid-word cut when no word boundary falls within MIN_WORD_CUT of the end.
const clamped = (text: string): string => {
    if (text.length <= MAX_LENGTH) {
        return text;
    }
    const cut = text.slice(0, MAX_LENGTH - 1);
    const boundary = cut.lastIndexOf(" ");
    const kept = boundary >= MIN_WORD_CUT ? cut.slice(0, boundary) : cut;
    return `${kept.replace(/[\s,;:—–-]+$/, "")}…`;
};

// Capitalizes only when the first word is plain lowercase prose; an identifier, path or abbreviation keeps its casing.
const capitalized = (text: string): string => {
    const [first = ""] = text.split(" ", 1);
    if (!/^[a-z]/.test(first) || /[A-Z/.\\]/.test(first)) {
        return text;
    }
    return `${text[0]?.toUpperCase() ?? ""}${text.slice(1)}`;
};

// Splits a plan's markdown into its heading and body; the heading is the one line naming the whole job rather than a
// step, so both browser and daemon title from it.
export const planParts = (text: string): { title?: string; body: string } => {
    const match = /^\s*#{1,6}\s+(.+)/.exec(text);
    if (match === null) {
        return { body: text };
    }
    return { title: match[1]!.trim(), body: text.slice(match.index + match[0].length).trimStart() };
};

// Derives a conversation's title from its opening prompt; never empty for a non-empty prompt, since a pure paste titles
// as its own first line.
export const deriveTitle = (prompt: string): string => {
    const prose = proseLines(prompt)
        .map(collapse)
        .filter((line) => line !== "");
    // Prose lines, openers stripped, letters required; first is the default title, rest matter only if narration.
    const lines = prose.map(withoutOpener).filter((line) => /\p{L}/u.test(line));
    const primary = lines[0];
    if (primary !== undefined) {
        // A narration head is scene-setting; look further for an unmistakable ask, else keep the narration.
        const head = firstSentence(primary);
        const ask = NARRATION.test(head)
            ? lines
                  .flatMap(sentencesOf)
                  .map(withoutOpener)
                  .find((sentence) => sentence !== head && isAsk(sentence))
            : undefined;
        return capitalized(clamped(firstSentence(collapseReferences(ask ?? primary))));
    }
    // Nothing had letters (code, quote or greeting only); title as the first raw line rather than leaving it blank.
    const fallback = prose[0] ?? collapse(prompt.replaceAll(/^\s*(?:```|~~~).*$/gm, ""));
    return clamped(collapseReferences(fallback === "" ? collapse(prompt) : fallback));
};
