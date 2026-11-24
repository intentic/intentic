import assert from "node:assert/strict";
import { test } from "node:test";
import { RETIRED } from "../../constants/src/vocabulary.mjs";
import { literalScanner, regexPrefilter, requiredLiterals } from "./literals.mjs";

test("a regex's required literals are the fixed text every match carries", () => {
    const cases = [
        [/a|b/, ["a", "b"]],
        [/ab?c/, ["ac", "abc"]],
        [/x(?=y)z/, ["xz"]],
        [/(?<!q)foo\b/, ["foo"]],
        [/^abc$/, ["abc"]],
        [/(?:foo){2}/, ["foofoo"]],
        [/a+b/, ["a"]],
        [/a*b/, ["b"]],
        [/[Bb]lue (?:cat|dog)s?/, ["Blue cat", "Blue cats", "Blue dog", "Blue dogs", "blue cat", "blue cats", "blue dog", "blue dogs"]],
        [/(?<n>ab)\k<n>/, ["ab"]],
        // JavaScript ends a class at its first `]`: an empty class and then a literal `]`. Given as the source and flags
        // the reader reads, since the linter refuses the empty class this case is about.
        [{ source: "[]]", flags: "" }, ["]"]],
        // `\12` may be an octal escape, so the `2` is not text of its own; the `x` after it is.
        [/\12x/, ["x"]],
        [/a\.b\/c/, ["a.b/c"]],
        [/\x41B/, ["AB"]],
    ];
    for (const [regex, literals] of cases) {
        assert.deepEqual(requiredLiterals(regex), literals, String(regex));
    }
});

test("a regex with no fixed text, or one this reader does not follow, has none to say", () => {
    for (const regex of [/./, /\w+/, /a*/, /[a-z]+/, /[^x]y?/, /a|\d/, /\cJx/i, /abc/i, /abc/u, /(?:)/]) {
        assert.equal(requiredLiterals(regex), undefined, String(regex));
    }
});

test("the automaton finds every group with a literal in the text, as a substring search would", () => {
    const groups = [["he", "she"], ["his", "hers"], ["xyz"], ["é", "ß"], ["aaa"]];
    const scan = literalScanner(groups);
    const texts = ["ushers", "", "this", "xy z", "aaaa", "straße", "café", "hhhhhe", "s he", "sh", "hishers xyz"];
    for (const text of texts) {
        const expected = new Set(groups.flatMap((literals, group) => (literals.some((literal) => text.includes(literal)) ? [group] : [])));
        assert.deepEqual(scan(text), expected, text);
    }
});

// The soundness the vocabulary check rests on: whenever a retired pattern matches a line, the prefilter names it for the
// text that line is in. Lines are built from each pattern's own literals cut at random places and spliced into noise,
// so most of them are near misses.
test("the prefilter never leaves out a retired pattern that matches", () => {
    const patterns = RETIRED.map((entry) => entry.pattern);
    const candidates = regexPrefilter(patterns);
    const pieces = patterns.flatMap((pattern) => requiredLiterals(pattern) ?? []);
    let seed = 11;
    const next = () => {
        seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
        return seed / 2_147_483_648;
    };
    const pick = (list) => list[Math.floor(next() * list.length)];
    let matched = 0;
    for (let round = 0; round < 4000; round += 1) {
        const parts = Array.from({ length: 1 + Math.floor(next() * 4) }, () => {
            const piece = pick(pieces);
            const cut = Math.floor(next() * piece.length);
            return next() < 0.5 ? piece : `${piece.slice(0, cut)}${pick([" ", "x", "'s ", "-", ""])}${piece.slice(cut)}`;
        });
        const text = `${pick(["", "a ", "the "])}${parts.join(pick([" ", "", " is ", "\n"]))}${pick(["", ".", " now"])}`;
        const named = new Set(candidates(text));
        for (const [index, pattern] of patterns.entries()) {
            if (text.split("\n").some((line) => pattern.test(line))) {
                matched += 1;
                assert.ok(named.has(index), `${RETIRED[index].id} matches ${JSON.stringify(text)} but was left out`);
            }
        }
    }
    assert.ok(matched > 1000, `only ${String(matched)} matches: the corpus no longer exercises the patterns`);
});
