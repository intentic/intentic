import { addressAfter, announcedBy, type Label, labelBefore, openedByQuote, quotedAlone } from "./name-context.js";
import { type Join, joinOf, type Token, tokenize } from "./name-tokens.js";
import type { Emit } from "./text.js";

// Person names, from the first-name and surname registers with Polish inflection, read in context. A capitalized word
// is a name part when the lists say so; whether the find is reported depends on how much else agrees: a surname beside
// a first name, a title before it, a "name" field around it, or nothing but a first name no other word shares.

// One run of capitalized words joined by spaces or cell separators, and what the rules need to read it.
interface Run {
    readonly text: string;
    readonly tokens: readonly Token[];
    // joins[i] joins tokens[i] and tokens[i + 1].
    readonly joins: readonly Join[];
    readonly heading: readonly boolean[];
    readonly emit: Emit;
}

// A rule reads the run at a token and either reports a name and says where to go on, or passes.
type Rule = (run: Run, at: number, token: Token) => number | undefined;

const SENTENCE_END = /(?:^|[.!?:]\s+|\n\s*)$/u;
const sentenceStart = (text: string, start: number): boolean => SENTENCE_END.test(text.slice(Math.max(0, start - 4), start));

// A run of three or more spaced capitalized words of which two are not names is a heading or a product ("Adam
// Optimizer Configuration", "Julia Language Server"): only a first name with a listed surname counts inside one. The
// first word of a sentence is capitalized whatever it is, so it does not count: "Spotkałem Bożydara Kowalskiego".
const headingLike = (text: string, tokens: readonly Token[], joins: readonly Join[]): boolean[] => {
    const heading = tokens.map(() => false);
    let from = 0;
    for (let index = 1; index <= tokens.length; index += 1) {
        if (index < tokens.length && joins[index - 1] === "space") {
            continue;
        }
        const segment = tokens.slice(from, index);
        const opening = sentenceStart(text, segment[0]?.start ?? 0) ? 1 : 0;
        const others = segment.slice(opening).filter((token) => !token.first && !token.surname).length;
        if (segment.length >= 3 && others >= 2) {
            heading.fill(true, from, index);
        }
        from = index;
    }
    return heading;
};

// Spans over tokens from..to, one per stretch of space-joined tokens: a cell separator splits the find.
const report = (run: Run, from: number, to: number): number => {
    let start = run.tokens[from]?.start ?? 0;
    for (let index = from; index <= to; index += 1) {
        if (index === to || run.joins[index] !== "space") {
            run.emit(start, run.tokens[index]?.end ?? start, "person-name");
            start = run.tokens[index + 1]?.start ?? start;
        }
    }
    return to + 1;
};

// The last index of the longest stretch from `from` of space-joined tokens that `take` accepts, at most `max` long.
const extend = (run: Run, from: number, max: number, take: (token: Token) => boolean): number => {
    let to = from;
    for (
        let next = run.tokens[to + 1];
        next !== undefined && to - from + 1 < max && run.joins[to] === "space" && take(next);
        next = run.tokens[to + 1]
    ) {
        to += 1;
    }
    return to;
};

const namePart = (token: Token): boolean => !token.never && (token.first || token.surname || token.unknown);

// In a line of code a lone name counts only as a quoted value: "Zbigniew" yes, import { Adam } no.
const loneAllowed = (run: Run, token: Token, end: number): boolean => !token.line.code || quotedAlone(run.text, token.start, end);

// A title says a person follows, whatever the word: "Pan Wilk", "dr Nowak", "Mr. Will Smith". A role says so only of a
// word the lists know: "prezes Kowalski", not "klienta Google". A street or a town is named after people and with
// surname-like adjectives ("ulica Jana Pawła", "przy ulicy Grodzkiej"), so after a place word the whole name is the
// place's.
const announced: Rule = (run, at, token) => {
    const announcer = token.never ? undefined : announcedBy(run.text, token.start);
    if (announcer === "honorific" || (announcer === "role" && (token.first || token.surname))) {
        return report(run, at, extend(run, at, 3, namePart));
    }
    return announcer === "place" ? extend(run, at, 4, namePart) + 1 : undefined;
};

// A field, header or greeting says the same, but the words must still be names: "lastName": "Wilk" yes, "name": "Max
// Size" no. A bare "name" field takes only a name no word shares: "name": "Data" is a spreadsheet's sheet. The
// greeting may itself be capitalized ("Hi Mark"), so a word that is never a name does not hide the start of the value.
const labelled: Rule = (run, at, token) => {
    const startsValue = at === 0 || run.joins[at - 1] === "cell" || run.tokens[at - 1]?.never === true;
    if (!startsValue || !namePart(token)) {
        return undefined;
    }
    const to = extend(run, at, 4, namePart);
    if (namesThing(run, to)) {
        return to + 2;
    }
    const stretch = run.tokens.slice(at, to + 1);
    const unambiguous = stretch.some((part) => part.firstStrong || part.surnameStrong);
    const listed = stretch.every((part) => part.first || part.surname);
    const end = run.tokens[to]?.end ?? token.end;
    // The address stands after the whole display name, including words that are no name ("Renovate Bot <…>").
    const address = addressAfter(run.text, run.tokens[extend(run, to, 6, () => true)]?.end ?? end);
    if (address === "impersonal") {
        // Skipped whole: "Co-authored-by: Claude Opus <noreply@…>" names a bot, and no other rule should read it either.
        return to + 1;
    }
    // In a line of code a field's value is a name only as a string: `owner: Any` is a type, `author = config` a variable.
    if (address === undefined && token.line.code && !openedByQuote(run.text, token.start)) {
        return undefined;
    }
    const label = address === "personal" ? "person" : weakenedByProse(run.text, end, labelBefore(run.text, token.start, token.line));
    const named = label === "person" ? unambiguous || listed : label === "name" && unambiguous;
    return named ? report(run, at, to) : undefined;
};

