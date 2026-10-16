import { addressAfter, announcedBy, fieldBefore, openedByQuote } from "./name-context.js";
import { type Join, joinOf, type Token, tokenize } from "./name-tokens.js";
import type { Emit } from "./text.js";

// Person names, from the first-name and surname registers with Polish inflection, read in context. A word the lists
// know is never a name by itself: almost every first name is also a word somewhere ("Mark", "Max", "Luna"), a title,
// a button label or the start of a sentence. A find needs a first name with a surname that is no ordinary word, in
// either order, or a context that says a person is named: a title before it, a person's field around it, a personal
// address after it.

// One run of capitalized words joined by spaces or cell separators, and what the rules need to read it.
interface Run {
    readonly text: string;
    readonly tokens: readonly Token[];
    // joins[i] joins tokens[i] and tokens[i + 1].
    readonly joins: readonly Join[];
    readonly emit: Emit;
}

// A rule reads the run at a token and either reports a name and says where to go on, or passes.
type Rule = (run: Run, at: number, token: Token) => number | undefined;

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

// A title says a person follows, whatever the word: "Pan Nowak", "dr Nowak", "Mr. Smith", unless a thing's noun
// follows the name ("Pan American Games"). A title that is also a word (Miss, Lady) says so only of a name the lists
// know and no word shares; an office or a relation only of a surname no word or first name shares: "prezes Kowalski",
// not "kolega Marek" or "klienta Google". A street or a town is named after people and with surname-like adjectives
// ("przy ulicy Grodzkiej"), so after a place word the whole name is the place's.
const announced: Rule = (run, at, token) => {
    const announcer = token.never ? undefined : announcedBy(run.text, token.start);
    if (announcer === undefined) {
        return undefined;
    }
    const to = extend(run, at, announcer === "place" ? 4 : 3, namePart);
    if (announcer === "place" || namesThing(run, to)) {
        return to + 1;
    }
    const stretch = run.tokens.slice(at, to + 1);
    const vouched =
        announcer === "honorific" ||
        (announcer === "title" && stretch.some((part) => part.firstStrong || part.surnameStrong)) ||
        (announcer === "role" && stretch.some((part) => part.surnameStrong && !part.first));
    return vouched ? report(run, at, to) : undefined;
};

// A field, a header or a personal address says the same, but the words must still be names: "lastName": "Nowak" yes,
// "author": "Wait until ready" no. Only a field for one part of a name vouches for one word; a field for a whole
// person, a header and a display name before somebody's address want two ("author": "Jan Kowalski", not "owner": "Luna").
const labelled: Rule = (run, at, token) => {
    const startsValue = at === 0 || run.joins[at - 1] === "cell";
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
    // A value that goes on in lowercase is a sentence, not a name: "user": "Drop it until ready" is a task.
    const field = PROSE_AFTER.test(run.text.slice(end, end + 3)) ? undefined : fieldBefore(run.text, token.start, token.line);
    const enough = field === "name-part" || ((field === "person" || address === "personal") && to > at);
    return enough && (unambiguous || listed) ? report(run, at, to) : undefined;
};
const PROSE_AFTER = /^ \p{Ll}/u;

// Whether the word right after a name makes it the name of a thing: "Victoria Station", "Renovate Bot".
const namesThing = (run: Run, last: number): boolean => run.joins[last] === "space" && run.tokens[last + 1]?.thing === true;

// First name and surname: "Jan Kowalski", "Annie Kowalskiej", "Jan|Kowalski" in a row. The surname must be one no word
// shares (a listed surname that is not an ordinary word, or a -ski, -cki, -wicz or -czyk form): a capitalized word the
// lists do not know may be anything ("Natalia Restaurant"), and a first name followed by nothing is no find at all.
// When the first names run on with no surname after them, the last of them may itself be a surname: "Anna Bartosz".
const firstName: Rule = (run, at, token) => {
    if (!token.first) {
        return undefined;
    }
    const last = extend(run, at, 3, (next) => next.first);
    if (namesThing(run, last)) {
        return last + 2;
    }
    // Neighbouring cells make one name only in a row of data, and the next must be no first name too: "Anna, Marek" is a
    // list of first names.
    const next = run.tokens[last + 1];
    if (next?.surnameStrong === true && (run.joins[last] === "space" || (!next.first && next.line.data))) {
        return report(run, at, last + 1);
    }
    if (last > at && run.tokens[last]?.surnameStrong === true) {
        return report(run, at, last);
    }
    return last + 1;
};

// Surname first, as Polish lists write it: "Kowalski Jan", "Nowak, Anna". Before a space the surname must have a
// surname's suffix too, or every listed word that starts a sentence would claim the name after it.
const surnameFirst: Rule = (run, at, token) => {
    const next = run.tokens[at + 1];
    if (next?.first !== true) {
        return undefined;
    }
    const reversed = run.joins[at] === "cell" ? token.line.data && token.surnameStrong && !token.first : token.surnameSuffixed;
    return reversed
        ? report(
              run,
              at,
              extend(run, at + 1, 3, (part) => part.first),
          )
        : undefined;
};

const RULES: readonly Rule[] = [announced, labelled, firstName, surnameFirst];

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
        readRun({ text, tokens: runTokens, joins, emit });
        from = to + 1;
    }
};
