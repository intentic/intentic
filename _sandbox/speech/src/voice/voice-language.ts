// Which language a text is in, well enough to pick the voice that says it: a Polish reply read by an English voice is
// nonsense, whatever the reader's browser is set to. Script first (Cyrillic, Greek, Arabic, CJK, Devanagari decide on
// their own), then letters only one language uses, then the commonest short words. Below a handful of hits it is a
// guess, and the reader's own language (the hint) wins.

const SCRIPTS: readonly (readonly [RegExp, string])[] = [
    [/[぀-ヿ]/gu, "ja"],
    [/[一-鿿]/gu, "zh"],
    [/[ऀ-ॿ]/gu, "hi"],
    [/[Ͱ-Ͽ]/gu, "el"],
    [/[Ⴀ-ჿ]/gu, "ka"],
    [/[؀-ۿ]/gu, "ar"],
    [/[Ѐ-ӿ]/gu, "ru"],
];

// Letters that settle a language between those sharing a script.
const MARKS: readonly (readonly [RegExp, string, number])[] = [
    [/[ąęłńśźż]/giu, "pl", 3],
    [/[ěřůť]/giu, "cs", 3],
    [/[ľĺŕô]/giu, "sk", 3],
    [/[őű]/giu, "hu", 3],
    [/[ãõ]/giu, "pt", 2],
    [/[ñ¿¡]/giu, "es", 2],
    [/[ß]/giu, "de", 2],
    [/[åø]/giu, "da", 1],
    [/[ğışİ]/giu, "tr", 3],
    [/[ăâîșț]/giu, "ro", 2],
];

// The commonest short words of each Latin-script language this sandbox has a voice for; each whole-word hit is a vote.
const WORDS = {
    en: ["the", "and", "is", "to", "of", "it", "that", "you", "for", "with", "this", "now", "was", "are", "i", "on", "be", "not", "have"],
    pl: ["i", "w", "nie", "się", "na", "to", "że", "jest", "do", "z", "co", "jak", "ale", "już", "teraz", "czy", "tak", "dla", "oraz"],
    de: ["und", "der", "die", "das", "ist", "nicht", "ich", "es", "zu", "mit", "ein", "eine", "auf", "für", "den", "jetzt", "auch"],
    es: ["el", "la", "de", "que", "y", "en", "los", "es", "por", "un", "una", "para", "con", "no", "ahora", "las", "del"],
    fr: ["le", "la", "les", "de", "et", "est", "un", "une", "que", "pas", "pour", "des", "en", "il", "je", "maintenant", "avec"],
    it: ["il", "la", "di", "che", "e", "è", "un", "una", "per", "non", "con", "sono", "ora", "gli", "del", "della"],
    pt: ["o", "a", "de", "que", "e", "é", "um", "uma", "para", "não", "com", "os", "as", "agora", "do", "da", "em"],
    nl: ["de", "het", "een", "en", "is", "van", "niet", "dat", "ik", "op", "met", "voor", "nu", "zijn"],
    cs: ["a", "je", "se", "na", "to", "že", "v", "ne", "jsem", "pro", "teď", "jak"],
    sv: ["och", "är", "det", "att", "en", "som", "inte", "jag", "på", "med", "för", "nu"],
} satisfies Record<string, readonly string[]>;

const count = (text: string, pattern: RegExp): number => text.match(pattern)?.length ?? 0;

const primary = (hint: string | undefined): string | undefined => {
    const language = (hint ?? "").trim().toLowerCase().split(/[-_]/u)[0] ?? "";
    return /^[a-z]{2,3}$/u.test(language) ? language : undefined;
};

// A non-Latin script settles the language on its own; Ukrainian and Persian share theirs with a bigger neighbour and
// settle on their own letters.
const scriptLanguage = (letters: string, total: number): string | undefined => {
    const script = SCRIPTS.find(([pattern]) => count(letters, pattern) / total > 0.3)?.[1];
    if (script === "ru" && count(letters, /[іїєґ]/giu) > 0) {
        return "uk";
    }
    if (script === "ar" && count(letters, /[پچژگ]/gu) > 0) {
        return "fa";
    }
    return script;
};

// Votes for each Latin-script language: its own letters, weighted, and its commonest words.
const tally = (letters: string): Map<string, number> => {
    const votes = new Map<string, number>();
    const vote = (language: string, amount: number): void => {
        if (amount > 0) {
            votes.set(language, (votes.get(language) ?? 0) + amount);
        }
    };
    for (const [pattern, language, weight] of MARKS) {
        vote(language, count(letters, pattern) * weight);
    }
    const words = letters.toLowerCase().split(/\s+/u);
    for (const [language, common] of Object.entries(WORDS)) {
        const set = new Set<string>(common);
        vote(language, words.filter((word) => set.has(word)).length);
    }
    return votes;
};

// The most votes, a tie going to the reader's own language; too few votes to mean anything is the reader's language.
const elected = (votes: ReadonlyMap<string, number>, fallback: string): string => {
    let best = fallback;
    let score = 0;
    for (const [language, votesFor] of votes) {
        const ahead = votesFor > score;
        const tiedWithReader = votesFor === score && language === fallback;
        if (ahead || tiedWithReader) {
            best = language;
            score = votesFor;
        }
    }
    return score < 2 ? fallback : best;
};

/** The text's language as an ISO 639-1 subtag, or the hint's when the text does not say clearly enough. */
export const guessLanguage = (text: string, hint?: string): string => {
    const fallback = primary(hint) ?? "en";
    const letters = text.replaceAll(/[^\p{L}\s]/gu, " ");
    const total = count(letters, /\p{L}/gu);
    if (total === 0) {
        return fallback;
    }
    return scriptLanguage(letters, total) ?? elected(tally(letters), fallback);
};
