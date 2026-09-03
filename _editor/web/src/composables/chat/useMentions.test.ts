import { describe, expect, it } from "vitest";
import { insertMention, mentionQueryAt } from "./useMentions";

describe(`mentionQueryAt`, () => {
    it(`detects the token between a fresh @ and the caret`, () => {
        expect(mentionQueryAt(`fix @src/ap`, 11)).toEqual({ start: 4, query: `src/ap` });
        expect(mentionQueryAt(`@re`, 3)).toEqual({ start: 0, query: `re` });
        expect(mentionQueryAt(`fix @`, 5)).toEqual({ start: 4, query: `` });
    });

    it(`ignores mid-word @ (emails) and tokens the caret has left`, () => {
        expect(mentionQueryAt(`mail me@example.com`, 19)).toBeUndefined();
        expect(mentionQueryAt(`fix @src/app.ts now`, 19)).toBeUndefined();
        expect(mentionQueryAt(`no mention here`, 15)).toBeUndefined();
    });
});

describe(`insertMention`, () => {
    it(`replaces the token with the picked path and moves the caret past it`, () => {
        const result = insertMention(`fix @ap please`, { start: 4, query: `ap` }, 7, `src/app.ts`);
        expect(result.text).toBe(`fix @src/app.ts  please`);
        expect(result.caret).toBe(16);
    });
});
