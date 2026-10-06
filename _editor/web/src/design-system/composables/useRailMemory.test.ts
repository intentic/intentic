import "@intentic/testing/dom";
import { effectScope, nextTick, ref } from "vue";
import { useRailMemory } from "@intentic/ui";

// The rules a remembered rail choice must keep, each a way of getting this wrong that is worse than not remembering at
// all: overriding a link somebody sent, opening a view on a repository that no longer exists, or quietly re-narrowing a
// scope the reader had deliberately widened.
//
// The barrel reaches window.matchMedia (useDevice) at import: hence jsdom.

const KEY = `intentic.rail.test.scope`;

// A rail lives inside a component, so its watchers need a scope that can dispose them; running them loose would leak a
// pair of watchers into every later test. Returns the ref a rail's controls write through, and the disposer.
const mount = (choice: ReturnType<typeof ref<string | undefined>>, options: () => readonly string[]) => {
    const scope = effectScope();
    const picked = scope.run(() => useRailMemory(`test.scope`, choice, options));
    if (picked === undefined) {
        throw new Error(`effect scope did not run`);
    }
    return { picked, stop: () => scope.stop() };
};

beforeEach(() => {
    localStorage.clear();
});

describe(`useRailMemory`, () => {
    it(`restores the last choice once the rail knows what it can offer`, async () => {
        localStorage.setItem(KEY, `intentic`);
        const choice = ref<string | undefined>(undefined);
        const options = ref<string[]>([]);

        const { stop } = mount(choice, () => options.value);
        // Nothing to validate against yet, so nothing is restored: the report has not landed.
        expect(choice.value).toBeUndefined();

        options.value = [`registry`, `intentic`];
        await nextTick();
        expect(choice.value).toBe(`intentic`);
        stop();
    });

    // A choice already in the URL is somebody being deliberate: a shared link, a bookmark, the Back button. It is also
    // what the next bare visit should open on.
    it(`leaves a deep link alone, and remembers it`, async () => {
        localStorage.setItem(KEY, `intentic`);
        const choice = ref<string | undefined>(`registry`);

        const { stop } = mount(choice, () => [`registry`, `intentic`]);
        await nextTick();
        expect(choice.value).toBe(`registry`);
        expect(localStorage.getItem(KEY)).toBe(`registry`);
        stop();
    });

    // The check that lets one remembered value sit behind every workspace: a name not on offer here cannot select an
    // empty list.
    it(`ignores a remembered value the rail no longer offers`, async () => {
        localStorage.setItem(KEY, `deleted-repo`);
        const choice = ref<string | undefined>(undefined);

        const { stop } = mount(choice, () => [`registry`, `intentic`]);
        await nextTick();
        expect(choice.value).toBeUndefined();
        stop();
    });

    // "All" picked on purpose is a choice too: someone who widened the scope should find it wide when they come back,
    // and a later poll re-delivering the options must not drag them back either.
    it(`remembers a picked all, and restoring it is a no-op`, async () => {
        const choice = ref<string | undefined>(`intentic`);
        const options = ref<string[]>([`registry`, `intentic`]);
        const { picked, stop } = mount(choice, () => options.value);
        await nextTick();

        picked.value = undefined;
        await nextTick();
        expect(choice.value).toBeUndefined();
        expect(localStorage.getItem(KEY)).toBe(``);
        options.value = [`registry`, `intentic`, `docs`];
        await nextTick();
        expect(choice.value).toBeUndefined();
        stop();

        const next = ref<string | undefined>(undefined);
        const { stop: stopNext } = mount(next, () => [`registry`, `intentic`]);
        await nextTick();
        expect(next.value).toBeUndefined();
        stopNext();
    });

    // The rail tile links to the view's bare address, so clicking it while the view is already open empties the URL
    // without remounting anything. That is not a pick, and the view must come back to where the reader left it.
    it(`restores again when the address goes bare under a mounted rail`, async () => {
        const choice = ref<string | undefined>(undefined);
        const { picked, stop } = mount(choice, () => [`registry`, `intentic`]);
        await nextTick();

        picked.value = `intentic`;
        await nextTick();
        expect(localStorage.getItem(KEY)).toBe(`intentic`);

        choice.value = undefined;
        await nextTick();
        // Widened again: the assignment above narrows the property to undefined, and the rail's watcher wrote it back.
        expect(choice.value as string | undefined).toBe(`intentic`);
        stop();
    });

    // A rail modelled on a plain string spells "all" as ``: a <Picker> has no undefined to offer, so both shapes must
    // read as "nothing has been narrowed to".
    it(`treats an empty string as no choice`, async () => {
        localStorage.setItem(KEY, `intentic`);
        const choice = ref<string | undefined>(``);

        const { picked, stop } = mount(choice, () => [`registry`, `intentic`]);
        await nextTick();
        expect(choice.value).toBe(`intentic`);

        picked.value = ``;
        await nextTick();
        expect(choice.value).toBe(``);
        expect(localStorage.getItem(KEY)).toBe(``);
        stop();
    });
});
