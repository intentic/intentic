// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { effectScope, nextTick, ref } from "vue";
import { useRailMemory } from "@intentic/ui";

/* The rules a remembered rail choice has to keep, and each of them is a way of getting this wrong that would be
 * worse than not remembering at all: overriding a link somebody sent, opening a view on a repository that no
 * longer exists, or quietly re-narrowing a scope the reader had deliberately widened.
 *
 * The barrel reaches window.matchMedia (useDevice) at import: hence jsdom. */

const KEY = `intentic.rail.test.scope`;

// A rail lives inside a component, so the watchers have to live inside a scope that can dispose them; running
// them loose would leak one pair of watchers per test into every test after it.
const mount = (choice: ReturnType<typeof ref<string | undefined>>, options: () => readonly string[]) => {
    const scope = effectScope();
    scope.run(() => useRailMemory(`test.scope`, choice, options));
    return () => scope.stop();
};

beforeEach(() => {
    localStorage.clear();
});

describe(`useRailMemory`, () => {
    it(`restores the last choice once the rail knows what it can offer`, async () => {
        localStorage.setItem(KEY, `intentic`);
        const choice = ref<string | undefined>(undefined);
        const options = ref<string[]>([]);

        const stop = mount(choice, () => options.value);
        // Nothing to validate against yet, so nothing is restored: the report has not landed.
        expect(choice.value).toBeUndefined();

        options.value = [`registry`, `intentic`];
        await nextTick();
        expect(choice.value).toBe(`intentic`);
        stop();
    });

    // A choice already in the URL is somebody being deliberate: a shared link, a bookmark, the Back button.
    it(`leaves a deep link alone`, async () => {
        localStorage.setItem(KEY, `intentic`);
        const choice = ref<string | undefined>(`registry`);

        const stop = mount(choice, () => [`registry`, `intentic`]);
        await nextTick();
        expect(choice.value).toBe(`registry`);
        stop();
    });

    // The check that lets one remembered value sit behind every workspace: a name that is not on offer here
    // cannot select an empty list.
    it(`ignores a remembered value the rail no longer offers`, async () => {
        localStorage.setItem(KEY, `deleted-repo`);
        const choice = ref<string | undefined>(undefined);

        const stop = mount(choice, () => [`registry`, `intentic`]);
        await nextTick();
        expect(choice.value).toBeUndefined();
        stop();
    });

    // "All" is a choice too. Someone who widened the scope on purpose should find it wide when they come back.
    it(`remembers all, and restoring it is a no-op`, async () => {
        const choice = ref<string | undefined>(`intentic`);
        const stop = mount(choice, () => [`registry`, `intentic`]);
        await nextTick();

        choice.value = undefined;
        await nextTick();
        expect(localStorage.getItem(KEY)).toBe(``);
        stop();

        const next = ref<string | undefined>(undefined);
        const stopNext = mount(next, () => [`registry`, `intentic`]);
        await nextTick();
        expect(next.value).toBeUndefined();
        stopNext();
    });

    // Once the rail has rows the reader is driving, and a second restore would fight them.
    it(`restores once, then stays out of the way`, async () => {
        localStorage.setItem(KEY, `intentic`);
        const choice = ref<string | undefined>(undefined);
        const options = ref<string[]>([`registry`, `intentic`]);

        const stop = mount(choice, () => options.value);
        await nextTick();
        expect(choice.value).toBe(`intentic`);

        choice.value = undefined;
        await nextTick();
        // A later poll re-delivers the options; the memory must not drag the reader back.
        options.value = [`registry`, `intentic`, `docs`];
        await nextTick();
        expect(choice.value).toBeUndefined();
        stop();
    });

    // A rail modelled on a plain string spells "all" as ``: a <Picker> has no undefined to offer, so both
    // shapes have to read as "nothing has been narrowed to".
    it(`treats an empty string as no choice`, async () => {
        localStorage.setItem(KEY, `intentic`);
        const choice = ref<string | undefined>(``);

        const stop = mount(choice, () => [`registry`, `intentic`]);
        await nextTick();
        expect(choice.value).toBe(`intentic`);
        stop();
    });
});