// A value that goes on in lowercase is a sentence, not a name, and says less about its first word: "name": "Drop
// offset from route" is a task, where "name": "Anna" is somebody. A greeting keeps some weight ("Hi Anna and Tom"
// still needs an unambiguous name); a bare name field keeps none.
const weakenedByProse = (text: string, end: number, label: Label | undefined): Label | undefined => {
    if (label === undefined || !PROSE_AFTER.test(text.slice(end, end + 3))) {
        return label;
    }
    return label === "person" ? "name" : undefined;
};
const PROSE_AFTER = /^ \p{Ll}/u;

// Whether the word right after a name makes it the name of a thing: "Victoria Station", "Renovate Bot".
const namesThing = (run: Run, last: number): boolean => run.joins[last] === "space" && run.tokens[last + 1]?.thing === true;

// Whether the token after a group of first names is its surname. Across spaces an unambiguous first name takes any
// capitalized word ("Bożena Okafor"); across a cell separator the surname must be one ("Amalia, Rękawiczka" is a list
// of poems), and an ambiguous first name ("Will") needs a surname no word shares.
const surnameAfter = (run: Run, last: number, strong: boolean): boolean => {
    const next = run.tokens[last + 1];
    if (next === undefined || next.surnameStrong) {
        return next !== undefined;
    }
    if (!strong) {
        return false;
    }
    // A markdown heading capitalizes every word, so there a word nobody lists says nothing ("## Victor Charts").
    return next.surname || (run.joins[last] === "space" && next.unknown && run.heading[last + 1] !== true && !next.line.heading);
};

// First name and surname ("Jan Kowalski", "Markiem Nowakiem", "Anna Maria Nowak-Kowalska", "Jan|Kowalski"), or an
// unambiguous first name alone, outside headings.
const firstName: Rule = (run, at, token) => {
    if (!token.first) {
        return undefined;
    }
    const last = extend(run, at, 3, (next) => next.first);
    if (namesThing(run, last)) {
        return last + 2;
    }
    const strong = run.tokens.slice(at, last + 1).some((part) => part.firstStrong);
    if (surnameAfter(run, last, strong)) {
        return report(run, at, last + 1);
    }
    const end = run.tokens[last]?.end ?? token.end;
    if (strong && run.heading[at] !== true && loneAllowed(run, token, end)) {
        report(run, at, last);
    }
    return last + 1;
};

// Surname first, as Polish lists write it: "Kowalski Jan", "Nowak, Anna". Before a space the surname must have a
// surname's suffix too, or every listed word that starts a sentence would claim the name after it ("Rolę Marii").
const surnameFirst: Rule = (run, at, token) => {
    const next = run.tokens[at + 1];
    if (next?.first !== true) {
        return undefined;
    }
    const reversed = run.joins[at] === "cell" ? token.surnameStrong || (token.surname && next.firstStrong) : token.surnameSuffixed;
    return reversed
        ? report(
              run,
              at,
              extend(run, at + 1, 3, (part) => part.first),
          )
        : undefined;
};

// A surname alone, only when both the register and the suffix say so: "Kowalski", "Wiśniewskiej". That is evidence
// enough even in a heading.
const surnameAlone: Rule = (run, at, token) => (token.surnameAlone && loneAllowed(run, token, token.end) ? report(run, at, at) : undefined);

const RULES: readonly Rule[] = [announced, labelled, firstName, surnameFirst, surnameAlone];

const readRun = (run: Run): void => {
    let at = 0;
    for (let token = run.tokens[at]; token !== undefined; token = run.tokens[at]) {
        let next: number | undefined;
        for (const rule of RULES) {
            next = rule(run, at, token);
            if (next !== undefined) {
                break;
            }
        }
        at = next ?? at + 1;
    }
};

export const findNames = (text: string, emit: Emit): void => {
    const tokens = tokenize(text);
    let from = 0;
    while (from < tokens.length) {
        const joins: Join[] = [];
        let to = from;
        for (let a = tokens[to], b = tokens[to + 1]; a !== undefined && b !== undefined; a = tokens[to], b = tokens[to + 1]) {
            const join = joinOf(text, a, b);
            if (join === undefined) {
                break;
            }
            joins.push(join);
            to += 1;
        }
        const runTokens = tokens.slice(from, to + 1);
        readRun({ text, tokens: runTokens, joins, heading: headingLike(text, runTokens, joins), emit });
        from = to + 1;
    }
};
