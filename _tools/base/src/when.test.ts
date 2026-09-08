import { describe, expect, it } from "vitest";
import { evaluateWhen, isWhenExpression, parseWhen, WhenSyntaxError, whenKeys } from "./when.js";

// The whole surface, as the one thing a caller does with it: does this condition hold against this context.
const holds = (source: string, context: Record<string, unknown>): boolean => evaluateWhen(parseWhen(source), context);

describe(`truthiness`, () => {
    it(`reads a bare key as a truthiness test`, () => {
        expect(holds(`chatFocused`, { chatFocused: true })).toBe(true);
        expect(holds(`chatFocused`, { chatFocused: false })).toBe(false);
    });

    it(`reads an absent key as false rather than throwing`, () => {
        expect(holds(`neverPublished`, {})).toBe(false);
        expect(holds(`!neverPublished`, {})).toBe(true);
    });

    it(`treats empty string and zero as false`, () => {
        expect(holds(`tabSurface`, { tabSurface: `` })).toBe(false);
        expect(holds(`selectionSize`, { selectionSize: 0 })).toBe(false);
        expect(holds(`selectionSize`, { selectionSize: 1 })).toBe(true);
    });
});

describe(`comparison`, () => {
    it(`compares strings, numbers and booleans against literals`, () => {
        expect(holds(`tabSurface == 'chat'`, { tabSurface: `chat` })).toBe(true);
        expect(holds(`tabSurface != 'chat'`, { tabSurface: `terminal` })).toBe(true);
        expect(holds(`depth >= 2`, { depth: 3 })).toBe(true);
        expect(holds(`enabled == true`, { enabled: true })).toBe(true);
    });

    it(`compares across types by string form`, () => {
        expect(holds(`enabled == 'true'`, { enabled: true })).toBe(true);
        expect(holds(`count == '3'`, { count: 3 })).toBe(true);
    });

    // '10' > '9' and undefined > 3 are false by JS string/NaN coincidence; that is the trap being tested.
    it(`refuses to order anything but numbers`, () => {
        expect(holds(`depth > 2`, { depth: `10` })).toBe(false);
        expect(holds(`depth > 2`, {})).toBe(false);
    });
});

describe(`membership`, () => {
    it(`tests a value against a literal list, negated or not`, () => {
        expect(holds(`outcome in ['failed', 'blocked']`, { outcome: `failed` })).toBe(true);
        expect(holds(`outcome in ['failed', 'blocked']`, { outcome: `passed` })).toBe(false);
        expect(holds(`outcome not in ['failed', 'blocked']`, { outcome: `passed` })).toBe(true);
    });
});

describe(`composition`, () => {
    it(`applies && before ||, and parentheses over both`, () => {
        expect(holds(`a || b && c`, { a: true, b: false, c: false })).toBe(true);
        expect(holds(`(a || b) && c`, { a: true, b: false, c: false })).toBe(false);
    });

    it(`negates a parenthesised group`, () => {
        expect(holds(`!(a && b)`, { a: true, b: false })).toBe(true);
    });

    it(`evaluates a real command condition`, () => {
        const source = `tabSurface == 'chat' && !editableTarget`;
        expect(holds(source, { tabSurface: `chat`, editableTarget: false })).toBe(true);
        expect(holds(source, { tabSurface: `chat`, editableTarget: true })).toBe(false);
        expect(holds(source, { tabSurface: `terminal`, editableTarget: false })).toBe(false);
    });
});

describe(`syntax`, () => {
    // notify and inbox test that a word merely starting with not/in is a key, not an operator.
    it(`accepts dotted, dashed and operator-prefixed keys`, () => {
        expect(holds(`chat.tab-active`, { "chat.tab-active": true })).toBe(true);
        expect(holds(`notify && inbox`, { notify: true, inbox: true })).toBe(true);
    });

    it.each([
        [`unbalanced parens`, `(a && b`],
        [`a dangling operator`, `a &&`],
        [`a missing literal`, `a == `],
        [`an unterminated string`, `a == 'chat`],
        [`a leading operator`, `== 'chat'`],
        [`trailing input`, `a b`],
    ])(`rejects %s`, (_label, source) => {
        expect(() => parseWhen(source)).toThrow(WhenSyntaxError);
        expect(isWhenExpression(source)).toBe(false);
    });

    it(`recognises a well-formed condition`, () => {
        expect(isWhenExpression(`tabSurface == 'chat' && !editableTarget`)).toBe(true);
    });
});

describe(`whenKeys`, () => {
    it(`reports every key a condition reads, without duplicates`, () => {
        expect(whenKeys(parseWhen(`a && (b || !a) && c in ['x']`)).toSorted()).toEqual([`a`, `b`, `c`]);
    });
});
