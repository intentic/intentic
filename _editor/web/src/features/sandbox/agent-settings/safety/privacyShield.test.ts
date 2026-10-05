import {
    DEFAULT_PRIVACY_SHIELD,
    PERSONAL_DATA_CLASSES,
    PRIVACY_ALLOW_MAX,
    type PrivacyLedgerEntry,
    type PrivacyNameWord,
    type PrivacyProvider,
    type PrivacyShieldPolicy,
} from "@intentic/sandbox-contract";
import {
    ALLOW_VALUE_MAX,
    activityFindings,
    activitySummary,
    allowListFrom,
    allowListProblem,
    allowListText,
    excerptParts,
    findingTokens,
    foundIn,
    ledgerTime,
    nameVerdict,
    providerMark,
    providerReceives,
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

// A token as the daemon writes one, built rather than spelled so it reads as the shape it is.
const token = (label: string, index: number): string => `\u27e6${label}_${index}\u27e7`;

// One logged request, nothing found unless the test says otherwise.
const entry = (fields: Partial<PrivacyLedgerEntry> & Pick<PrivacyLedgerEntry, `at`>): PrivacyLedgerEntry => ({
    provider: `claude`,
    trusted: false,
    action: `masked`,
    counts: {},
    images: 0,
    documents: 0,
    protocol: `anthropic`,
    ...fields,
});

const PERSON = token(`PERSON`, 3);
const EMAIL = token(`EMAIL`, 1);

describe(`activitySummary`, () => {
    it(`counts every request once, and names each provider by its newest request, most recent first`, () => {
        const summary = activitySummary([
            entry({ at: `2026-10-05T12:03:00Z`, counts: { "person-name": 2 } }),
            entry({ at: `2026-10-05T12:02:00Z`, provider: `codex`, trusted: true, action: `passed` }),
            entry({ at: `2026-10-05T12:01:00Z`, action: `refused`, images: 1 }),
            entry({ at: `2026-10-05T12:00:00Z`, documents: 2, counts: { email: 1 } }),
        ]);
        expect(summary).toEqual({
            requests: 4,
            values: 3,
            images: 1,
            documents: 2,
            refused: 1,
            since: Date.parse(`2026-10-05T12:00:00Z`),
            providers: [
                { provider: `claude`, requests: 3, values: 3, trusted: false, action: `masked` },
                { provider: `codex`, requests: 1, values: 0, trusted: true, action: `passed` },
            ],
        });
    });

    it(`an empty log has nothing to date it from`, () => {
        expect(activitySummary([]).since).toBeUndefined();
    });
});

describe(`activityFindings`, () => {
    it(`gives each value one row, at its newest request, counting the older requests that carried it too`, () => {
        const findings = activityFindings([
            entry({ at: `2026-10-05T12:02:00Z`, replacements: [{ token: PERSON, class: `person-name`, excerpt: `to ${PERSON} today` }] }),
            entry({ at: `2026-10-05T12:01:00Z` }),
            entry({
                at: `2026-10-05T12:00:00Z`,
                action: `watched`,
                replacements: [
                    { token: EMAIL, class: `email`, excerpt: `write ${EMAIL}` },
                    { token: PERSON, class: `person-name`, excerpt: `from ${PERSON}` },
                ],
            }),
        ]);
        expect(
            findings.map((finding) => (finding.kind === `value` ? [finding.replacement.token, finding.requests, finding.action] : finding.kind)),
        ).toEqual([
            [PERSON, 2, `masked`],
            [EMAIL, 1, `watched`],
        ]);
        expect(findings[0]).toMatchObject({ replacement: { excerpt: `to ${PERSON} today` } });
    });

    it(`gives a refused request, images or documents no value speaks for, and counts alone a row of their own`, () => {
        const findings = activityFindings([
            entry({ at: `2026-10-05T12:04:00Z`, action: `refused`, detail: `unrecognised request /v1/files` }),
            // The value read off the image is the image's row.
            entry({ at: `2026-10-05T12:03:00Z`, images: 1, replacements: [{ token: PERSON, class: `person-name`, excerpt: PERSON, image: true }] }),
            // Held back unread: nothing but the count says it happened.
            entry({ at: `2026-10-05T12:02:00Z`, images: 1 }),
            // Written before tokens were kept: the counts are all it has.
            entry({ at: `2026-10-05T12:01:00Z`, counts: { "national-id": 1 } }),
            entry({ at: `2026-10-05T12:00:00Z` }),
        ]);
        expect(findings.map((finding) => [finding.kind, finding.kind === `request` ? finding.found.total : finding.replacement.token])).toEqual([
            [`request`, 0],
            [`value`, PERSON],
            [`request`, 0],
            [`request`, 1],
        ]);
        expect(findings[0]).toMatchObject({ action: `refused`, detail: `unrecognised request /v1/files` });
        expect(findings[2]).toMatchObject({ images: 1 });
    });

    it(`asks for each token on show once`, () => {
        const findings = activityFindings([
            entry({ at: `2026-10-05T12:01:00Z`, replacements: [{ token: PERSON, class: `person-name`, excerpt: PERSON }] }),
            entry({ at: `2026-10-05T12:00:00Z`, images: 1, replacements: [{ token: EMAIL, class: `email`, excerpt: EMAIL }] }),
        ]);
        expect(findingTokens(findings)).toEqual([PERSON, EMAIL]);
    });
});

describe(`excerptParts`, () => {
    it(`cuts an excerpt at every token, in either spelling, and marks the row's own`, () => {
        // The spelling a model rewrites the brackets into, built so it stays the shape it is.
        const loose = `[[${`EMAIL`}_1]]`;
        expect(excerptParts(`…ask ${PERSON} or ${loose} today`, PERSON)).toEqual([
            { text: `…ask `, token: false, own: false },
            { text: PERSON, token: true, own: true },
            { text: ` or `, token: false, own: false },
            { text: loose, token: true, own: false },
            { text: ` today`, token: false, own: false },
        ]);
        expect(excerptParts(`no tokens here`, PERSON)).toEqual([{ text: `no tokens here`, token: false, own: false }]);
    });
});

const provider = (fields: Partial<PrivacyProvider> & Pick<PrivacyProvider, `id`>): PrivacyProvider => ({
    label: fields.id,
    shieldable: true,
    local: false,
    ...fields,
});

describe(`providerMark`, () => {
    it(`draws a vendor's own mark, and otherwise what the provider is`, () => {
        expect(providerMark(`claude`, false)).toEqual({ brand: `claude` });
        expect(providerMark(`endpoint/qwen`, true)).toEqual({ glyph: `cpu` });
        expect(providerMark(`endpoint/free-trial`, false)).toEqual({ glyph: `gift` });
        expect(providerMark(`endpoint/office-vllm`, false)).toEqual({ glyph: `server` });
        expect(providerMark(`my-acp-agent`, false)).toEqual({ glyph: `sparkles` });
    });
});

describe(`providerReceives`, () => {
    it(`says what each provider is sent under the policy in force`, () => {
        const on = policy({ mode: `on`, trusted: [`codex`] });
        const watching = policy({ mode: `watch` });
        expect(providerReceives(provider({ id: `claude` }), on)).toBe(`tokens`);
        expect(providerReceives(provider({ id: `codex` }), on)).toBe(`values`);
        expect(providerReceives(provider({ id: `cursor`, shieldable: false }), on)).toBe(`refused`);
        expect(providerReceives(provider({ id: `endpoint/qwen`, local: true }), on)).toBe(`local`);
        expect(providerReceives(provider({ id: `claude` }), watching)).toBe(`watched`);
        // A runtime the gateway can't sit in front of is neither masked nor watched: it runs as it is.
        expect(providerReceives(provider({ id: `cursor`, shieldable: false }), watching)).toBe(`values`);
    });
});
