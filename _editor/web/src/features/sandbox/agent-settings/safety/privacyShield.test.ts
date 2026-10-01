import {
    DEFAULT_PRIVACY_SHIELD,
    PERSONAL_DATA_CLASSES,
    PRIVACY_ALLOW_MAX,
    type PrivacyNameWord,
    type PrivacyShieldPolicy,
} from "@intentic/sandbox-contract";
import {
    ALLOW_VALUE_MAX,
    allowListFrom,
    allowListProblem,
    allowListText,
    foundIn,
    ledgerTime,
    nameVerdict,
    providerTrusted,
    sameList,
    shownWord,
    sourceHost,
    traitsOf,
    withClass,
    withTrusted,
} from "./privacyShield";

// Read off the contract rather than written out, so a changed default cannot drift from what these tests assume.
const policy = (fields: Partial<PrivacyShieldPolicy> = {}): PrivacyShieldPolicy => ({ ...DEFAULT_PRIVACY_SHIELD, ...fields });

describe(`withTrusted`, () => {
    it(`adds and removes one provider, leaving the rest of the policy as it was`, () => {
        const before = policy({ mode: `on`, trusted: [`claude`] });
        const added = withTrusted(before, `codex`, true);
        expect(added).toEqual({ ...before, trusted: [`claude`, `codex`] });
        expect(withTrusted(added, `claude`, false)).toEqual({ ...before, trusted: [`codex`] });
        // The route replaces the policy whole, so the one on screen must not be the one changed.
        expect(before.trusted).toEqual([`claude`]);
    });

    // A trusted endpoint the provider list no longer names is still the owner's choice; toggling a neighbour keeps it.
    it(`keeps a trusted id no provider row names when another is toggled`, () => {
        expect(withTrusted(policy({ trusted: [`endpoint/gone`] }), `claude`, true).trusted).toEqual([`endpoint/gone`, `claude`]);
    });

    it(`does not list a provider twice when it is trusted again`, () => {
        expect(withTrusted(policy({ trusted: [`claude`] }), `claude`, true).trusted).toEqual([`claude`]);
    });
});

describe(`withClass`, () => {
    it(`switches one kind off and back on, in the contract's order however it was clicked`, () => {
        const off = withClass(policy(), `email`, false);
        expect(off.classes).toEqual(PERSONAL_DATA_CLASSES.filter((kind) => kind !== `email`));
        expect(withClass(off, `email`, true).classes).toEqual([...PERSONAL_DATA_CLASSES]);
    });

    it(`can leave nothing switched on`, () => {
        const none = PERSONAL_DATA_CLASSES.reduce((current, kind) => withClass(current, kind, false), policy());
        expect(none.classes).toEqual([]);
    });
});

describe(`providerTrusted`, () => {
    const provider = { id: `ollama`, label: `Ollama`, shieldable: true, local: false };

    it(`trusts a provider the list names, and no other`, () => {
        expect(providerTrusted(provider, policy({ trusted: [`ollama`] }))).toBe(true);
        expect(providerTrusted(provider, policy())).toBe(false);
    });

    // The gateway never masks for a model on this machine, so the panel must not offer to distrust one.
    it(`trusts a local model whatever the list says`, () => {
        expect(providerTrusted({ ...provider, local: true }, policy())).toBe(true);
    });
});

describe(`the allow list`, () => {
    it(`reads one value per line, trimmed, with blanks and repeats dropped`, () => {
        expect(allowListFrom(`  Acme Sp. z o.o.\n\nJan Kowalski\nAcme Sp. z o.o.\n   \n`)).toEqual([`Acme Sp. z o.o.`, `Jan Kowalski`]);
        expect(allowListFrom(``)).toEqual([]);
    });

    it(`writes back to the text it was read from`, () => {
        const values = [`Acme`, `Jan Kowalski`];
        expect(allowListFrom(allowListText(values))).toEqual(values);
    });

    // A blank line typed into the box is not a change; the draft is unsaved only when the values differ.
    it(`compares lists by value and order`, () => {
        expect(sameList(allowListFrom(`Acme\n\n`), [`Acme`])).toBe(true);
        expect(sameList([`Acme`, `Jan`], [`Jan`, `Acme`])).toBe(false);
        expect(sameList([`Acme`], [])).toBe(false);
    });

    it(`names a value too long for the contract, and a list too long for it`, () => {
        expect(allowListProblem([`Acme`])).toBeUndefined();
        const long = `x`.repeat(ALLOW_VALUE_MAX + 1);
        expect(allowListProblem([`Acme`, long])).toEqual({ kind: `tooLong`, value: long });
        expect(allowListProblem([`x`.repeat(ALLOW_VALUE_MAX)])).toBeUndefined();
        const many = Array.from({ length: PRIVACY_ALLOW_MAX + 1 }, (_, index) => `value ${index}`);
        expect(allowListProblem(many)).toEqual({ kind: `tooMany`, count: PRIVACY_ALLOW_MAX + 1 });
    });
});

