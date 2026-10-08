// The chip says "Unsent"; the accessible name carries age and opening words for screen readers. Mounted with plain Vue,
// glyph stubbed as in MatchLine.test.
import "@intentic/testing/dom";
import { mocked } from "@intentic/testing/bun";
import { type App, createApp, h, nextTick } from "vue";

import UnsentMark from "../UnsentMark.vue";
import { IconStub } from "@intentic/ui/testing";

let app: App | undefined;

const render = (props: { preview?: string; at?: number }): HTMLElement => {
    app?.unmount();
    const host = document.createElement(`div`);
    document.body.append(host);
    app = createApp({ render: () => h(UnsentMark, props) });
    app.component(`Icon`, IconStub);
    app.mount(host);
    return host;
};

const ariaOf = (props: { preview?: string; at?: number }): string | null => render(props).querySelector(`span`)!.getAttribute(`aria-label`);

describe(`<UnsentMark>`, () => {
    // A chip with the send glyph, not a lone icon, so it doesn't blend in while skimming the rail.
    it(`says it in a word, beside the send glyph`, () => {
        const host = render({ preview: `fix the login redirect`, at: 1_000 });
        expect(host.textContent?.trim()).toBe(`Unsent`);
        expect(host.querySelector(`[data-icon]`)?.getAttribute(`data-icon`)).toBe(`send`);
    });

    it(`names the message and how long it has been standing`, () => {
        // A multiple of the mark's 15s step, so the age is exactly twelve minutes rather than rounded down past it.
        jest.spyOn(Date, `now`).mockReturnValue(1_005_000);
        try {
            expect(ariaOf({ preview: `fix the login redirect`, at: 1_005_000 - 12 * 60_000 })).toBe(`Not sent, 12m ago, fix the login redirect`);
        } finally {
            mocked(Date.now).mockRestore();
        }
    });

    // Ages off the shared clock the mark arms itself, and keeps ageing: a tick handed down as a prop made the rail
    // that hosts the mark redraw every card it holds, once a second, to move this one line.
    it(`ages against the shared clock as it advances`, async () => {
        jest.useFakeTimers();
        // A multiple of the mark's 15s step, so the quantised reading is the system time itself.
        jest.setSystemTime(600_000);
        try {
            const host = render({ preview: `fix the login redirect`, at: 580_000 });
            expect(host.querySelector(`span`)!.getAttribute(`aria-label`)).toBe(`Not sent, now, fix the login redirect`);
            jest.advanceTimersByTime(45_000);
            await nextTick();
            expect(host.querySelector(`span`)!.getAttribute(`aria-label`)).toBe(`Not sent, 1m ago, fix the login redirect`);
        } finally {
            app?.unmount();
            app = undefined;
            jest.useRealTimers();
        }
    });

    // An attachment or a queued message has nothing to quote; the mark still shows, the accessible name just omits the words.
    it(`reports the age alone when what is unsent is not typed words`, () => {
        jest.spyOn(Date, `now`).mockReturnValue(2 * 86_400_000);
        try {
            expect(ariaOf({ at: 0 })).toBe(`Not sent, 2d ago`);
        } finally {
            mocked(Date.now).mockRestore();
        }
    });

    // With neither the words nor the age (e.g. a snapshot with no stamp), the accessible name names the state plainly.
    it(`falls back to naming the state when it has neither the words nor the age`, () => {
        expect(ariaOf({})).toBe(`Not sent`);
    });
});
