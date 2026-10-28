// Typing a name to land on it, as every desktop file manager's list does: letters typed close together build a prefix,
// and the next entry whose name starts with it is the one selected. A lone letter typed again steps on to the next
// name starting with it, so `s s s` walks through the s's; a longer prefix stays on the entry it already matches, so
// typing `src` does not hop off `src` at the `r`. Pure, no DOM: the caller hands in what was pressed and when.

// How long a pause ends the word being typed; Files and Windows Explorer wait about this long.
export const TYPE_AHEAD_PAUSE_MS = 800;

export type TypedPress = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey">;

export interface TypeAhead {
    // The character this press adds to the word, or undefined when it is not typing. A space only continues a word
    // already begun, since on its own Space is the list's own key.
    readonly typed: (press: TypedPress, now: number) => string | undefined;
    // The word so far with this character added, starting a new one after a pause.
    readonly add: (character: string, now: number) => string;
}

export const createTypeAhead = (pauseMs = TYPE_AHEAD_PAUSE_MS): TypeAhead => {
    let word = ``;
    let lastAt = Number.NEGATIVE_INFINITY;
    const active = (now: number): boolean => word !== `` && now - lastAt <= pauseMs;
    return {
        typed: (press, now) => {
            if (press.ctrlKey || press.metaKey || press.altKey || [...press.key].length !== 1) {
                return undefined;
            }
            return press.key === ` ` && !active(now) ? undefined : press.key;
        },
        add: (character, now) => {
            word = (active(now) ? word : ``) + character.toLocaleLowerCase();
            lastAt = now;
            return word;
        },
    };
};

// `aaa` is the letter a pressed three times, which means "the third a", not a name starting with three a's.
const repeatsOneLetter = (word: string): boolean => word.length > 1 && [...word].every((character) => character === word[0]);

/**
 * The entry a typed word lands on: the first in `order` from the lead on (past it, for a lone letter) whose name starts
 * with the word, wrapping round to the top; undefined when none does.
 */
export const typeAheadTarget = <T>(order: readonly T[], nameOf: (item: T) => string, lead: T | null, word: string): T | undefined => {
    if (order.length === 0 || word === ``) {
        return undefined;
    }
    const steps = repeatsOneLetter(word);
    const prefix = steps ? (word[0] ?? ``) : word;
    const from = lead === null ? -1 : order.indexOf(lead);
    // A lone letter moves on from the entry it is on; a word still being typed may already be on its match.
    const first = steps || prefix.length === 1 ? from + 1 : Math.max(from, 0);
    for (let offset = 0; offset < order.length; offset++) {
        const item = order[(first + offset) % order.length];
        if (item !== undefined && nameOf(item).toLocaleLowerCase().startsWith(prefix)) {
            return item;
        }
    }
    return undefined;
};
