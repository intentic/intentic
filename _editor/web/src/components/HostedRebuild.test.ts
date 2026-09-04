// @vitest-environment jsdom
//
// THE HOSTED REBUILD BUTTON, in its three states. What is pinned is the shape a person meets: a button to
// start, a sentence while the platform builds, the failure's reason and log when it did not, and the one fact
// worth saying up front, that build minutes are awake minutes.
import type { HostedBuildState } from "@intentic-app/api-contract";
import { afterEach, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick, ref } from "vue";

const build = ref<HostedBuildState | undefined>(undefined);
const applied = ref<string | undefined>(undefined);
const rebuild = vi.fn().mockResolvedValue({ state: `building`, hash: `h1`, startedAt: `2026-09-04T10:00:00.000Z` });
vi.mock(`../composables/sandbox/useHostedBuild`, () => ({ useHostedBuild: () => ({ build, applied, rebuild, isLoading: ref(false) }) }));

const { default: HostedRebuild } = await import("./HostedRebuild.vue");

// The action button by its words: a failed build's log block carries a copy button of its own.
const buttonSaying = (el: HTMLElement, words: string): HTMLButtonElement | undefined =>
    [...el.querySelectorAll(`button`)].find((button) => button.textContent?.includes(words));

let app: App | undefined;
const mount = (): HTMLElement => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(HostedRebuild, { sandboxId: `s1`, hash: `h1`, content: `FROM x\nRUN true\n` }) });
    app.mount(el);
    return el;
};

afterEach(() => {
    build.value = undefined;
    applied.value = undefined;
    rebuild.mockClear();
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

it(`offers the build, says what it costs, and sends the approved content with its hash`, async () => {
    const el = mount();
    const button = buttonSaying(el, `Rebuild now`)!;
    expect(el.textContent).toContain(`count against this sandbox's awake hours`);
    button.click();
    await nextTick();
    expect(rebuild).toHaveBeenCalledWith(`h1`, `FROM x\nRUN true\n`);
});

it(`narrates a build in flight and offers nothing to press`, () => {
    build.value = { state: `building`, hash: `h1`, startedAt: `2026-09-04T10:00:00.000Z` };
    const el = mount();
    expect(el.textContent).toContain(`Building your environment`);
    expect(el.querySelector(`button`)).toBeNull();
});

it(`says the sandbox is restarting once the platform has pointed it at the built image`, () => {
    build.value = { state: `built`, hash: `h1`, startedAt: `2026-09-04T10:00:00.000Z`, finishedAt: `2026-09-04T10:05:00.000Z` };
    applied.value = `h1`;
    const el = mount();
    expect(el.textContent).toContain(`restarting onto the new image`);
    expect(el.querySelector(`button`)).toBeNull();
});

it(`shows a failure's reason and log tail, and offers to try again`, () => {
    build.value = {
        state: `failed`,
        hash: `h1`,
        startedAt: `2026-09-04T10:00:00.000Z`,
        finishedAt: `2026-09-04T10:01:00.000Z`,
        error: `the build exited 100 without pushing an image`,
        log: `E: Unable to locate package gnucobol`,
    };
    const el = mount();
    expect(el.textContent).toContain(`The build failed: the build exited 100 without pushing an image`);
    expect(el.textContent).toContain(`Unable to locate package gnucobol`);
    expect(buttonSaying(el, `Try the build again`)).toBeInstanceOf(HTMLButtonElement);
});

// A failure for a recipe the owner has since replaced is history, not a verdict on the new one.
it(`ignores a build of some other content`, () => {
    build.value = { state: `failed`, hash: `older`, startedAt: `2026-09-04T09:00:00.000Z`, error: `nope` };
    const el = mount();
    expect(el.textContent).not.toContain(`The build failed`);
    expect(buttonSaying(el, `Rebuild now`)).toBeInstanceOf(HTMLButtonElement);
});
