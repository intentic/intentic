import { describe, it, expect } from "bun:test";
import { type DocxNode, MARK_CLASS, redline, textOfBody } from "./docxRedline";

// The redline over hand-built pieces of docx-preview's model: what a paragraph keeps, what gets struck or underlined,
// and that a run split at a word keeps its formatting on both halves.

const text = (value: string): DocxNode => ({ type: `text`, text: value });
const run = (value: string, props: Record<string, unknown> = {}): DocxNode => ({ type: `run`, children: [text(value)], ...props });
const p = (children: readonly DocxNode[], props: Record<string, unknown> = {}): DocxNode => ({ type: `paragraph`, children, ...props });
const cell = (...blocks: DocxNode[]): DocxNode => ({ type: `cell`, children: blocks });
const row = (...cells: DocxNode[]): DocxNode => ({ type: `row`, children: cells });
const table = (...rows: DocxNode[]): DocxNode => ({ type: `table`, children: rows });

const OPTIONS = { removedPicture: `[picture]` };

// Every text under a node, wrappers and all, in order.
const flat = (node: DocxNode): string => (node.text ?? ``) + (node.children ?? []).map(flat).join(``);
const kinds = (node: DocxNode): string[] => (node.children ?? []).map((child) => child.type);

describe(`redline`, () => {
    it(`keeps an unchanged paragraph as the very object the new document had, and marks nothing`, () => {
        const same = p([run(`Przetarg nieograniczony`)]);
        const result = redline([p([run(`Przetarg nieograniczony`)])], [same], OPTIONS);
        expect(result.children[0]).toBe(same);
        expect(result.events).toEqual([]);
        expect(result.whole).toBe(false);
    });

    it(`strikes the word that left and underlines the one that arrived, inside the paragraph, keeping the run's look`, () => {
        const before = [p([run(`na `, { cssStyle: { bold: true } }), run(`dostawy`, { cssStyle: { bold: true } })])];
        const after = [p([run(`na dostawyasd`, { cssStyle: { bold: true } })], { styleName: `Title` })];
        const { children, events } = redline(before, after, OPTIONS);
        const paragraph = children[0]!;
        expect(kinds(paragraph)).toEqual([`run`, `deleted`, `inserted`]);
        expect(flat(paragraph.children![0]!)).toBe(`na `);
        expect(flat(paragraph.children![1]!)).toBe(`dostawy`);
        expect(flat(paragraph.children![2]!)).toBe(`dostawyasd`);
        // The split halves wear the run's own properties, and the paragraph its own style plus the marks.
        expect(paragraph.children![2]!.children![0]).toMatchObject({ type: `run`, cssStyle: { bold: true } });
        expect(paragraph.styleName).toBe(`Title`);
        expect(paragraph.className).toBe(`${MARK_CLASS} ${MARK_CLASS}-changed ${MARK_CLASS}-e1`);
        expect(events).toEqual([{ id: 1, kind: `changed` }]);
        // The originals were not touched.
        expect(after[0]!.children).toHaveLength(1);
    });

    it(`puts a removed paragraph back where it stood, struck through, with its section break gone`, () => {
        const kept = p([run(`Closed Monday.`)]);
        const before = [p([run(`Hello.`)]), p([run(`Gone.`)], { sectionProps: { page: `A4` } }), p([run(`Closed Monday.`)])];
        const after = [p([run(`Hello.`)]), kept];
        const { children, events } = redline(before, after, OPTIONS);
        expect(children.map(flat)).toEqual([`Hello.`, `Gone.`, `Closed Monday.`]);
        expect(kinds(children[1]!)).toEqual([`deleted`]);
        expect(children[1]!.sectionProps).toBeUndefined();
        expect(children[1]!.className).toContain(`${MARK_CLASS}-removed`);
        expect(children[2]).toBe(kept);
        expect(events).toEqual([{ id: 1, kind: `removed` }]);
    });

    it(`reads a paragraph replaced by an unrelated one as removed then added, not as one paragraph worded`, () => {
        const before = [p([run(`Kept.`)]), p([run(`Refunds are manual until the API supports them.`)])];
        const after = [p([run(`Kept.`)]), p([run(`The signup spec covers the happy path only.`)])];
        const { children, events } = redline(before, after, OPTIONS);
        expect(events.map((event) => event.kind)).toEqual([`removed`, `added`]);
        expect(children.map(flat)).toEqual([`Kept.`, `Refunds are manual until the API supports them.`, `The signup spec covers the happy path only.`]);
    });

    it(`underlines an added paragraph whole, and leaves its page break at paragraph level where the renderer looks`, () => {
        const pageBreak: DocxNode = { type: `run`, children: [{ type: `break`, break: `page` }] };
        const added = p([run(`New clause.`), pageBreak]);
        const { children, events } = redline([], [added], OPTIONS);
        expect(kinds(children[0]!)).toEqual([`inserted`, `run`]);
        expect(flat(children[0]!)).toBe(`New clause.`);
        expect(children[0]!.children![1]).toEqual(pageBreak);
        expect(events).toEqual([{ id: 1, kind: `added` }]);
    });

    it(`keeps a hyperlink around the runs it held, even when a word inside it changed`, () => {
        const link = (value: string): DocxNode => ({ type: `hyperlink`, id: `rId7`, children: [run(value)] });
        const { children } = redline([p([run(`See `), link(`the old site`)])], [p([run(`See `), link(`the new site`)])], OPTIONS);
        const paragraph = children[0]!;
        expect(kinds(paragraph)).toEqual([`run`, `hyperlink`, `deleted`, `inserted`, `hyperlink`]);
        expect(paragraph.children![1]).toMatchObject({ type: `hyperlink`, id: `rId7` });
        expect(flat(paragraph.children![1]!)).toBe(`the `);
        expect(kinds(paragraph.children![2]!)).toEqual([`hyperlink`]);
        expect(flat(paragraph.children![2]!)).toBe(`old`);
        expect(flat(paragraph.children![3]!)).toBe(`new`);
        expect(flat(paragraph.children![4]!)).toBe(` site`);
    });

    it(`stands a removed picture in as text, since its bytes are in the old package only`, () => {
        const picture: DocxNode = { type: `run`, children: [{ type: `drawing`, children: [] }] };
        const { children } = redline([p([run(`Logo: `), picture])], [p([run(`Logo: `)])], OPTIONS);
        const paragraph = children[0]!;
        expect(kinds(paragraph)).toEqual([`run`, `deleted`]);
        expect(flat(paragraph.children![1]!)).toBe(`[picture]`);
    });

    it(`keeps a mark with no text (a bookmark) in the paragraph it was in`, () => {
        const bookmark: DocxNode = { type: `bookmarkStart`, id: `3` };
        const { children } = redline([p([run(`One two`)])], [p([bookmark, run(`One three`)])], OPTIONS);
        expect(kinds(children[0]!)).toEqual([`bookmarkStart`, `run`, `deleted`, `inserted`]);
    });

    it(`reads a document saved with tracked changes at its accepted state before comparing`, () => {
        const before = [p([run(`We `), { type: `inserted`, children: [run(`now `)] }, run(`open`), { type: `deleted`, children: [run(` late`)] }])];
        const after = [p([run(`We now open`)])];
        const { events } = redline(before, after, OPTIONS);
        expect(events).toEqual([]);
        expect(textOfBody(before)).toBe(`We now open`);
    });

    it(`compares a table by rows, marks an added row as one event, and words a changed cell`, () => {
        const before = [table(row(cell(p([run(`item`)])), cell(p([run(`price`)]))), row(cell(p([run(`widget`)])), cell(p([run(`4`)]))))];
        const after = [
            table(
                row(cell(p([run(`item`)])), cell(p([run(`price`)]))),
                row(cell(p([run(`widget`)])), cell(p([run(`5`)]))),
                row(cell(p([run(`gadget`)])), cell(p([run(`7`)]))),
            ),
        ];
        const { children, events } = redline(before, after, OPTIONS);
        const rows = children[0]!.children!;
        expect(rows).toHaveLength(3);
        expect(rows[0]).toBe(after[0]!.children![0]);
        const priceCell = rows[1]!.children![1]!.children![0]!;
        expect(kinds(priceCell)).toEqual([`deleted`, `inserted`]);
        expect(flat(priceCell)).toBe(`45`);
        const addedRow = rows[2]!;
        for (const added of addedRow.children!) {
            expect(added.children![0]!.className).toContain(`${MARK_CLASS}-e2`);
            expect(kinds(added.children![0]!)).toEqual([`inserted`]);
        }
        expect(events).toEqual([
            { id: 1, kind: `changed` },
            { id: 2, kind: `added` },
        ]);
    });

    it(`treats a tab and a line break as text, so a changed tab stop reads as a change`, () => {
        const withTab = p([{ type: `run`, children: [text(`a`), { type: `tab` }, text(`b`)] }]);
        expect(textOfBody([withTab])).toBe(`a\tb`);
        expect(redline([withTab], [p([run(`a b`)])], OPTIONS).events).toHaveLength(1);
    });
});
