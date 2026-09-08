// @vitest-environment jsdom
// A list is one size, pinned on the real components since none of it is visible any other way:
// `_tools/checks/row-tiers.mjs` guards that nobody re-answers the tier locally, but a passing gate says nothing about
// whether the answer reaches the rows, the loading outline, and the notes between them.
//
// Pins four things: a group with no `density` is compact, and its rows take that; a row with no `density` takes its
// group's; a <SkeletonRows> promises the height of the rows that land; a row's `#lead` is handed the tier's mark size;
// a <RowNote> pads from the same tier.
import { DisclosureRow, ROW_TIERS, Row, RowGroup, RowNote, SkeletonRows } from "@intentic/ui";
import { afterEach, expect, it } from "vitest";
import { type App, createApp, h, nextTick } from "vue";

const mounted: { app: App; host: HTMLElement }[] = [];

afterEach(() => {
    for (const { app, host } of mounted.splice(0)) {
        app.unmount();
        host.remove();
    }
});

/** Renders `children` inside a <RowGroup>. Pass no density for the standard case: a group is compact. */
const mount = async (density: `comfortable` | `compact` | `dense` | undefined, children: () => unknown): Promise<HTMLElement> => {
    const host = document.createElement(`div`);
    document.body.append(host);
    const app = createApp({ render: () => h(RowGroup, density === undefined ? {} : { density }, { default: children }) });
    app.mount(host);
    mounted.push({ app, host });
    await nextTick();
    return host;
};

// The row's own outermost element, where <Row> puts the tier's padding. Found by class rather than position, since
// <DisclosureRow> wraps its <Row> in a tint div and a positional lookup would test the wrong node on one of them.
const padded = (host: HTMLElement, tier: `comfortable` | `compact` | `dense`): HTMLElement[] => {
    const [px] = ROW_TIERS[tier].pad.split(` `);
    return [...host.querySelectorAll<HTMLElement>(`[class*="${px}"]`)];
};

// The standard, as one assertion: a <RowGroup> is a list and a list is compact, so a group and a row that both say
// nothing land on the compact tier together. Asserted with no density anywhere.
it(`draws a group that states nothing, and the rows in it, at the compact tier`, async () => {
    const host = await mount(undefined, () => h(Row, { title: `Quick model`, description: `Fast models for background tasks.` }));
    const row = host.querySelector<HTMLElement>(`.group`);
    expect(row?.className, `a group is a list, and a list is compact`).toContain(ROW_TIERS.compact.pad);
    expect(row?.className).not.toContain(ROW_TIERS.comfortable.pad);
});

// Outside a group it is still `comfortable`, which is the card masthead's own tier: a `flush :heading="2"` <Row> is not
// in a list, outranks the rows under it, and wants a glyph sized for an h2.
it(`leaves a row outside any group on comfortable, which is the masthead's tier`, async () => {
    const host = document.createElement(`div`);
    document.body.append(host);
    const app = createApp({ render: () => h(Row, { title: `Environment`, icon: `box`, heading: 2 }) });
    app.mount(host);
    mounted.push({ app, host });
    await nextTick();
    expect(host.querySelector<HTMLElement>(`.group`)?.className).toContain(ROW_TIERS.comfortable.pad);
});

it(`gives a row with no density of its own the tier its group published`, async () => {
    const host = await mount(`compact`, () => h(Row, { title: `intentic.github` }));
    const row = host.querySelector<HTMLElement>(`.group`);
    expect(row?.className, `a bare <Row> in a compact group should not be drawing settings padding`).toContain(ROW_TIERS.compact.pad);
    expect(row?.className).not.toContain(ROW_TIERS.comfortable.pad);
});

// The row still wins where it disagrees, since a card's masthead is a `flush :heading="2"` <Row> above compact rows on
// the same surface, comfortable by rank rather than by list.
it(`lets a row that states its own tier keep it, for the masthead that outranks its list`, async () => {
    const host = await mount(`compact`, () => h(Row, { title: `Move this sandbox`, density: `comfortable` }));
    expect(host.querySelector<HTMLElement>(`.group`)?.className).toContain(ROW_TIERS.comfortable.pad);
});

// The outline promises the height that lands: asserted against the row it stands in for rather than a class name, since
// what matters is that the two agree.
it(`draws a loading outline at the same tier as the rows that will replace it`, async () => {
    const outline = await mount(`compact`, () => h(SkeletonRows, { rows: 2 }));
    const real = await mount(`compact`, () => [h(Row, { title: `a` }), h(Row, { title: `b` })]);
    expect(padded(outline, `compact`)).toHaveLength(2);
    expect(padded(outline, `compact`)[0]?.className).toBe(padded(real, `compact`)[0]?.className.replace(` ui-row-select`, ``));
    expect(padded(outline, `comfortable`), `an outline must not promise settings rows to a record list`).toHaveLength(0);
});

// The mark's size is handed to the slot, so a call site has no number to type and no number to get wrong.
it(`hands a row's #lead the tier's mark size`, async () => {
    const seen: number[] = [];
    const record = ({ mark }: { mark: number }): unknown => {
        seen.push(mark);
        return h(`span`, { class: `mark` }, `•`);
    };
    await mount(`compact`, () => h(Row, { title: `GITHUB_TOKEN` }, { lead: record }));
    await mount(`comfortable`, () => h(Row, { title: `Membership` }, { lead: record }));
    expect(seen).toEqual([ROW_TIERS.compact.mark, ROW_TIERS.comfortable.mark]);
});

// <DisclosureRow> draws `#lead` twice, once visibly and once as the hidden mirror that offsets its opened block, so
// both must get the same number.
it(`hands the same mark size to a disclosure row's lead and to its hidden mirror`, async () => {
    const seen: number[] = [];
    const record = ({ mark }: { mark: number }): unknown => {
        seen.push(mark);
        return h(`span`, { class: `mark` }, `•`);
    };
    await mount(`compact`, () => h(DisclosureRow, { open: true, title: `intentic.discord` }, { lead: record, below: () => `evidence` }));
    expect(seen.length, `an open disclosure row draws its lead twice`).toBeGreaterThan(1);
    expect(new Set(seen)).toEqual(new Set([ROW_TIERS.compact.mark]));
});

// The lines on a group's surface that are not rows. Before <RowNote> these were hand-written in several spellings,
// several of which matched no tier.
it(`pads a note and an action from the group's tier, so they share the rows' edge`, async () => {
    const host = await mount(`compact`, () => [
        h(Row, { title: `GITHUB_TOKEN` }),
        h(RowNote, null, () => `Nothing generated yet.`),
        h(RowNote, { variant: `action`, label: `Add a secret` }),
    ]);
    // The row, the note and the action: three elements, one padding.
    expect(padded(host, `compact`).length).toBeGreaterThanOrEqual(3);
    expect(host.querySelector(`button`)?.className, `the "add one" line is pressable and on the tier`).toContain(ROW_TIERS.compact.pad);
});

// The empty state keeps the room an empty surface is owed rather than a row's, so its vertical padding is deliberately
// not the tier's; its horizontal edge still has to line up.
it(`gives the empty state the group's left edge and more vertical room than a row`, async () => {
    const host = await mount(`compact`, () => h(RowNote, { variant: `empty` }, () => `Nothing installed yet.`));
    const note = host.querySelector<HTMLElement>(`[class*="px-4"]`);
    expect(note?.className).toContain(`px-4`);
    expect(note?.className).not.toContain(ROW_TIERS.compact.pad);
    expect(note?.className).toContain(`text-center`);
});