describe(`foundIn`, () => {
    it(`sums a request's counts and lists each kind found, in the contract's order`, () => {
        expect(foundIn({ counts: { phone: 1, "person-name": 3, email: 2 } })).toEqual({
            total: 6,
            parts: [
                { kind: `person-name`, count: 3 },
                { kind: `email`, count: 2 },
                { kind: `phone`, count: 1 },
            ],
        });
    });

    it(`leaves out a kind logged with nothing found`, () => {
        expect(foundIn({ counts: { "national-id": 0 } })).toEqual({ total: 0, parts: [] });
        expect(foundIn({ counts: {} })).toEqual({ total: 0, parts: [] });
    });
});

describe(`ledgerTime`, () => {
    it(`reads an ISO timestamp, and gives nothing for one it cannot read`, () => {
        expect(ledgerTime(`2026-10-01T12:00:00.000Z`)).toBe(Date.UTC(2026, 9, 1, 12));
        expect(ledgerTime(`yesterday-ish`)).toBeUndefined();
    });
});

// A word as the lists know it: nothing set unless a case sets it.
const word = (fields: Partial<PrivacyNameWord> = {}): PrivacyNameWord => ({
    word: `Word`,
    firstName: false,
    surname: false,
    surnameForm: false,
    ambiguous: false,
    never: false,
    ...fields,
});

describe(`nameVerdict`, () => {
    it(`says what a word or a name comes to: masked, never a name, a name beside evidence, or unknown`, () => {
        expect(nameVerdict({ found: true, words: [word({ firstName: true })] })).toBe(`found`);
        expect(nameVerdict({ found: false, words: [word({ never: true })] })).toBe(`never`);
        expect(nameVerdict({ found: false, words: [word({ firstName: true, ambiguous: true })] })).toBe(`needsContext`);
        expect(nameVerdict({ found: false, words: [word({ surnameForm: true })] })).toBe(`needsContext`);
        expect(nameVerdict({ found: false, words: [word()] })).toBe(`notFound`);
    });

    // "Never" is about one word: a name with a title in it is judged by the rest of its words.
    it(`reads a never word inside a longer name by the words around it`, () => {
        expect(nameVerdict({ found: false, words: [word({ never: true }), word({ surname: true })] })).toBe(`needsContext`);
        expect(nameVerdict({ found: false, words: [word({ never: true }), word()] })).toBe(`notFound`);
    });
});

describe(`traitsOf`, () => {
    it(`lists what is true of a word in the page's fixed order`, () => {
        expect(traitsOf(word({ ambiguous: true, firstName: true }))).toEqual([`firstName`, `ambiguous`]);
        expect(traitsOf(word())).toEqual([]);
    });
});

describe(`shownWord`, () => {
    const lists = [
        { id: `surnames-pl`, kind: `surname` as const },
        { id: `first-names-pl`, kind: `first-name` as const },
        { id: `titles-pl`, kind: `title` as const },
    ];

    it(`capitalizes a word only name lists hold, each part of a hyphenated one`, () => {
        expect(shownWord(`kowal`, [`surnames-pl`], lists)).toBe(`Kowal`);
        expect(shownWord(`skłodowska-curie`, [`surnames-pl`], lists)).toBe(`Skłodowska-Curie`);
        expect(shownWord(`łucja`, [`first-names-pl`], lists)).toBe(`Łucja`);
    });

    it(`keeps a title, or a word of a list it does not know, as the lists hold it`, () => {
        expect(shownWord(`dr`, [`titles-pl`], lists)).toBe(`dr`);
        expect(shownWord(`pan`, [`titles-pl`, `surnames-pl`], lists)).toBe(`pan`);
        expect(shownWord(`xyz`, [`unknown-list`], lists)).toBe(`xyz`);
    });
});

describe(`sourceHost`, () => {
    it(`names a source's page by its host, and gives nothing for no address or a broken one`, () => {
        expect(sourceHost(`https://dane.gov.pl/pl/dataset/1667`)).toBe(`dane.gov.pl`);
        expect(sourceHost(`https://www.ssa.gov/oact/babynames/limits.html`)).toBe(`ssa.gov`);
        expect(sourceHost(undefined)).toBeUndefined();
        expect(sourceHost(`not a url`)).toBeUndefined();
    });
});
