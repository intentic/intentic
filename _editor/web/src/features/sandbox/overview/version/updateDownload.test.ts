import type { PreparingUpdate } from "@intentic/sandbox-contract";
import { DOWNLOAD_POLL_MS, downloadPercent, downloadPollMs, downloadStep, downloading, mayStart, OFFER_POLL_MS, START_AGAIN_MS } from "./updateDownload";

const NOW = 1_790_000_000_000;
const pulling: PreparingUpdate = { channel: `stable`, startedAt: NOW - 60_000, at: NOW, phase: `download`, percent: 41.6 };
const idle = { offered: true, staged: false, preparing: undefined, starting: false };

it(`draws a download the machine says is running, and one the card has just asked for, but never once it is downloaded`, () => {
    expect(downloading({ ...idle, preparing: pulling })).toBe(true);
    expect(downloading({ ...idle, starting: true })).toBe(true);
    expect(downloading(idle)).toBe(false);
    expect(downloading({ ...idle, preparing: pulling, staged: true })).toBe(false);
    expect(downloading({ ...idle, preparing: pulling, offered: false })).toBe(false);
});

it(`re-reads often while a download runs, now and then while one may start, and not at all otherwise`, () => {
    expect(downloadPollMs({ ...idle, preparing: pulling })).toBe(DOWNLOAD_POLL_MS);
    expect(downloadPollMs({ ...idle, starting: true })).toBe(DOWNLOAD_POLL_MS);
    expect(downloadPollMs(idle)).toBe(OFFER_POLL_MS);
    expect(downloadPollMs({ ...idle, staged: true })).toBe(false);
    expect(downloadPollMs({ ...idle, offered: false })).toBe(false);
});

it(`asks for the same release's download again only once half an hour has passed`, () => {
    expect(mayStart(undefined, NOW)).toBe(true);
    expect(mayStart(NOW - START_AGAIN_MS + 1, NOW)).toBe(false);
    expect(mayStart(NOW - START_AGAIN_MS, NOW)).toBe(true);
});

it(`names the step, and gives a percent only for a pull that measured one`, () => {
    expect(downloadStep(undefined)).toBe(`starting`);
    expect(downloadStep(pulling)).toBe(`download`);
    expect(downloadStep({ ...pulling, phase: `build`, percent: undefined })).toBe(`build`);
    expect(downloadStep({ ...pulling, phase: `check` })).toBe(`check`);
    // A step a newer ic names is still the download, as far as this card can say.
    expect(downloadStep({ ...pulling, phase: `verify` })).toBe(`download`);
    expect(downloadPercent(pulling)).toBe(42);
    expect(downloadPercent({ ...pulling, percent: undefined })).toBeUndefined();
    expect(downloadPercent({ ...pulling, phase: `build` })).toBeUndefined();
    expect(downloadPercent(undefined)).toBeUndefined();
});
