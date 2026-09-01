// @vitest-environment jsdom
//
// The mark for words still sitting in a chat's composer, drawn on the fleet board's card and on the chat rail's
// row. What is load-bearing here is not the markup but WHAT THE HOVER SAYS: the face can only report that a
// message exists, so the hint is where "which one" and "how long has it been there" have to live, and each part
// has to drop out cleanly rather than render as a hole. Mounted with plain Vue, as MatchLine.test does, with the
// glyph and the tooltip directive stubbed the way the page tests stub them (Subagents.test).
import { describe, expect, it, vi } from "vitest";
import { type App, createApp, defineComponent, h } from "vue";

import UnsentMark from "./UnsentMark.vue";

let app: App | undefined;
// Which way the hover opens, off the directive's own binding: the stub is where the modifier is observable at
// all, since a stubbed tooltip renders nothing to measure.
let opens: Partial<Record<string, boolean>> = {};

const render = (props: { preview?: string; at?: number; now?: number }): HTMLElement => {
    app?.unmount();
    const host = document.createElement(`div`);
    document.body.append(host);
    app = createApp({ render: () => h(UnsentMark, props) });
    app.component(
        `Icon`,
        defineComponent({
            props: { name: String },
            render() {
                return h(`i`, { "data-icon": this.name });
            },
        }),
    );
    opens = {};
    app.directive(`tooltip`, {
        mounted: (_el, binding) => {
            opens = binding.modifiers;
        },
    });
    app.mount(host);
    return host;
};

// The hint is read off the accessible name, which carries the same string as the tooltip for exactly the reason
// the aria-label exists: a tooltip is not announced.
const hintOf = (props: { preview?: string; at?: number; now?: number }): string | null =>
    render(props).querySelector(`span`)!.getAttribute(`aria-label`);

describe(`<UnsentMark>`, () => {
    // A chip carrying the composer's own send glyph, never a lone glyph: the rail wore a bare paper plane once,
    // findable when you knew it was there and invisible while skimming, which is when a draft gets lost.
    it(`says it in a word, beside the send glyph`, () => {
        const host = render({ preview: `fix the login redirect`, at: 1_000, now: 1_000 });
        expect(host.textContent?.trim()).toBe(`Unsent`);
        expect(host.querySelector(`[data-icon]`)?.getAttribute(`data-icon`)).toBe(`send`);
    });

    it(`names the message and how long it has been standing`, () => {
        vi.spyOn(Date, `now`).mockReturnValue(1_000_000);
        try {
            expect(hintOf({ preview: `fix the login redirect`, at: 1_000_000 - 12 * 60_000 })).toBe(`Not sent, 12m: fix the login redirect`);
        } finally {
            vi.mocked(Date.now).mockRestore();
        }
    });

    /* The age is computed against the HOST'S TICK where there is one, not against the clock: this mark's props
     * are as still as the draft is, so a component reading the clock itself renders the age it was first built
     * with and then keeps it — "just now", an hour later. */
    it(`ages against the tick it is given rather than the wall clock`, () => {
        expect(hintOf({ preview: `fix the login redirect`, at: 1_000, now: 1_000 + 3 * 3_600_000 })).toBe(`Not sent, 3h: fix the login redirect`);
    });

    // An attachment, or a message queued behind a running turn, is unsent with nothing to quote. The mark is true
    // either way; its hint simply stops naming what is in there.
    it(`reports the age alone when what is unsent is not typed words`, () => {
        expect(hintOf({ at: 1_000, now: 1_000 + 2 * 86_400_000 })).toBe(`Not sent, 2d`);
    });

    /* WITH NEITHER FACT IT NAMES THE STATE PLAINLY — a chat restored from a snapshot that carried no stamp. The
     * floor matters because this tautology is what the hint used to be at EVERY hover: a chip reading "Unsent"
     * over a tooltip reading "unsent message" is the row saying itself twice, and the reason the words and the
     * age are carried here at all. */
    it(`falls back to naming the state when it has neither the words nor the age`, () => {
        expect(hintOf({})).toBe(`You have an unsent message here`);
    });

    /* THE HINT OPENS DOWNWARDS, and this is the one property here that was found by looking at the app rather
     * than at the code. The mark sits directly under a session's title in all three frames it is drawn in (the
     * board's card, the board's dense row, the chat rail's row), so a hover opening upwards covers that title:
     * the reader hovers to learn WHICH unsent message this is and the answer hides the name of the session
     * holding it. Downwards it covers the meta line instead — model, origin, age — which the hint's own two
     * lines outweigh for the second they are on screen. On the rail it also clears the row's HoverCard, which
     * opens to the right off the very same hover. */
    it(`opens away from the title it belongs to`, () => {
        render({ preview: `fix the login redirect`, at: 1_000, now: 1_000 });
        expect(opens).toEqual({ bottom: true });
    });
});
