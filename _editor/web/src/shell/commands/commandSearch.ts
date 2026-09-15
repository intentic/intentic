import { GO_TO, SANDBOX, SETTINGS } from "./categories";
import { commandLabel, type RegisteredCommand } from "./useCommands";

// How a typed query picks rows out of the command registry, shared by the palette and the Keybindings page so the same
// words find the same commands on both. Two rules, both about how people actually type:
// - every whitespace-separated term has to appear somewhere, in any order: "secrets sandbox" finds "Sandbox: Secrets",
//   which a single substring match refuses.
// - a match on what the command is called beats a match on its id, and the start of a word beats the middle of one, so
//   the row someone typed the first letters of is the row under the cursor.

/** Matched on the label (name and family) versus matched only on the id; the gap between tiers is what ranks. */
const NAME_PREFIX = 4;
const WORD_START = 3;
const IN_NAME = 2;
const IN_ID = 1;

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

/** How well one command answers the query, or undefined when a term is missing from both its name and its id. */
export const commandScore = (label: string, command: string, query: string): number | undefined => {
    const wanted = terms(query);
    if (wanted.length === 0) {
        return 0;
    }
    const name = label.toLowerCase();
    const id = command.toLowerCase();
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
            const score = commandScore(commandLabel(entry), entry.command, query);
            return score === undefined ? [] : [{ entry, score, label: commandLabel(entry) }];
        })
        .toSorted((left, right) =>
            browsing
                ? isDestination(left.entry) - isDestination(right.entry) || left.label.localeCompare(right.label)
                : right.score - left.score || left.label.localeCompare(right.label),
        )
        .map((ranked) => ranked.entry);
};
