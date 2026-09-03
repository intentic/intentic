import { describe, expect, it } from "vitest";
import { mentionedPathTokens, mentionPaths } from "./mentions.js";

describe(`mentionPaths`, () => {
    it(`extracts path-looking tokens, deduped, with trailing punctuation stripped`, () => {
        expect(mentionPaths(`see @src/app.ts and @readme.md, plus @src/app.ts again`)).toEqual([`src/app.ts`, `readme.md`]);
    });

    it(`skips prose handles and mid-word @`, () => {
        expect(mentionPaths(`thanks @radarsu — mail me@example.com`)).toEqual([]);
    });

    it(`skips scoped package script prefixes in copied pnpm output`, () => {
        expect(mentionPaths(`@intentic/iq-engine:test: failed\nsee @src/app.ts`)).toEqual([`src/app.ts`]);
    });
});

describe(`mentionedPathTokens`, () => {
    it(`keeps the package-script shape the composer refuses, so a transcript can still recognise it inline`, () => {
        expect(mentionedPathTokens(`@intentic/iq-engine:test: failed\nsee @src/app.ts`)).toEqual([`intentic/iq-engine:test`, `src/app.ts`]);
    });
});
