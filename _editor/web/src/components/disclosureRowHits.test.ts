// @vitest-environment jsdom
//
// WHAT A PRESS ON AN EXPANDABLE ROW MEANS, pinned on the real component because the bug this suite exists for
// was invisible from every side except a pointer's.
//
// <DisclosureRow hit="pair"> used to make the whole title-and-description block swallow its clicks, on the
// theory that such a row's headline is a control. On the activity feed only a turn WITH a transcript has a
// link for a title, so on every message and every loose event the row's own name did nothing and the row
// opened from a 10px chevron — while `ui-row-select` painted a pointer cursor and a hover wash over all of it.
// The rows that DID carry a link were no better: the link is a few words, and the facts line, the preview and
// the space after a short name were dead on the same rule. Nothing about that is visible in a snapshot, in a
// typecheck, or in a projection test; it is only visible in where a click lands.
//
// So what is pinned here is the geography: which parts of a row open it, which parts belong to a control, and
// which parts of an OPEN row close it again. Mounted with plain Vue rather than @vue/test-utils, as
// brandMarkTiers.test.ts and ReviewStat.test.ts do.
import { DisclosureRow } from "@intentic/ui";
import { afterEach, expect, it } from "vitest";
import { type App, createApp, h, nextTick, ref } from "vue";

/* ONE REAL MILLISECOND BEFORE EVERY DISPATCH, and it is jsdom's clock rather than anything under test.
 *
 * Vue stamps each event with `Date.now()` and then DROPS it on any handler whose attach time is greater than
 * or equal to that stamp — a guard so a listener added while an event is dispatching does not then receive
 * that same event. In a browser the guard never fires: `Event.timeStamp` is high-resolution, so Vue compares
 * against `performance.now()` (milliseconds since load, a small number) while the stamp is epoch milliseconds
 * (a vast one). Under jsdom both clocks are `Date.now()`, a mount and the click after it land inside the same
 * millisecond, and the handler is skipped.
 *
 * Which reads as a flaky component: roughly half of these presses were swallowed before <DisclosureRow> saw
 * them, on whichever test happened to run inside its own mount's millisecond. Worth the ~10ms it costs the
 * file to be rid of, and worth writing down, because the next suite to dispatch a synthetic event at a
 * freshly-mounted component will meet it too. */
const afterAMillisecond = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1));

/* A press, as a pointer makes one: down somewhere, up (and click) somewhere `moved` pixels away. The
 * `pointerdown` is what <DisclosureRow> measures a drag against, so a test that skipped it would be testing a
 * keyboard press wearing a mouse's coordinates. `detail: 1` is what marks a click as a POINTER's — the
 * keyboard's synthetic click carries 0, and the component keys on exactly that. */
const press = async (element: Element, moved = 0): Promise<void> => {
    await afterAMillisecond();
    const at = { clientX: 40, clientY: 40 };
    element.dispatchEvent(new MouseEvent(`pointerdown`, { bubbles: true, ...at }));
    element.dispatchEvent(new MouseEvent(`click`, { bubbles: true, detail: 1, clientX: at.clientX + moved, clientY: at.clientY }));
    await nextTick();
};

// Enter or Space on the toggle: a click with no pointer behind it, which the browser reports at (0, 0) with
// `detail: 0`. It has to open the row even though the last real pointer press was a viewport away.
const pressByKeyboard = async (element: Element): Promise<void> => {
    await afterAMillisecond();
    element.dispatchEvent(new MouseEvent(`click`, { bubbles: true, detail: 0, clientX: 0, clientY: 0 }));
    await nextTick();
};

interface Slots {
    readonly title: () => unknown;
    readonly description?: () => unknown;
}

interface Harness {
    readonly isOpen: () => boolean;
    /** The chevron + `#lead` mark: a real <button>, and the row's tab stop under `pair`. */
    readonly toggle: () => HTMLElement;
    readonly find: (selector: string) => HTMLElement;
    /** The expanded block, by the id the toggle says it controls. */
    readonly evidence: () => HTMLElement;
    /** The column beside the evidence — the toggle's own, continued down the open row. */
    readonly gutter: () => HTMLElement;
}

/* TORN DOWN BY THE RUNNER, not by the test body. A row left mounted is a row still holding the document, and
 * the first version of this file cleaned up on the last line of each `it` — so the one test that threw took
 * two others down with it, and the failure that mattered was reported three tests away from its cause. */
const mounted: { app: App; host: HTMLElement }[] = [];

afterEach(() => {
    for (const { app, host } of mounted.splice(0)) {
        app.unmount();
        host.remove();
    }
});

