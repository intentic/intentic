import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import { effectScope, nextTick, ref } from "vue";
import { useHeldAddress } from "./heldAddress";

// What the address bar says between Enter and the page arriving: the typed address, never the one being left or a
// blank, and never past the page's own word on where it went.

beforeEach(() => {
    jest.useFakeTimers();
});
afterEach(() => {
    jest.useRealTimers();
});

type Page = { readonly id: string; readonly url: string } | undefined;

const setup = (initial: Page) => {
    const active = ref<Page>(initial);
    const scope = effectScope();
    const held = scope.run(() => useHeldAddress(active));
    if (held === undefined) {
        throw new Error(`no scope`);
    }
    return { active, held, scope };
};

test("a navigation holds the typed address over the one being left, until the page reports where it went", async () => {
    const { active, held } = setup({ id: `p1`, url: `https://www.google.com/` });
    held.hold(`https://x.com`, `p1`);
    expect(held.shown.value).toBe(`https://x.com`);
    // A title or a late report of the old address is not an arrival.
    active.value = { id: `p1`, url: `https://www.google.com/` };
    await nextTick();
    expect(held.shown.value).toBe(`https://x.com`);
    active.value = { id: `p1`, url: `https://x.com/` };
    await nextTick();
    expect(held.shown.value).toBeUndefined();
});

test("a tab still opening shows the address from the moment of Enter, through its blank start, to its arrival", async () => {
    const { active, held } = setup(undefined);
    held.hold(`https://google.com`, undefined);
    // Nothing open yet: the start page's bar, while the window comes up.
    expect(held.shown.value).toBe(`https://google.com`);
    held.settle(`p7`);
    active.value = { id: `p7`, url: `about:blank` };
    await nextTick();
    expect(held.shown.value).toBe(`https://google.com`);
    active.value = { id: `p7`, url: `https://www.google.com/` };
    await nextTick();
    expect(held.shown.value).toBeUndefined();
});

test("the hold is its own tab's: another tab shows its own address, and coming back shows the hold again", async () => {
    const { active, held } = setup({ id: `p1`, url: `https://a.test/` });
    held.hold(`https://b.test`, `p1`);
    active.value = { id: `p2`, url: `https://c.test/` };
    await nextTick();
    expect(held.shown.value).toBeUndefined();
    active.value = { id: `p1`, url: `https://a.test/` };
    await nextTick();
    expect(held.shown.value).toBe(`https://b.test`);
});

test("a navigation that never reports back is let go of after a while", async () => {
    const { held } = setup({ id: `p1`, url: `https://a.test/` });
    held.hold(`https://unreachable.test`, `p1`);
    await advanceTimersByTimeAsync(14_000);
    expect(held.shown.value).toBe(`https://unreachable.test`);
    await advanceTimersByTimeAsync(1_001);
    expect(held.shown.value).toBeUndefined();
});

test("release drops it at once: an open that failed, or one that answered with no tab", () => {
    const { held } = setup(undefined);
    held.hold(`https://a.test`, undefined);
    held.release();
    expect(held.shown.value).toBeUndefined();
});
