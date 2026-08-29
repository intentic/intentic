// @vitest-environment jsdom
//
// A LIST IS ONE SIZE, and this pins the mechanism that makes it so, on the real components, because none of it
// is visible from any other angle. `_tools/scripts/row-tiers.mjs` guards the call sites — that nobody re-answers
// the tier locally — and a passing gate says nothing about whether the answer given once actually REACHES the
// rows, the loading outline and the notes between them. A tier that resolves and is never read looks identical
// from the gate's side to one that works, which is the same argument brandMarkTiers.test.ts makes about its own
// ladder.
//
// What is pinned is therefore the four things the drift was made of:
//
//   · a row with no `density` takes its group's, which is what the extensions list never did;
//   · a <SkeletonRows> promises the height of the rows that land, which is what the personas, payouts and
//     services outlines got wrong (the payouts one under a comment saying it could not happen);
//   · a row's `#lead` is HANDED the tier's mark size, so 20 / 22 / 24 / 32 cannot come back;
//   · a <RowNote> pads from the same tier, so a group's empty line and its rows share an edge.
//
// Mounted with plain Vue rather than @vue/test-utils, as disclosureRowHits.test.ts and brandMarkTiers.test.ts do.
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

/** Renders `children` inside a <RowGroup>, at `density` when one is given. */
const mount = async (density: `comfortable` | `compact` | `dense` | undefined, children: () => unknown): Promise<HTMLElement> => {
    const host = document.createElement(`div`);
    document.body.append(host);
    const app = createApp({ render: () => h(RowGroup, density === undefined ? {} : { density }, { default: children }) });
    app.mount(host);
    mounted.push({ app, host });
    await nextTick();
    return host;
};

/* The row's own outermost element, which is where <Row> puts the tier's padding. Found by the class rather than
 * by position: <DisclosureRow> wraps its <Row> in a tint div, so `firstElementChild` is a different node for the
 * two components and a positional lookup would quietly test the wrapper on one of them. */
const padded = (host: HTMLElement, tier: `comfortable` | `compact` | `dense`): HTMLElement[] => {
    const [px] = ROW_TIERS[tier].pad.split(` `);
    return [...host.querySelectorAll<HTMLElement>(`[class*="${px}"]`)];
};

it(`gives a row with no density of its own the tier its group published`, async () => {
    const host = await mount(`compact`, () => h(Row, { title: `intentic.github` }));
    const row = host.querySelector<HTMLElement>(`.group`);
    expect(row?.className, `a bare <Row> in a compact group should not be drawing settings padding`).toContain(ROW_TIERS.compact.pad);
    expect(row?.className).not.toContain(ROW_TIERS.comfortable.pad);
});

/* THE ROW STILL WINS WHERE IT DISAGREES, and it has to: a card's masthead is a `flush :heading="2"` <Row> above
 * compact rows on the same surface, comfortable by RANK rather than by list. Dropping the escape hatch to make
 * the rule tidier would take a whole shape with it. */
it(`lets a row that states its own tier keep it, for the masthead that outranks its list`, async () => {
    const host = await mount(`compact`, () => h(Row, { title: `Move this sandbox`, density: `comfortable` }));
    expect(host.querySelector<HTMLElement>(`.group`)?.className).toContain(ROW_TIERS.comfortable.pad);
});

// Outside a group nothing has published a tier, and a bare <Row> on a card is a settings row. This is the
// behaviour every one of these components had before the group owned anything, and it must not have moved.
it(`falls back to comfortable with no group above it`, async () => {
    const host = document.createElement(`div`);
    document.body.append(host);
    const app = createApp({ render: () => h(Row, { title: `Theme` }) });
    app.mount(host);
    mounted.push({ app, host });
    await nextTick();
    expect(host.querySelector<HTMLElement>(`.group`)?.className).toContain(ROW_TIERS.comfortable.pad);
});

/* THE OUTLINE PROMISES THE HEIGHT THAT LANDS. This is the one the payouts page had a comment about and not a
 * mechanism for, so it is asserted against the row it stands in for rather than against a class name: what
 * matters is that the two agree, not what either says. */
it(`draws a loading outline at the same tier as the rows that will replace it`, async () => {
    const outline = await mount(`compact`, () => h(SkeletonRows, { rows: 2 }));
    const real = await mount(`compact`, () => [h(Row, { title: `a` }), h(Row, { title: `b` })]);
    expect(padded(outline, `compact`)).toHaveLength(2);
    expect(padded(outline, `compact`)[0]?.className).toBe(padded(real, `compact`)[0]?.className.replace(` ui-row-select`, ``));
    expect(padded(outline, `comfortable`), `an outline must not promise settings rows to a record list`).toHaveLength(0);
});

/* THE MARK'S SIZE IS HANDED TO THE SLOT, so a call site has no number to type and no number to get wrong. The
 * seven record lists that each typed one had four answers between them. */
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

/* <DisclosureRow> draws `#lead` TWICE — once visibly, once as the hidden mirror that offsets its opened block —
 * so it has to hand the same number to both. A mirror built from a second, independent lookup is exactly the
 * kind of copy that goes stale, which is the argument row.ts opens with. */
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

/* The lines on a group's surface that are not rows. Before <RowNote> these were 58 hand-written blocks in six
 * spellings, four of which matched no tier — which is what put an empty state a few pixels off the rows above
 * it on every list that had one. */
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

// The empty state keeps the room an empty surface is owed rather than a row's, so it is the one variant whose
// vertical padding is deliberately not the tier's. Its HORIZONTAL edge still has to line up.
it(`gives the empty state the group's left edge and more vertical room than a row`, async () => {
    const host = await mount(`compact`, () => h(RowNote, { variant: `empty` }, () => `Nothing installed yet.`));
    const note = host.querySelector<HTMLElement>(`[class*="px-4"]`);
    expect(note?.className).toContain(`px-4`);
    expect(note?.className).not.toContain(ROW_TIERS.compact.pad);
    expect(note?.className).toContain(`text-center`);
});
