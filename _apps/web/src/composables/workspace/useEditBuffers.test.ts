import { afterEach, describe, expect, it } from "vitest";
import { resetEditBuffers, useEditBuffers } from "./useEditBuffers";

// The contract FileViewer's non-destructive re-read relies on: after a save, baseline == on-disk text, so the
// file-watch echo of the user's OWN write reconciles to a no-op (no flicker, no false "changed on disk"), while a
// genuine external edit (different bytes) is still detectable.
describe(`useEditBuffers`, () => {
    afterEach(() => resetEditBuffers());

    it(`baselineOf returns the last-known-on-disk text, and a save makes it equal the saved value`, () => {
        const edit = useEditBuffers();
        edit.setBaseline(`a.ts`, `one\n`);
        expect(edit.baselineOf(`a.ts`)).toBe(`one\n`);

        // User edits then saves — the reconcile compares the echoed disk read against this baseline.
        edit.setBuffer(`a.ts`, `two\n`);
        expect(edit.isDirty(`a.ts`)).toBe(true);
        edit.markSaved(`a.ts`, `two\n`);

        expect(edit.baselineOf(`a.ts`)).toBe(`two\n`);
        expect(edit.isDirty(`a.ts`)).toBe(false);
        // The save echo re-reads "two\n" from disk === baseline ⇒ reconcile no-op.
        expect(`two\n` === edit.baselineOf(`a.ts`)).toBe(true);
    });

    it(`a genuine external edit differs from the baseline, so the reconcile can detect it`, () => {
        const edit = useEditBuffers();
        edit.setBaseline(`b.ts`, `one\n`);
        // Agent/terminal rewrote the file: the echoed disk read differs from baseline while the buffer is clean.
        expect(`external\n` === edit.baselineOf(`b.ts`)).toBe(false);
        expect(edit.isDirty(`b.ts`)).toBe(false);
    });

    it(`baselineOf is undefined for an unopened path`, () => {
        expect(useEditBuffers().baselineOf(`never.ts`)).toBeUndefined();
    });
});
