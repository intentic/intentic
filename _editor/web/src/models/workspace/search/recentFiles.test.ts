import { KEEP, recentFirst, remembered } from "./recentFiles";

// Pins quick-open's recency rule: what was opened last moves to the front of a bounded list, and the remembered files a
// query matches head its answer in the order they were opened, ahead of whatever the scorer ranked first.

const everywhere = (): boolean => true;

test("opening a file moves it to the front, never listing it twice", () => {
    expect(remembered([`a.ts`, `b.ts`, `c.ts`], `c.ts`)).toEqual([`c.ts`, `a.ts`, `b.ts`]);
    expect(remembered([], `a.ts`)).toEqual([`a.ts`]);
});

test("the list keeps the last KEEP files, the oldest falling off", () => {
    const full = Array.from({ length: KEEP }, (_, index) => `file${index}.ts`);
    const next = remembered(full, `new.ts`);
    expect(KEEP).toBe(100);
    expect(next).toHaveLength(KEEP);
    expect(next[0]).toBe(`new.ts`);
    expect(next.at(-1)).toBe(`file${KEEP - 2}.ts`);
});

test("remembered files the query matches come first, most recently opened first, ahead of the ranked answer", () => {
    const ranked = [`src/store.ts`, `src/session-store.ts`, `lib/stores/index.ts`];
    const recent = [`lib/stores/index.ts`, `docs/readme.md`, `src/session-store.ts`];
    expect(recentFirst(`store`, ranked, recent, everywhere, 10)).toEqual([`lib/stores/index.ts`, `src/session-store.ts`, `src/store.ts`]);
});

test("a remembered file the scorer left past the cut is still lifted, and the cut still holds", () => {
    // The scorer answered only its best two; the remembered match was not among them.
    expect(recentFirst(`store`, [`src/store.ts`, `a/store.md`], [`deep/old/restored.ts`], everywhere, 2)).toEqual([`deep/old/restored.ts`, `src/store.ts`]);
});

test("a remembered file the query misses, or one no longer offered, is not lifted", () => {
    const ranked = [`src/store.ts`];
    expect(recentFirst(`store`, ranked, [`docs/readme.md`], everywhere, 10)).toEqual([`src/store.ts`]);
    expect(recentFirst(`store`, ranked, [`gone/store.ts`], (path) => path !== `gone/store.ts`, 10)).toEqual([`src/store.ts`]);
});

test("multi-word queries lift what every word matches, as the scorer ranks", () => {
    expect(recentFirst(`smoke main`, [], [`test/smoke/src/main.ts`, `src/main.ts`], everywhere, 10)).toEqual([`test/smoke/src/main.ts`]);
});
