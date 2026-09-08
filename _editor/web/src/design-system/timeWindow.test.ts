import { sinceOf, withinWindow } from "@intentic/ui/time";
import { expect, test } from "vitest";

// The app's one "how far back" vocabulary (_editor/ui/src/lib/timeWindow.ts); Activity and Logs both narrow their feed
// by it, so a wrong cutoff here silently hides rows on both. Reached by its own subpath rather than the barrel since
// arithmetic over a timestamp should not need a DOM.
//
// `all` is worth holding onto: it is the only preset whose answer is not arithmetic, and -Infinity is what keeps it
// correct for an entry a clock skew has put in the future.

const at = (minutes: number): number => Date.UTC(2026, 7, 2, 12, 0, 0) + minutes * 60_000;

test("the window presets bound the feed and `all` does not", () => {
    expect(sinceOf(`1h`, at(0))).toBe(at(-60));
    expect(sinceOf(`24h`, at(0))).toBe(at(-60 * 24));
    expect(sinceOf(`7d`, at(0))).toBe(at(-60 * 24 * 7));
    expect(sinceOf(`all`, at(0))).toBe(-Infinity);
    expect(withinWindow(at(5), `all`, at(0))).toBe(true);
    expect(withinWindow(at(-90), `1h`, at(0))).toBe(false);
});
