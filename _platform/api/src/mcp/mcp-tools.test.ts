import { describe, expect, it } from "vitest";
import { canonicalRequest } from "./mcp-tools.js";

/* THE RETRY KEY. `services_run` is answered once with "open this URL" and then called AGAIN with the same
 * arguments — that second call has to find the offer the first one raised, and the only thing linking them is
 * the request body. If two spellings of one body produce two keys, the approval the owner just clicked is
 * stranded and the retry raises a second card for the same question. */

describe(`canonicalising a request body`, () => {
    it(`is stable across the two ways a model sends the same body`, () => {
        expect(canonicalRequest({ q: `x`, n: 2 })).toBe(canonicalRequest(`{"q":"x","n":2}`));
    });

    it(`ignores whitespace a model happened to emit`, () => {
        expect(canonicalRequest(`{\n  "q": "x"\n}`)).toBe(canonicalRequest(`{"q":"x"}`));
    });

    it(`keeps a body that is not JSON rather than losing it`, () => {
        expect(canonicalRequest(`not json at all`)).toBe(`not json at all`);
    });

    it(`treats a missing body as an empty object, not as the string "undefined"`, () => {
        expect(canonicalRequest(undefined)).toBe(`{}`);
    });

    /* Key ordering is NOT normalised, and that is a deliberate limit rather than an oversight: JSON object
     * order is meaningful to some providers, so reordering to build a key would mean the key no longer
     * describes the bytes that get forwarded. The cost is that a model which reshuffles its own keys between
     * the ask and the retry raises a second card — visible, harmless, and far better than silently spending
     * an approval that was given for a different body. */
    it(`does not pretend reordered keys are the same body`, () => {
        expect(canonicalRequest({ a: 1, b: 2 })).not.toBe(canonicalRequest({ b: 2, a: 1 }));
    });
});
