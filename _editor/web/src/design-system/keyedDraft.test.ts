// @vitest-environment jsdom
import { expect, it } from "vitest";
import { useKeyedDraft } from "@intentic/ui";
import { effectScope, ref } from "vue";

/* What the memory and knowledge panes rely on and neither could pin (extensions have no runner for a kit
 * composable either): an unsaved edit survives reading another note and coming back, which is the whole reason
 * the draft lives above the pane rather than in it. */
it(`keeps one draft per selection, and forgets the one that is cleared`, () => {
    const selected = ref<string | undefined>(`a`);
    const scope = effectScope();
    const { draft, hasDraft } = scope.run(() => useKeyedDraft(selected))!;

    draft.value = `half a correction`;
    selected.value = `b`;
    expect(draft.value).toBeUndefined();

    draft.value = `another`;
    selected.value = `a`;
    expect(draft.value).toBe(`half a correction`);
    expect(hasDraft(`b`)).toBe(true);

    // `undefined` is "not editing", not "editing nothing": the key goes, so a picker stops saying "Unsaved".
    draft.value = undefined;
    expect(hasDraft(`a`)).toBe(false);

    scope.stop();
});

// Nothing selected is a real state (a list still loading, a note just deleted): writes have nowhere to land
// rather than landing somewhere wrong.
it(`drops a write made with nothing selected`, () => {
    const selected = ref<string | undefined>(undefined);
    const scope = effectScope();
    const { draft, hasDraft } = scope.run(() => useKeyedDraft(selected))!;

    draft.value = `typed into the void`;
    selected.value = `a`;
    expect(draft.value).toBeUndefined();
    expect(hasDraft(`a`)).toBe(false);

    scope.stop();
});
