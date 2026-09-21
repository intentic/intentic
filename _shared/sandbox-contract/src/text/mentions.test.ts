import { describe, expect, it } from "vitest";
import { AgentTurnSchema } from "../schemas/agent.js";
import { MENTION_LIMIT, mentionedPathTokens, mentionPaths } from "./mentions.js";

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

    // A pasted `ps` dump attached a file nobody chose and the turn died on it: curl's `@file` argument is a mention's
    // exact shape.
    it(`skips curl's @file argument and anything else outside the workspace`, () => {
        expect(mentionPaths(`curl --data-binary @/tmp/probe/req.json localhost`)).toEqual([]);
        expect(mentionPaths(`@~/notes.md @C:\\tmp\\out.log @../outside.bin @.. done`)).toEqual([]);
        expect(mentionPaths(`curl -d @/tmp/req.json x, then read @src/app.ts`)).toEqual([`src/app.ts`]);
    });

    // The wire takes MENTION_LIMIT paths: past it the schema would refuse the whole message, which is the failure a
    // pasted log must not be able to cause.
    it(`stops at the limit a turn can carry rather than overflowing it`, () => {
        const pasted = Array.from({ length: MENTION_LIMIT + 5 }, (_, index) => `@src/file${index}.ts`).join(` `);

        expect(mentionPaths(pasted)).toHaveLength(MENTION_LIMIT);
        expect(AgentTurnSchema.safeParse({ prompt: pasted, mentions: mentionPaths(pasted) }).success).toBe(true);
    });
});

describe(`mentionedPathTokens`, () => {
    it(`keeps the package-script shape the composer refuses, so a transcript can still recognise it inline`, () => {
        expect(mentionedPathTokens(`@intentic/iq-engine:test: failed\nsee @src/app.ts`)).toEqual([`intentic/iq-engine:test`, `src/app.ts`]);
    });
});
