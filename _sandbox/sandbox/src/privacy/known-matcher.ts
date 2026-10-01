// Finds every value the vault already holds, exactly as written, wherever it stands as a whole word. Indexed by each
// value's first word rather than as one automaton: the vault can hold tens of thousands of values (a taught dataset),
// and a trie over all of them costs a node per character, while a map of first words costs one entry per distinct word
// and a text is scanned once, word by word.

export interface KnownValue<C> {
    readonly value: string;
    readonly payload: C;
}

export interface KnownMatch<C> {
    readonly start: number;
    readonly end: number;
    readonly payload: C;
}

export interface KnownMatcher<C> {
    readonly find: (text: string) => KnownMatch<C>[];
    readonly size: number;
}

const WORD = /[\p{L}\p{N}]+/gu;
const WORD_CHAR = /[\p{L}\p{N}]/u;

const isWordChar = (char: string | undefined): boolean => char !== undefined && WORD_CHAR.test(char);

interface Candidate<C> {
    readonly value: string;
    // Characters before the value's first word: `+48 600…` is found from its `48`.
    readonly lead: number;
    readonly payload: C;
}

// Whole-word on each side the value itself is a word on: `Ala` is not found inside `Alabama`, and `85010112345` not
// inside a longer number, while a value that ends in punctuation needs nothing after it.
const boundedAt = (text: string, value: string, start: number): boolean => {
    const end = start + value.length;
    const before = isWordChar(value[0]) && isWordChar(text[start - 1]);
    const after = isWordChar(value.at(-1)) && isWordChar(text[end]);
    return !before && !after;
};

export const createKnownMatcher = <C>(values: readonly KnownValue<C>[]): KnownMatcher<C> => {
    const byWord = new Map<string, Candidate<C>[]>();
    for (const { value, payload } of values) {
        const first = /[\p{L}\p{N}]+/u.exec(value);
        if (first === null) {
            continue;
        }
        const list = byWord.get(first[0]) ?? [];
        list.push({ value, lead: first.index, payload });
        byWord.set(first[0], list);
    }
    // Longest first, so `Jan Kowalski` wins over `Jan` at the same place without comparing every pair.
    for (const list of byWord.values()) {
        list.sort((left, right) => right.value.length - left.value.length);
    }
    return {
        size: values.length,
        find: (text) => {
            if (byWord.size === 0) {
                return [];
            }
            const found: KnownMatch<C>[] = [];
            let covered = 0;
            for (const word of text.matchAll(WORD)) {
                const candidates = byWord.get(word[0]);
                if (candidates === undefined) {
                    continue;
                }
                for (const candidate of candidates) {
                    const start = word.index - candidate.lead;
                    if (start < covered || !text.startsWith(candidate.value, start) || !boundedAt(text, candidate.value, start)) {
                        continue;
                    }
                    found.push({ start, end: start + candidate.value.length, payload: candidate.payload });
                    covered = start + candidate.value.length;
                    break;
                }
            }
            return found;
        },
    };
};
