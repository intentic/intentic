// @vitest-environment jsdom
// Asserts which reading the badge shows in each state, not its markup; every number is final so nothing here is
// provisional. Mounted with plain Vue, as markdownFigures.test does.
import { describe, expect, it } from "vitest";
import { createApp, h, nextTick } from "vue";

import ReviewStat from "./ReviewStat.vue";
import { useLayout } from "../shell/window/useLayout";
import type { LineStat } from "@intentic/code-read";
import { IconStub } from "@intentic/ui/testing";

const { showComments, toggleShowComments } = useLayout();

interface Props {
    code?: LineStat;
    additions?: number;
    deletions?: number;
    of?: number;
}

const render = (props: Props): HTMLElement => {
    const host = document.createElement(`div`);
    document.body.append(host);
    const app = createApp({ render: () => h(ReviewStat, props) });
    // Icon and tooltip are global (installUi); icon is stubbed here, tooltip keeps its text (what's tested).
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {
        mounted: (el: HTMLElement, binding: { value?: string }) => {
            if (binding.value !== undefined) {
                el.dataset[`tip`] = binding.value;
            }
        },
    });
    app.mount(host);
    return host;
};

const withComments = async (on: boolean): Promise<void> => {
    if (showComments.value !== on) {
        toggleShowComments();
    }
    await nextTick();
};

describe(`<ReviewStat>`, () => {
    it(`prints the code-only counts while the comments are hidden, and says what git makes it on hover`, async () => {
        await withComments(false);
        const host = render({ code: { additions: 3, deletions: 0 }, additions: 34, deletions: 8 });

        expect(host.textContent).toContain(`+3`);
        expect(host.textContent).not.toContain(`34`);
        expect(host.querySelector<HTMLElement>(`[data-tip]`)?.dataset[`tip`]).toContain(`+34`);
        expect(host.querySelector<HTMLElement>(`[data-tip]`)?.dataset[`tip`]).toContain(`−8`);
    });

    it(`hands the numbers back to git when the reader asks for the comments`, async () => {
        await withComments(true);
        const host = render({ code: { additions: 3, deletions: 0 }, additions: 34, deletions: 8 });

        expect(host.textContent).toContain(`+34`);
        expect(host.textContent).toContain(`−8`);
        // Nothing differs from what's on screen, so there's no hover to add.
        expect(host.querySelector(`[data-tip]`)).toBeNull();
    });

    it(`says a change is comments rather than showing it as nothing at all`, async () => {
        await withComments(false);
        const host = render({ code: { additions: 0, deletions: 0 }, additions: 26, deletions: 4 });

        // +0 −0 reads as a rename, as if the file were untouched.
        expect(host.textContent).toMatch(/comments|\+0|−0/);
        const tip = host.querySelector<HTMLElement>(`[data-tip]`)?.dataset[`tip`] ?? ``;
        expect(tip).toContain(`+26`);
        expect(tip).toContain(`−4`);
    });

    it(`shows git's own for a file it could not strip, with nothing extra claimed on hover`, async () => {
        await withComments(false);
        const host = render({ code: undefined, additions: 12, deletions: 2 });

        expect(host.textContent).toContain(`+12`);
        expect(host.textContent).toContain(`−2`);
        expect(host.querySelector(`[data-tip]`)).toBeNull();
    });

    // A file with no code-only reading (bytes, an oversized side, an unsupported language) arrives with no `code`;
    // git's numbers become the answer, at full weight and with no hover.
    it(`prints git's numbers whole for a file that cannot be read as code`, async () => {
        await withComments(false);
        const host = render({ additions: 54, deletions: 0 });

        expect(host.textContent).toContain(`+54`);
        expect(host.querySelector(`.opacity-50`)).toBeNull();
        expect(host.querySelector(`[data-tip]`)).toBeNull();
    });
});

// The rail asks the same badge how much new code this file is against the list; it must agree with the numbers
// printed beside it and draw nothing where there is nothing to rank.
const rail = (host: HTMLElement): HTMLElement | null => host.querySelector<HTMLElement>(`span[aria-hidden="true"]`);
// The bar's length as a share of its track.
const fill = (host: HTMLElement): string | undefined => (rail(host)?.firstElementChild as HTMLElement | undefined)?.style.width;

describe(`<ReviewStat> rail`, () => {
    it(`draws nothing at all unless the caller says what to scale against`, async () => {
        await withComments(false);
        expect(rail(render({ code: { additions: 12, deletions: 3 }, additions: 12, deletions: 3 }))).toBeNull();
    });

    it(`fills the track for the file that added the most in the list`, async () => {
        await withComments(false);
        expect(fill(render({ code: { additions: 50, deletions: 10 }, additions: 60, deletions: 12, of: 50 }))).toBe(`100%`);
    });

    // Scales the rail to the reading the badge shows, not git's raw count: a bar drawn off git's number would be
    // full, off the shown number it's partial.
    it(`scales to the reading the badge is showing, not to git's`, async () => {
        await withComments(false);
        expect(fill(render({ code: { additions: 3, deletions: 0 }, additions: 34, deletions: 8, of: 34 }))).not.toBe(`100%`);
    });

    it(`follows the reader back to git's numbers when the comments come on`, async () => {
        await withComments(true);
        expect(fill(render({ code: { additions: 3, deletions: 0 }, additions: 34, deletions: 8, of: 34 }))).toBe(`100%`);
    });

    // A deletion is 'no new code', not the smallest value, so it draws no rail at all. Measured as additions, not
    // total churn, so one big deletion doesn't dominate the scale.
    it(`stays off a row that added nothing, however much it removed`, async () => {
        await withComments(false);
        expect(rail(render({ code: { additions: 0, deletions: 1353 }, additions: 0, deletions: 1353, of: 131 }))).toBeNull();
    });

    it(`stays away from a row whose size is unknown rather than drawing a zero`, async () => {
        await withComments(false);
        expect(rail(render({ of: 50 }))).toBeNull();
    });
});
