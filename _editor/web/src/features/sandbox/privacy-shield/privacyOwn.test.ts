import { DEFAULT_PRIVACY_SHIELD, type PrivacyRule, type PrivacyShieldPolicy } from "@intentic/sandbox-contract/schemas/privacy";
import {
    dictionaryOf,
    mintId,
    newOwnList,
    newRule,
    ruleProblem,
    rulesOf,
    withListOn,
    withOwnList,
    withOwnListBack,
    withoutOwnList,
    withoutRule,
    withRule,
    withRuleBack,
} from "./privacyOwn";
import { allowAdding } from "./privacyShield";

// The owner's own lists and rules as the page edits them: each change a new policy built from the one on screen.

const policy = (fields: Partial<PrivacyShieldPolicy> = {}): PrivacyShieldPolicy => ({ ...DEFAULT_PRIVACY_SHIELD, ...fields });

const rule = (fields: Partial<PrivacyRule> = {}): PrivacyRule => ({ ...newRule(`rule-a`, `Badge`), ...fields });

describe(`the built-in lists`, () => {
    it(`switches one off and on again, keeping the others where they were`, () => {
        const off = withListOn(withListOn(policy(), `common-words`, false), `titles-en`, false);
        expect(off.dictionary.off).toEqual([`common-words`, `titles-en`]);
        expect(withListOn(off, `common-words`, true).dictionary.off).toEqual([`titles-en`]);
        expect(withListOn(off, `titles-en`, false).dictionary.off).toEqual([`common-words`, `titles-en`]);
    });

    it(`reads a policy cached from a daemon that knew no own lists as having none`, () => {
        const { dictionary: _dictionary, rules: _rules, ...old } = policy();
        expect(dictionaryOf(old)).toEqual({ off: [], lists: [] });
        expect(rulesOf(old)).toEqual([]);
    });
});

describe(`the owner's own lists`, () => {
    it(`adds a list, changes it in place, and puts a removed one back where it stood`, () => {
        const first = newOwnList(`list-a`, `Ukrainian names`);
        const second = newOwnList(`list-b`, `Clients`);
        const both = withOwnList(withOwnList(policy(), first), second);
        const renamed = withOwnList(both, { ...first, title: `UA names`, words: [`olena`] });
        expect(renamed.dictionary.lists.map((list) => [list.id, list.title])).toEqual([
            [`list-a`, `UA names`],
            [`list-b`, `Clients`],
        ]);
        const gone = withoutOwnList(renamed, `list-a`);
        expect(gone.dictionary.lists.map((list) => list.id)).toEqual([`list-b`]);
        expect(withOwnListBack(gone, first, 0).dictionary.lists.map((list) => list.id)).toEqual([`list-a`, `list-b`]);
        // Back already by some other way: nothing doubles.
        expect(withOwnListBack(both, first, 0).dictionary.lists).toHaveLength(2);
    });

    it(`mints an id no list holds yet, in the shape the contract takes`, () => {
        const id = mintId(`list`, [{ id: `list-a` }]);
        expect(id).toMatch(/^list-[a-z0-9-]{1,39}$/u);
        expect(id).not.toBe(`list-a`);
    });

    it(`takes a pasted run of names word by word`, () => {
        expect(allowAdding([`olena`], `Olena, Taras\nBohdan  Iryna`, { max: 10, length: 60 }, `words`)).toEqual({
            kind: `added`,
            allow: [`olena`, `Taras`, `Bohdan`, `Iryna`],
            added: [`Taras`, `Bohdan`, `Iryna`],
            already: [`Olena`],
        });
    });
});

describe(`the owner's own rules`, () => {
    it(`adds, changes, removes and puts back a rule`, () => {
        const one = withRule(policy(), rule());
        const changed = withRule(one, rule({ title: `Badge number`, match: `pattern`, pattern: String.raw`EMP-\d{6}` }));
        expect(rulesOf(changed)).toEqual([rule({ title: `Badge number`, match: `pattern`, pattern: String.raw`EMP-\d{6}` })]);
        const gone = withoutRule(changed, `rule-a`);
        expect(rulesOf(gone)).toEqual([]);
        expect(rulesOf(withRuleBack(gone, rule(), 3))).toEqual([rule()]);
    });

    it(`says why a rule cannot be saved: no name, nothing to match, or a pattern the daemon refuses`, () => {
        expect(ruleProblem(rule({ title: ` ` }))).toBe(`noTitle`);
        expect(ruleProblem(rule())).toBe(`noTerms`);
        expect(ruleProblem(rule({ terms: [`Falcon`] }))).toBeUndefined();
        expect(ruleProblem(rule({ match: `pattern`, pattern: `` }))).toBe(`empty`);
        expect(ruleProblem(rule({ match: `pattern`, pattern: `(a+)+` }))).toBe(`nested`);
        expect(ruleProblem(rule({ match: `pattern`, pattern: `(` }))).toBe(`invalid`);
        expect(ruleProblem(rule({ match: `pattern`, pattern: String.raw`EMP-\d{6}` }))).toBeUndefined();
    });

    it(`leaves a pattern already saved to the daemon, which keeps what it once took`, () => {
        const saved = rule({ match: `pattern`, pattern: `(a+)+` });
        expect(ruleProblem({ ...saved, title: `Renamed` }, saved)).toBeUndefined();
        expect(ruleProblem({ ...saved, pattern: `(b+)+` }, saved)).toBe(`nested`);
    });
});
