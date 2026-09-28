import type { Pairing } from "./config.js";
import { holdsSync, pairingSlugs, PROBATION_HOLD_MS, recordOf, RELEASE_FORWARDS_MS, shouldReleaseForwards, swapPauseStep } from "./swap-pause.js";

/* When a pairing's file sync is held still for a swap of its sandbox on this machine, and when it is given back. */

const NOW = 1_800_000_000_000;

const pairing = (overrides: Partial<Pairing> = {}): Pairing => ({
    sandboxUrl: "https://sandbox-0123456789ab.intentic.dev",
    sandboxId: "sandbox-0123456789ab-intentic-dev",
    mode: "sync",
    ...overrides,
});

// ic names a sandbox with a public hostname by its first label, and one without by the id its connect token derives,
// which is the id that hostname carries: a pairing's URL is that hostname, so either spelling finds its record.
test("a pairing is known to this machine's ic by its hostname's first label, or by the id in it", () => {
    expect(pairingSlugs("https://sandbox-0123456789ab.intentic.dev")).toEqual(["sandbox-0123456789ab", "0123456789ab"]);
    // The own-Cloudflare path: the owner's own subdomain is the label and the id alike.
    expect(pairingSlugs("https://work.example.com")).toEqual(["work"]);
    // A URL that does not parse names no sandbox, so nothing is ever paused on its account.
    expect(pairingSlugs("not a url")).toEqual([]);
    expect(recordOf(pairing(), [{ slug: "other", phase: "cutover" }, { slug: "0123456789ab", phase: "probation", at: NOW }])).toEqual({
        slug: "0123456789ab",
        phase: "probation",
        at: NOW,
    });
    expect(recordOf(pairing(), [{ slug: "other", phase: "cutover" }])).toBeUndefined();
});

test("sync holds through the cutover and the first quarter hour of probation, then only while the sandbox is silent", () => {
    expect(holdsSync(undefined, NOW, true)).toBe(false);
    expect(holdsSync({ slug: "s" }, NOW, false)).toBe(false);
    expect(holdsSync({ slug: "s", phase: "cutover", at: NOW - 2 * PROBATION_HOLD_MS }, NOW, true)).toBe(true);
    const proving = (at: number | undefined) => ({ slug: "s", phase: "probation", at });
    expect(holdsSync(proving(NOW - PROBATION_HOLD_MS + 1), NOW, true)).toBe(true);
    expect(holdsSync(proving(NOW - PROBATION_HOLD_MS), NOW, true)).toBe(false);
    expect(holdsSync(proving(NOW - PROBATION_HOLD_MS), NOW, false)).toBe(true);
    // Nothing to measure from is read as the swap having just begun.
    expect(holdsSync(proving(undefined), NOW, true)).toBe(true);
    // A phase a newer ic adds is read as probation.
    expect(holdsSync({ slug: "s", phase: "verifying", at: NOW - 2 * PROBATION_HOLD_MS }, NOW, true)).toBe(false);
});

// Only file sync is paused, only once, and only a pause this rule made is lifted by it: a person's own pause stays.
test("a held pairing is paused once, and only the pause the swap made is resumed", () => {
    expect(swapPauseStep(pairing(), true)).toBe("pause");
    expect(swapPauseStep(pairing({ fileSyncSwapPaused: true }), true)).toBeUndefined();
    expect(swapPauseStep(pairing({ fileSyncSwapPaused: true }), false)).toBe("resume");
    expect(swapPauseStep(pairing(), false)).toBeUndefined();
    expect(swapPauseStep(pairing({ mode: "mirror" }), true)).toBeUndefined();
});

test("forwarded ports come off localhost once the sandbox has been silent ten minutes, if it holds any", () => {
    expect(shouldReleaseForwards(RELEASE_FORWARDS_MS - 1, 2)).toBe(false);
    expect(shouldReleaseForwards(RELEASE_FORWARDS_MS, 2)).toBe(true);
    expect(shouldReleaseForwards(RELEASE_FORWARDS_MS, 0)).toBe(false);
});
