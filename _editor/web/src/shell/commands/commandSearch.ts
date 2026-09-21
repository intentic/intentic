import { GO_TO, SANDBOX, SETTINGS } from "./categories";
import { commandLabel, type RegisteredCommand } from "./useCommands";

// How a typed query picks rows by name, shared by the palette (every kind of row it lists), the command registry's own
// ranking and the Keybindings page, so the same words find the same rows everywhere. Two rules, both about how people
// actually type:
// - every whitespace-separated term has to appear somewhere, in any order: "secrets sandbox" finds "Sandbox: Secrets",
//   which a single substring match refuses.
// - a match on what the row is called beats a match on its id, and the start of a word beats the middle of one, so
//   the row someone typed the first letters of is the row under the cursor.

// The four tiers a name match lands in, as fractions of one: the same 0..1 axis a path scores on
// (@intentic/base/fuzzy), which is what lets the palette order files against agents, terminals and commands.
const NAME_PREFIX = 0.95;
const WORD_START = 0.8;
const IN_NAME = 0.6;
const IN_ID = 0.3;

const terms = (query: string): readonly string[] => query.trim().toLowerCase().split(/\s+/u).filter((term) => term.length > 0);

// Whether `term` starts a word in `text`: the string's own start, or any position after a space or a punctuation mark
// the app's titles use.
const startsWord = (text: string, term: string): boolean => {
    let at = text.indexOf(term);
    while (at !== -1) {
        if (at === 0 || /[\s:.…—-]/u.test(text.charAt(at - 1))) {
            return true;
        }
        at = text.indexOf(term, at + 1);
    }
    return false;
};

/** How well one row answers the query, or undefined when a term is missing from both its name and its id. */
export const nameScore = (label: string, identifier: string, query: string): number | undefined => {
    const wanted = terms(query);
    if (wanted.length === 0) {
        return 0;
    }
    const name = label.toLowerCase();
    const id = identifier.toLowerCase();
    if (!wanted.every((term) => name.includes(term) || id.includes(term))) {
        return undefined;
    }
    if (name.startsWith(wanted.join(` `))) {
        return NAME_PREFIX;
    }
    if (wanted.every((term) => startsWord(name, term))) {
        return WORD_START;
    }
    if (wanted.every((term) => name.includes(term))) {
        return IN_NAME;
    }
    return IN_ID;
};

const DESTINATIONS: ReadonlySet<string> = new Set([GO_TO, SANDBOX, SETTINGS]);

// Where you can go, versus what you can do. Only used with nothing typed, and for two reasons: a palette opened to be
// read is a menu of places first, and the row a bare Enter lands on is then a navigation rather than an action.
const isDestination = (entry: RegisteredCommand): number => (DESTINATIONS.has(entry.category ?? ``) ? 0 : 1);

/**
 * The query's answer: matching commands, best first, ties broken by name so the order is stable and families sit
 * together. An empty query is every command — destinations first, then alphabetically, which groups "Sandbox: …"
 * into one run.
 */
export const rankCommands = <T extends RegisteredCommand>(entries: readonly T[], query: string): readonly T[] => {
    const browsing = terms(query).length === 0;
    return entries
        .flatMap((entry) => {
            const score = nameScore(commandLabel(entry), entry.command, query);
            return score === undefined ? [] : [{ entry, score, label: commandLabel(entry) }];
        })
        .toSorted((left, right) =>
            browsing
                ? isDestination(left.entry) - isDestination(right.entry) || left.label.localeCompare(right.label)
                : right.score - left.score || left.label.localeCompare(right.label),
        )
        .map((ranked) => ranked.entry);
};
