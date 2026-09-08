// @vitest-environment jsdom
// What a press on an expandable row opens or closes, pinned on the real component since the failure is only visible
// from a pointer, not a snapshot or a typecheck. `hit="pair"` used to let the whole title/description block swallow
// clicks, so a plain name did nothing and a link's surrounding text was dead too. This pins the geography: which parts
// open a row, which belong to a control, and which parts of an open row close it again.
import { DisclosureRow } from "@intentic/ui";
import { afterEach, expect, it } from "vitest";
import { type App, createApp, h, nextTick, ref } from "vue";

// Vue stamps each event with `Date.now()` and drops it on any handler added at or after that stamp. Under jsdom both
// the event stamp and the attach clock are `Date.now()`, so a mount and the click right after it can land in the same
// millisecond and the handler gets skipped; waiting one real ms avoids it.
const afterAMillisecond = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1));

// A press as a pointer makes one: `pointerdown` somewhere, then `click` (`detail: 1`, a pointer's mark) up to `moved`
// pixels away. <DisclosureRow> measures the drag against the `pointerdown`.
const press = async (element: Element, moved = 0): Promise<void> => {
    await afterAMillisecond();
    const at = { clientX: 40, clientY: 40 };
    element.dispatchEvent(new MouseEvent(`pointerdown`, { bubbles: true, ...at }));
    element.dispatchEvent(new MouseEvent(`click`, { bubbles: true, detail: 1, clientX: at.clientX + moved, clientY: at.clientY }));
    await nextTick();
};

// Enter/Space produces a click with no pointer behind it: `detail: 0` at (0, 0). It must open the row even though the
// last real pointer press was elsewhere.
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
    /** The expanded block, by the id the toggle names as `aria-controls`. */
    readonly evidence: () => HTMLElement;
    /** The column beside the evidence: the toggle's own, continued down the open row. */
    readonly gutter: () => HTMLElement;
}

// Torn down by the runner rather than by each test body, so a test that throws does not leave the document held by a
// mounted row that outlives it.
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
    // By the id the toggle names via `aria-controls`, so the lookup follows what a screen reader would. An attribute
    // selector rather than `#id` + CSS.escape: jsdom under vitest ships no `CSS` object.
    const evidence = (): HTMLElement => find(`[id="${toggle().getAttribute(`aria-controls`) ?? ``}"]`);
    return {
        isOpen: () => open.value,
        toggle,
        find,
        evidence,
        gutter: () => evidence().previousElementSibling as HTMLElement,
    };
};

// A plain-text headline, which is what most rows on a `pair` list have.
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

// The one thing `pair` is for: a press on the headline's own control belongs to that control and must not also open the
// row. Both facts are asserted together, since a guard that stops the toggle by also swallowing the link would pass
// half of this.
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

// `hit="header"` puts the whole left region in one <button>, which stops the press itself; the row-wide handler must
// not toggle it a second time.
it(`toggles once, not twice, when the header itself is the button`, async () => {
    const row = mount(`header`, { title: () => h(`span`, { class: `name` }, `A turn that failed`) });
    await press(row.find(`.name`));
    expect(row.isOpen()).toBe(true);
});

// Closing: an open row could previously only close from the header line it had pushed up the page. The evidence stops
// presses (it is there to be read); the column beside it, under the chevron, must not be inert.
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

// A selection is not a press: sweeping across text ends in a `click` on the row, and a row that closed on that would
// take the selected text away with it.
it(`ignores a press that travelled, so text can be selected out of the row`, async () => {
    const row = plain();
    await press(row.find(`.name`), 40);
    expect(row.isOpen()).toBe(false);

    await press(row.find(`.name`), 3);
    expect(row.isOpen()).toBe(true);
});

// A drawer's hover wash rides the wrapper, not the header <Row>, since the header loses its bottom padding when the
// drawer opens and a wash stopping there would look cut off over the evidence below.
it(`puts the hover wash on the wrapper when the body is a drawer, not on the header row`, async () => {
    const host = document.createElement(`div`);
    document.body.append(host);
    const open = ref(true);
    const app: App = createApp({
        render: () =>
            h(
                DisclosureRow,
                {
                    body: `drawer`,
                    density: `compact`,
                    open: open.value,
                    "onUpdate:open": (next: boolean) => {
                        open.value = next;
                    },
                },
                {
                    title: () => h(`span`, { class: `name` }, `A chore`),
                    below: () => h(`p`, { class: `evidence-text` }, `evidence`),
                },
            ),
    });
    app.mount(host);
    mounted.push({ app, host });

    const wrapper = host.firstElementChild as HTMLElement;
    const header = host.querySelector<HTMLElement>(`.group.block`);
    expect(wrapper?.className).toContain(`ui-row-select`);
    expect(header?.className ?? ``).not.toContain(`ui-row-select`);
});
