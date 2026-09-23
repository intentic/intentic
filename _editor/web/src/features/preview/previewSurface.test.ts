//
/* THE WELCOME THAT MUST NOT BECOME A HABIT. */
import "@intentic/testing/dom";
import { freshImport, mocked } from "@intentic/testing/bun";

const SANDBOX = `sbx-1`;

jest.mock(`../sandbox/client/useSandbox`, () => ({ useSandbox: () => ({ activeSandboxId: { value: SANDBOX } }) }));

const router = { push: jest.fn() } as unknown as import("vue-router").Router;

// The panel's `opened` flag is module state, so a case that asks what a fresh window does needs a fresh evaluation.
const load = () => freshImport<typeof import("./previewSurface")>("./previewSurface", import.meta.url);

beforeEach(() => {
    localStorage.clear();
    mocked(router.push).mockClear();
});

it(`opens the preview on the first visit, on the target it was given`, async () => {
    const { openPreviewOnFirstVisit, previewOpened, previewSelectedId } = await load();

    expect(openPreviewOnFirstVisit(router, `app:site/landing`)).toBe(true);
    expect(previewOpened.value).toBe(true);
    expect(previewSelectedId.value).toBe(`app:site/landing`);
    expect(router.push).toHaveBeenCalledWith(`/preview`);
});

it(`never opens it a second time, not even across a reload`, async () => {
    const first = await load();
    expect(first.openPreviewOnFirstVisit(router, `app:site/landing`)).toBe(true);

    // A reload: fresh module state, the same origin's storage. The visit is not the first one any more.
    const second = await load();
    expect(second.openPreviewOnFirstVisit(router, `app:site/landing`)).toBe(false);
    expect(second.previewOpened.value).toBe(false);
    expect(router.push).toHaveBeenCalledTimes(1);
});

it(`is per sandbox: a box the reader has never opened gets its own welcome`, async () => {
    const { openPreviewOnFirstVisit } = await load();
    expect(openPreviewOnFirstVisit(router, `app:site/landing`)).toBe(true);
    // The other box's flag, in its own key: this one has still never been visited.
    localStorage.removeItem(`intentic-preview-autoshown:${SANDBOX}`);
    localStorage.setItem(`intentic-preview-autoshown:sbx-2`, `1`);
    expect(openPreviewOnFirstVisit(router, `app:site/landing`)).toBe(true);
});