const mount = (hit: `header` | `pair`, slots: Slots): Harness => {
    const host = document.createElement(`div`);
    document.body.append(host);
    const open = ref(false);
    const app: App = createApp({
        render: () =>
            h(
                DisclosureRow,
                {
                    hit,
                    density: `compact`,
                    open: open.value,
                    "onUpdate:open": (next: boolean) => {
                        open.value = next;
                    },
                },
                {
                    lead: () => h(`span`, { class: `mark` }, `•`),
                    title: slots.title,
                    ...(slots.description === undefined ? {} : { description: slots.description }),
                    below: () => h(`p`, { class: `evidence-text` }, `14:02:11 · error · rate limited`),
                },
            ),
    });
    app.mount(host);
    mounted.push({ app, host });

    const find = (selector: string): HTMLElement => {
        const found = host.querySelector<HTMLElement>(selector);
        if (found === null) {
            throw new Error(`no ${selector} in ${host.innerHTML}`);
        }
        return found;
    };
    const toggle = (): HTMLElement => find(`button[aria-expanded]`);
    // By the id the toggle NAMES, so the lookup follows the same `aria-controls` a screen reader does. An
    // attribute selector rather than `#id` + CSS.escape: jsdom under vitest ships no `CSS` object at all.
    const evidence = (): HTMLElement => find(`[id="${toggle().getAttribute(`aria-controls`) ?? ``}"]`);
    return {
        isOpen: () => open.value,
        toggle,
        find,
        evidence,
        gutter: () => evidence().previousElementSibling as HTMLElement,
    };
};

// A plain-text headline, which is what most rows on a `pair` list actually have.
const plain = (): Harness => mount(`pair`, { title: () => h(`span`, { class: `name` }, `A message from discord`) });

// The headline this mode exists for: a name that is itself a link, over a description that is not.
const linked = (): Harness & { visits: () => number } => {
    let visits = 0;
    const harness = mount(`pair`, {
        title: () =>
            h(
                `button`,
                {
                    class: `name`,
                    type: `button`,
                    onClick: () => {
                        visits += 1;
                    },
                },
                `A turn that failed`,
            ),
        description: () => h(`span`, { class: `facts` }, `Claude · from discord`),
    });
    return Object.assign(harness, { visits: () => visits });
};

it(`opens from a headline that is not itself a control`, async () => {
    const row = plain();
    await press(row.find(`.name`));
    expect(row.isOpen()).toBe(true);
});

it(`opens from the facts line under the title`, async () => {
    const row = linked();
    await press(row.find(`.facts`));
    expect(row.isOpen()).toBe(true);
});

/* THE ONE THING `pair` IS FOR, and the reason the guard cannot simply be dropped: a press on the headline's
 * own control is that control's, and must not also open the row. Two facts in one assertion on purpose — a
 * guard that stopped the toggle by also swallowing the link would pass half of this. */
it(`gives a press on the headline's link to the link, and not to the row`, async () => {
    const row = linked();
    await press(row.find(`.name`));
    expect({ visited: row.visits(), open: row.isOpen() }).toEqual({ visited: 1, open: false });
});

it(`opens from the chevron and mark pair, and from the keyboard on it`, async () => {
    const row = plain();
    await press(row.toggle());
    expect(row.isOpen()).toBe(true);
    await pressByKeyboard(row.toggle());
    expect(row.isOpen()).toBe(false);
});

// `hit="header"` puts the whole left region in one <button>, which stops the press itself; the row-wide
// handler must not then toggle it a second time and land back where it started.
it(`toggles once, not twice, when the header itself is the button`, async () => {
    const row = mount(`header`, { title: () => h(`span`, { class: `name` }, `A turn that failed`) });
    await press(row.find(`.name`));
    expect(row.isOpen()).toBe(true);
});

/* CLOSING, WHICH IS THE HALF THAT WAS MISSING. An open row could only be closed from the header line it had
 * just pushed up the page: the evidence stops every press (it is there to be read), and the column beside it —
 * directly under the chevron, which is the one place a reader has learnt the toggle lives — was inert. */
it(`closes from the toggle column beside the open evidence, but not from the evidence itself`, async () => {
    const row = plain();
    await press(row.toggle());
    expect(row.isOpen()).toBe(true);

    await press(row.find(`.evidence-text`));
    expect(row.isOpen()).toBe(true);

    await press(row.gutter());
    expect(row.isOpen()).toBe(false);
});

it(`closes from the headline of a row it opened`, async () => {
    const row = plain();
    await press(row.toggle());
    await press(row.find(`.name`));
    expect(row.isOpen()).toBe(false);
});

/* A SELECTION IS NOT A PRESS. It only became possible to lose one here once the headline stopped swallowing
 * clicks: sweeping across an error string or a session id ends in a `click` on the row, and a row that closed
 * under that would take the text away with it. */
it(`ignores a press that travelled, so text can be selected out of the row`, async () => {
    const row = plain();
    await press(row.find(`.name`), 40);
    expect(row.isOpen()).toBe(false);

    await press(row.find(`.name`), 3);
    expect(row.isOpen()).toBe(true);
});
