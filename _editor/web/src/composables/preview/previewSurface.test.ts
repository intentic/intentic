// @vitest-environment jsdom
//
/* THE WELCOME THAT MUST NOT BECOME A HABIT. A fresh sandbox arrives with a starter site already running, and
 * the first visit opens the preview on it, because a site nobody is shown is the same as no site. Every visit
 * after that belongs to the reader: whatever they last chose to look at, including nothing. The flag that draws
 * that line is STORED, so the reload a user does five seconds later does not count as a new first visit — the
 * regression this pins is the panel reappearing over whatever they had navigated to instead. */
import { beforeEach, expect, it, vi } from "vitest";

const SANDBOX = `sbx-1`;

vi.mock(`../sandbox/useSandbox`, () => ({ useSandbox: () => ({ activeSandboxId: { value: SANDBOX } }) }));

const router = { push: vi.fn() } as unknown as import("vue-router").Router;

beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    vi.mocked(router.push).mockClear();
});

it(`opens the preview on the first visit, on the target it was given`, async () => {
    const { openPreviewOnFirstVisit, previewOpened, previewSelectedId } = await import(`./previewSurface`);

    expect(openPreviewOnFirstVisit(router, `app:site/landing`)).toBe(true);
    expect(previewOpened.value).toBe(true);
    expect(previewSelectedId.value).toBe(`app:site/landing`);
    expect(router.push).toHaveBeenCalledWith(`/preview`);
});

it(`never opens it a second time, not even across a reload`, async () => {
    const first = await import(`./previewSurface`);
    expect(first.openPreviewOnFirstVisit(router, `app:site/landing`)).toBe(true);

    // A reload: fresh module state, the same origin's storage. The visit is not the first one any more.
    vi.resetModules();
    const second = await import(`./previewSurface`);
    expect(second.openPreviewOnFirstVisit(router, `app:site/landing`)).toBe(false);
    expect(second.previewOpened.value).toBe(false);
    expect(router.push).toHaveBeenCalledTimes(1);
});

it(`is per sandbox: a box the reader has never opened gets its own welcome`, async () => {
    const { openPreviewOnFirstVisit } = await import(`./previewSurface`);
    expect(openPreviewOnFirstVisit(router, `app:site/landing`)).toBe(true);
    // The other box's flag, in its own key: this one has still never been visited.
    localStorage.removeItem(`intentic-preview-autoshown:${SANDBOX}`);
    localStorage.setItem(`intentic-preview-autoshown:sbx-2`, `1`);
    expect(openPreviewOnFirstVisit(router, `app:site/landing`)).toBe(true);
});
