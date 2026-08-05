import { sinceOf, withinWindow } from "@intentic/ui/time";
import { expect, test } from "vitest";

/* The app's one "how far back" vocabulary (_editor/ui/src/timeWindow.ts) — Activity and Logs both narrow their
 * feed by it, so a wrong cutoff here silently hides rows on two surfaces at once. The suite sits in the web app
 * for the same reason figures.test.ts and dagLayout.test.ts do: _editor/ui has no test runner of its own, and
 * this is the package that runs the kit's code. It reaches the module by its own subpath rather than the
 * barrel, for the reason every other pure-logic subpath exists: the barrel boots the component graph and wants
 * a DOM, and arithmetic over a timestamp should not need one.
 *
 * `all` is the case worth holding onto: it is the only preset whose answer is not arithmetic, and -Infinity is
 * what makes it correct for an entry a clock skew has put in the future, where `now - <a century>` is merely
 * large enough to get away with it. */

const at = (minutes: number): number => Date.UTC(2026, 7, 2, 12, 0, 0) + minutes * 60_000;

test("the window presets bound the feed and `all` does not", () => {
    expect(sinceOf(`1h`, at(0))).toBe(at(-60));
    expect(sinceOf(`24h`, at(0))).toBe(at(-60 * 24));
    expect(sinceOf(`7d`, at(0))).toBe(at(-60 * 24 * 7));
    expect(sinceOf(`all`, at(0))).toBe(-Infinity);
    expect(withinWindow(at(5), `all`, at(0))).toBe(true);
    expect(withinWindow(at(-90), `1h`, at(0))).toBe(false);
});
