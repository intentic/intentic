import { describe, expect, it } from "vitest";
import { freeName, movableInto, pastePairs } from "./explorerPaste";

describe(`freeName`, () => {
    it(`keeps the original name when the target dir is free`, () => {
        expect(freeName(`app.ts`, new Set())).toBe(`app.ts`);
    });

    it(`appends " copy" before the extension, then numbers the later ones`, () => {
        expect(freeName(`app.ts`, new Set([`app.ts`]))).toBe(`app copy.ts`);
        expect(freeName(`app.ts`, new Set([`app.ts`, `app copy.ts`]))).toBe(`app copy 2.ts`);
        expect(freeName(`app.ts`, new Set([`app.ts`, `app copy.ts`, `app copy 2.ts`]))).toBe(`app copy 3.ts`);
    });

    it(`splits at the last dot, so a compound extension keeps only its tail`, () => {
        expect(freeName(`useTree.test.ts`, new Set([`useTree.test.ts`]))).toBe(`useTree.test copy.ts`);
    });

    it(`treats a dotfile's leading dot as part of the stem, not an extension`, () => {
        expect(freeName(`.gitignore`, new Set([`.gitignore`]))).toBe(`.gitignore copy`);
    });

    it(`leaves an extensionless name (a folder) whole`, () => {
        expect(freeName(`docs`, new Set([`docs`]))).toBe(`docs copy`);
    });
});

describe(`pastePairs`, () => {
    it(`lands each source under a free name in the target dir`, () => {
        expect(pastePairs([`src/app.ts`], `lib`, new Set())).toEqual([{ from: `src/app.ts`, to: `lib/app.ts` }]);
    });

    it(`never overwrites a same-named file already in the target dir`, () => {
        expect(pastePairs([`src/app.ts`], `lib`, new Set([`app.ts`]))).toEqual([{ from: `src/app.ts`, to: `lib/app copy.ts` }]);
    });

    it(`de-collides a paste into the source's own dir`, () => {
        expect(pastePairs([`src/app.ts`], `src`, new Set([`app.ts`]))).toEqual([{ from: `src/app.ts`, to: `src/app copy.ts` }]);
    });

    it(`keeps same-named sources from different folders apart`, () => {
        expect(pastePairs([`a/index.ts`, `b/index.ts`], `lib`, new Set())).toEqual([
            { from: `a/index.ts`, to: `lib/index.ts` },
            { from: `b/index.ts`, to: `lib/index copy.ts` },
        ]);
    });

    it(`pastes into the root`, () => {
        expect(pastePairs([`src/app.ts`], ``, new Set())).toEqual([{ from: `src/app.ts`, to: `app.ts` }]);
    });

    it(`drops a folder pasted into itself or its own subtree, keeping the rest`, () => {
        expect(pastePairs([`src`, `notes.md`], `src`, new Set())).toEqual([{ from: `notes.md`, to: `src/notes.md` }]);
        expect(pastePairs([`src`], `src/deep`, new Set())).toEqual([]);
    });

    it(`does not mistake a sibling with a shared prefix for a subtree`, () => {
        expect(pastePairs([`src`], `src-legacy`, new Set())).toEqual([{ from: `src`, to: `src-legacy/src` }]);
    });
});

describe(`movableInto`, () => {
    it(`skips sources already in the target dir`, () => {
        expect(movableInto([`src/app.ts`, `lib/util.ts`], `src`)).toEqual([`lib/util.ts`]);
    });

    it(`skips a folder moved into itself or its own subtree`, () => {
        expect(movableInto([`src`], `src`)).toEqual([]);
        expect(movableInto([`src`], `src/deep`)).toEqual([]);
    });

    it(`moves a root-level entry into a dir`, () => {
        expect(movableInto([`notes.md`], `docs`)).toEqual([`notes.md`]);
    });
});
