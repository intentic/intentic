// Polish names decline: Jan is Jana, Janowi, Janem, Janie; Kowalska is Kowalskiej and Kowalską. The name lists hold
// nominatives only, so a word found in text is reduced to the nominatives it could come from and each is looked up.
// The rules over-generate on purpose: a wrong guess is only a Set lookup that misses, while a missing rule is a name
// that slips through. Rules are written against lowercase text.

interface Rule {
    // The surface ending, and the nominative endings it can stand for.
    readonly ending: string;
    readonly lemmas: readonly string[];
    // A plural form: families are named in the plural ("Kowalscy", "Nowakowie"), first names hardly ever, and a plural
    // read off a place ("w Piotrkowie") is not a person.
    readonly plural?: true;
    // A stem this ending never follows in a name, where the word is something else: "-kie" is an adjective
    // ("Polskie", "Brzeskie"); a name in -ka or -k takes "-ce" or "-ku" there.
    readonly notAfter?: RegExp;
}

const rule = (ending: string, lemmas: readonly string[], extra: Partial<Pick<Rule, "plural" | "notAfter">> = {}): Rule => ({
    ending,
    lemmas,
    ...extra,
});

// Every rule whose ending matches is applied.
const RULES: readonly Rule[] = [
    // Masculine nouns and first names: Jana, Janowi, Janem, Markiem, Marku, Janie, and the plural Nowakowie, Nowaków.
    rule("a", [""]),
    rule("owi", [""]),
    rule("em", [""]),
    rule("iem", [""]),
    rule("u", [""]),
    rule("ie", ["", "a"], { notAfter: /[kg]$/u }),
    rule("owie", [""], { plural: true }),
    rule("ów", [""], { plural: true }),
    // Locatives that soften the last consonant: Pawle, Piotrze, Robercie, Dawidzie; and their feminine twins, Barbarze,
    // Małgorzacie, Wandzie.
    rule("le", ["ł", "ła"]),
    rule("rze", ["r", "ra"]),
    rule("cie", ["t", "ta"]),
    rule("dzie", ["d", "da"]),
    rule("ście", ["st", "sta"]),
    // Feminine -ka and -ga: Agnieszce, Jadwidze. Kościuszko declines like them.
    rule("ce", ["ka", "ko"]),
    rule("dze", ["ga"]),
    // Feminine -a: Anny, Agnieszki, Marii, Patrycji, Oli, Basi, Mai, Annę, Anną, Anno, Basiu.
    rule("y", ["a", "o"]),
    rule("i", ["a", "ia", "ja", "o"]),
    rule("ii", ["ia"]),
    rule("ę", ["a", "o"]),
    rule("ą", ["a", "o"]),
    rule("o", ["a"]),
    rule("iu", ["ia"]),
    // Adjectival surnames and first names: Kowalskiego, Kowalskiemu, Kowalskim, Kowalskich, Jerzego, Antoniego.
    rule("iego", ["i"]),
    rule("ego", ["y"]),
    rule("iemu", ["i"]),
    rule("emu", ["y"]),
    rule("im", ["i"]),
    rule("ym", ["y"]),
    rule("ich", ["i"], { plural: true }),
    rule("ych", ["y"], { plural: true }),
    rule("imi", ["i"], { plural: true }),
    // Their feminine forms: Kowalskiej, Zielonej (Kowalską is the -ą rule above).
    rule("iej", ["a"]),
    rule("ej", ["a"]),
    // Plurals that change the consonant: Kowalscy, Zawiccy, Zawadzcy.
    rule("scy", ["ski"], { plural: true }),
    rule("ccy", ["cki"], { plural: true }),
    rule("dzcy", ["dzki"], { plural: true }),
];

const VOWELS = new Set(["a", "e", "i", "o", "u", "y", "ą", "ę", "ó"]);
const SOFTENED: ReadonlyArray<readonly [string, string]> = [
    ["dzi", "dź"],
    ["ni", "ń"],
    ["si", "ś"],
    ["ci", "ć"],
    ["zi", "ź"],
];
const O_BEFORE_FINAL_CONSONANTS = /o([^aeiouyąęó]+)$/u;
// Shorter stems than this are syllables, not names.
const MIN_STEM = 2;

const isConsonant = (ch: string | undefined): boolean => ch !== undefined && !VOWELS.has(ch);

// The alternations a stem goes through when an ending is added, undone: the fleeting e (Marek → Marka, Paweł → Pawła,
// Wróbel → Wróbla), the softened consonant written with an i (Kamień → Kamienia), and ó becoming o (Mróz → Mroza).
const restore = (stem: string, out: string[]): void => {
    out.push(stem);
    const last = stem.at(-1);
    if (last !== undefined && isConsonant(last) && isConsonant(stem.at(-2))) {
        const head = stem.slice(0, -1);
        out.push(`${head}e${last}`, `${head}ie${last}`);
    }
    for (const [written, soft] of SOFTENED) {
        if (stem.endsWith(written)) {
            out.push(stem.slice(0, -written.length) + soft);
            break;
        }
    }
    const o = O_BEFORE_FINAL_CONSONANTS.exec(stem);
    if (o !== null) {
        out.push(`${stem.slice(0, o.index)}ó${o[1] ?? ""}`);
    }
};

// Every nominative a lowercase word could be a form of, the word itself first; plural forms only when asked for.
export const lemmaCandidates = (word: string, plurals: boolean): string[] => {
    const out = [word];
    for (const { ending, lemmas, plural, notAfter } of RULES) {
        if (!word.endsWith(ending) || word.length - ending.length < MIN_STEM || (plural === true && !plurals)) {
            continue;
        }
        const stem = word.slice(0, -ending.length);
        if (notAfter?.test(stem) === true) {
            continue;
        }
        for (const lemma of lemmas) {
            restore(stem + lemma, out);
        }
    }
    return out;
};
