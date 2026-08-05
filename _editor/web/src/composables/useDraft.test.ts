import { describe, expect, it } from "vitest";
import { effectScope, nextTick, ref } from "vue";
import { useDraft } from "./useDraft";

// The seeding rule carries a bug's history (see the composable): a dirty-check guard once blocked the INITIAL
// seed, because an empty draft always differs from a saved value. These pin the three states the seed
// comparison tells apart: not yet seeded, untouched, and the user's own typing.
describe(`useDraft`, () => {
    const drafted = (saved: ReturnType<typeof ref<string | undefined>>) => effectScope().run(() => useDraft(() => saved.value))!;

    it(`seeds an empty draft from the first loaded value`, async () => {
        const saved = ref<string | undefined>(undefined);
        const draft = drafted(saved);
        expect(draft.value).toBe(``);

        saved.value = `pnpm test`;
        await nextTick();
        expect(draft.value).toBe(`pnpm test`);
    });

    it(`follows a change made elsewhere while the draft is untouched`, async () => {
        const saved = ref<string | undefined>(`one`);
        const draft = drafted(saved);
        expect(draft.value).toBe(`one`);

        saved.value = `two`;
        await nextTick();
        expect(draft.value).toBe(`two`);
    });

    it(`never overwrites the user's own typing`, async () => {
        const saved = ref<string | undefined>(`one`);
        const draft = drafted(saved);
        draft.value = `one, edited`;

        saved.value = `two`;
        await nextTick();
        expect(draft.value).toBe(`one, edited`);

        // The edit committed (saved now equals it) — from here the draft is untouched again and follows.
        saved.value = `one, edited`;
        await nextTick();
        saved.value = `three`;
        await nextTick();
        expect(draft.value).toBe(`three`);
    });

    it(`treats undefined as not-loaded, not as empty`, async () => {
        const saved = ref<string | undefined>(`kept`);
        const draft = drafted(saved);

        saved.value = undefined;
        await nextTick();
        expect(draft.value).toBe(`kept`);

        // An empty SAVED value is a real value and seeds like any other.
        saved.value = ``;
        await nextTick();
        expect(draft.value).toBe(``);
    });
});
