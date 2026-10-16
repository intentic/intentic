// Whether a heard phrase was said to the agent by name, and what was asked of it: "Leon, fix the build" is the wake word
// and the request "fix the build". Read off the sandbox model's own transcript of the phrase, so the word has to be the
// phrase's first (after a "hey" at most): a name said in passing ("I told Leon yesterday") is talk, not a call. The
// model writes a name the way it heard it ("Léon", "Leone", "Le on"), so accents, inflections and a split are forgiven,
// and a longer word is matched within a letter or two.
// Pure: the listener (useWakeListener.ts) and the router (wakeRoute.ts) are the ones that act on it.

/** What follows the wake word: the request, as the transcript wrote it, or "" for the name said on its own. */
export interface WakeHeard {
    readonly request: string;
}

// The openers a person puts before a name ("Hey Leon", "Hej Leon", "OK Leon"), in the languages the model hears best.
const OPENERS: ReadonlySet<string> = new Set([`hey`, `hi`, `hello`, `ok`, `okay`, `hej`, `halo`, `hallo`, `hola`, `oye`, `yo`, `ey`, `eh`]);

// One word of the transcript, where it sits, so the request keeps the transcript's own casing and punctuation.
interface Word {
    readonly folded: string;
    readonly end: number;
}

/** Lowercased, accents gone: how a heard word and the wake word are compared ("Léon" is "leon"). */
export const foldWord = (text: string): string => text.normalize(`NFKD`).replaceAll(/\p{M}/gu, ``).toLowerCase().replaceAll(/['’-]/gu, ``);

const wordsOf = (text: string): Word[] =>
    Array.from(text.matchAll(/[\p{L}\p{M}\p{N}'’-]+/gu), (match) => ({ folded: foldWord(match[0]), end: (match.index ?? 0) + match[0].length })).filter(
        (word) => word.folded !== ``,
    );

// Edit distance, for words a dozen letters long at most: the plain table is cheaper than anything clever.
const distance = (a: string, b: string): number => {
    let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let i = 1; i <= a.length; i += 1) {
        const current = [i];
        for (let j = 1; j <= b.length; j += 1) {
            current[j] = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
        previous = current;
    }
    return previous[b.length] ?? Math.max(a.length, b.length);
};

// How far a heard spelling may stray from the word: none for a short one (four letters have too many neighbours: Leon
// is one letter from lean, lion, neon and lemon), one letter up to seven, two beyond.
const slack = (word: string): number => (word.length <= 4 ? 0 : word.length <= 7 ? 1 : 2);

// A name called is often inflected: Polish calls Leon "Leonie", and a model hears "Leona". Up to two letters after the
// whole word still call it; "Leonard" is someone else.
const INFLECTION = 2;

const sounds = (heard: string, target: string): boolean =>
    distance(heard, target) <= slack(target) || (target.length >= 4 && heard.startsWith(target) && heard.length - target.length <= INFLECTION);

/** The wake word as compared: its words run together ("Hey Leon" is "heyleon"), so a model that splits or joins them still matches. */
const joinedWord = (wake: string): string => wordsOf(wake).map((word) => word.folded).join(``);

/**
 * The request in a phrase that opens with the wake word, or undefined for a phrase that does not: the wake word's own
 * words (joined or split however the model wrote them) are its first, after one opener at most.
 */
export const wakeHeard = (text: string, wake: string): WakeHeard | undefined => {
    const target = joinedWord(wake);
    if (target === ``) {
        return undefined;
    }
    const words = wordsOf(text);
    const wakeWords = wordsOf(wake).length;
    const starts = words[0] !== undefined && OPENERS.has(words[0].folded) && !OPENERS.has(target) ? [0, 1] : [0];
    for (const start of starts) {
        // The wake word may come out as one word more or one fewer than it has ("Le on", "Hey Leon" as "heyleon").
        for (let count = Math.max(1, wakeWords - 1); count <= wakeWords + 1 && start + count <= words.length; count += 1) {
            const heard = words
                .slice(start, start + count)
                .map((word) => word.folded)
                .join(``);
            if (sounds(heard, target)) {
                const end = words[start + count - 1]?.end ?? 0;
                return { request: text.slice(end).replace(/^[\s\p{P}]+/u, ``).trim() };
            }
        }
    }
    return undefined;
};

// "New session", "nowa sesja", "neuer Chat": asking for a fresh session outright, in the languages the model hears best.
const NEW = new Set([`new`, `nowa`, `nowy`, `nowe`, `nowej`, `neue`, `neuer`, `neues`, `neu`, `nueva`, `nuevo`, `nouvelle`, `nouveau`]);
const SESSION = new Set([
    `session`,
    `chat`,
    `conversation`,
    `task`,
    `agent`,
    `thread`,
    `sesja`,
    `sesje`,
    `sesji`,
    `rozmowa`,
    `rozmowe`,
    `czat`,
    `zadanie`,
    `watek`,
    `sitzung`,
    `unterhaltung`,
    `aufgabe`,
    `sesion`,
    `conversacion`,
    `tarea`,
    `discussion`,
    `tache`,
]);

/** A request that opens by asking for a new session, with those words taken off; undefined for any other. */
export const askedForNew = (request: string): WakeHeard | undefined => {
    const words = wordsOf(request);
    const first = words[0];
    if (first === undefined || !NEW.has(first.folded)) {
        return undefined;
    }
    const second = words[1];
    // "New" on its own asks for one with nothing in it yet; "new feature: …" is a request that happens to say "new".
    if (second === undefined) {
        return { request: `` };
    }
    if (!SESSION.has(second.folded)) {
        return undefined;
    }
    return { request: request.slice(second.end).replace(/^[\s\p{P}]+/u, ``).trim() };
};
