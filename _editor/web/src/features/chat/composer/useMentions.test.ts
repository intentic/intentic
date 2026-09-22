import { describe, it, expect } from "bun:test";
import { drillMention, fileMention, mentionQueryAt, parseMentionToken, replaceMention } from "./useMentions";

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

    it(`keeps a drill token live through its colon`, () => {
        expect(mentionQueryAt(`run @model:son`, 14)).toEqual({ start: 4, query: `model:son` });
    });
});

describe(`parseMentionToken`, () => {
    it(`reads an exact kind keyword before the colon as a drill`, () => {
        expect(parseMentionToken(`persona:`)).toEqual({ kind: `persona`, query: `` });
        expect(parseMentionToken(`model:son`)).toEqual({ kind: `model`, query: `son` });
        expect(parseMentionToken(`sandbox:om`)).toEqual({ kind: `sandbox`, query: `om` });
        expect(parseMentionToken(`effort:hi`)).toEqual({ kind: `effort`, query: `hi` });
    });

    it(`treats anything else as a plain search, colon or not`, () => {
        expect(parseMentionToken(`personas`)).toEqual({ kind: undefined, query: `personas` });
        expect(parseMentionToken(`persona`)).toEqual({ kind: undefined, query: `persona` });
        expect(parseMentionToken(`Model:x`)).toEqual({ kind: undefined, query: `Model:x` });
        expect(parseMentionToken(`src/app.ts`)).toEqual({ kind: undefined, query: `src/app.ts` });
        expect(parseMentionToken(`scope/pkg:test:`)).toEqual({ kind: undefined, query: `scope/pkg:test:` });
    });
});

describe(`replaceMention`, () => {
    it(`puts a picked file in the wire form and moves the caret past its space`, () => {
        const result = replaceMention(`fix @ap please`, { start: 4, query: `ap` }, 7, fileMention(`src/app.ts`));
        expect(result.text).toBe(`fix @src/app.ts  please`);
        expect(result.caret).toBe(16);
    });

    it(`drills by rewriting the token and leaving the caret inside it`, () => {
        const result = replaceMention(`@`, { start: 0, query: `` }, 1, drillMention(`model`));
        expect(result.text).toBe(`@model:`);
        expect(result.caret).toBe(7);
    });

    it(`removes a picked setting and the space it would double`, () => {
        expect(replaceMention(`fix @int please`, { start: 4, query: `int` }, 8, ``)).toEqual({ text: `fix please`, caret: 4 });
        expect(replaceMention(`@int`, { start: 0, query: `int` }, 4, ``)).toEqual({ text: ``, caret: 0 });
        expect(replaceMention(`fix @int`, { start: 4, query: `int` }, 8, ``)).toEqual({ text: `fix `, caret: 4 });
        expect(replaceMention(`@int please`, { start: 0, query: `int` }, 4, ``)).toEqual({ text: `please`, caret: 0 });
    });
});
