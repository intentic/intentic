import { describe, expect, it } from "vitest";
import { type BarsFigure, type DagFigure, parseFigure, splitFigureSegments, type StatsFigure } from "@intentic/ui/markdown";

/* The figure fences generated documentation is authored with. Lives here rather than in @intentic/ui
 * because the design system ships no test runner and the markdown engine's other tests (renderMarkdown.test.ts)
 * are already in this suite. The module is pure — no DOM — so this file stays on the default `node` environment.
 *
 * The invariant under nearly every case below: a figure that cannot be understood must DEGRADE to a code block,
 * never throw and never vanish. A reader who sees the JSON source can still act on it; a reader who sees a blank
 * space cannot, and an author cannot tell that anything is wrong. */

const dag = (body: unknown): DagFigure | undefined => parseFigure(`dag`, JSON.stringify(body)) as DagFigure | undefined;
const bars = (body: unknown): BarsFigure | undefined => parseFigure(`bars`, JSON.stringify(body)) as BarsFigure | undefined;
const stats = (body: unknown): StatsFigure | undefined => parseFigure(`stats`, JSON.stringify(body)) as StatsFigure | undefined;

describe(`parseFigure`, () => {
    it(`reads a dag with nodes and edges`, () => {
        const figure = dag({
            title: `The request path`,
            nodes: [
                { id: `web`, label: `Browser app`, note: `Vue`, accent: `1` },
                { id: `api`, label: `Daemon` },
            ],
            edges: [{ from: `web`, to: `api`, dashed: true }],
        });
        expect(figure).toEqual({
            kind: `dag`,
            title: `The request path`,
            direction: `LR`,
            nodes: [
                { id: `web`, label: `Browser app`, note: `Vue`, accent: `1` },
                { id: `api`, label: `Daemon`, note: undefined, accent: undefined },
            ],
            edges: [{ from: `web`, to: `api`, dashed: true }],
        });
    });

    it(`defaults direction to LR and only accepts TB as the alternative`, () => {
        expect(dag({ nodes: [{ id: `a` }] })?.direction).toBe(`LR`);
        expect(dag({ nodes: [{ id: `a` }], direction: `TB` })?.direction).toBe(`TB`);
        // Anything else is not a third layout — it is a typo, and LR is the honest fallback.
        expect(dag({ nodes: [{ id: `a` }], direction: `sideways` })?.direction).toBe(`LR`);
    });

    it(`labels an unlabelled node by its id rather than dropping it`, () => {
        // Dropping it would silently break every edge pointing at it, turning one missing label into a
        // structurally wrong diagram.
        expect(dag({ nodes: [{ id: `graph` }] })?.nodes[0]).toMatchObject({ id: `graph`, label: `graph` });
    });

    it(`drops an edge that names a node the figure does not declare`, () => {
        const figure = dag({
            nodes: [{ id: `a` }, { id: `b` }],
            edges: [
                { from: `a`, to: `b` },
                { from: `a`, to: `ghost` },
                { from: `nope`, to: `b` },
            ],
        });
        expect(figure?.edges).toEqual([{ from: `a`, to: `b`, dashed: false }]);
    });

    it(`rejects a dag with no usable nodes`, () => {
        expect(dag({ nodes: [] })).toBeUndefined();
        expect(dag({ nodes: [{ label: `no id` }] })).toBeUndefined();
        expect(dag({ edges: [{ from: `a`, to: `b` }] })).toBeUndefined();
    });

    it(`ignores an unknown accent instead of rejecting the node`, () => {
        // The palette has five slots and a fold-to bucket; a sixth hue is exactly what it must not invent.
        expect(dag({ nodes: [{ id: `a`, accent: `7` }] })?.nodes[0]?.accent).toBeUndefined();
        expect(dag({ nodes: [{ id: `a`, accent: `neutral` }] })?.nodes[0]?.accent).toBe(`neutral`);
    });

    it(`reads bars and keeps the authored tip label`, () => {
        expect(bars({ title: `Lines of code`, items: [{ label: `graph`, value: 1840, display: `1.8k` }] })).toEqual({
            kind: `bars`,
            title: `Lines of code`,
            items: [{ label: `graph`, value: 1840, display: `1.8k`, accent: undefined }],
        });
    });

    it(`drops a bar with no magnitude and a negative one`, () => {
        // A negative value is not clamped to zero: a zero-length bar claims a measurement that was not made.
        expect(
            bars({
                items: [
                    { label: `a`, value: -5 },
                    { label: `b`, value: 3 },
                ],
            })?.items,
        ).toEqual([{ label: `b`, value: 3, display: undefined, accent: undefined }]);
        expect(bars({ items: [{ label: `a` }] })).toBeUndefined();
        expect(bars({ items: [{ label: `a`, value: Number.NaN }] })).toBeUndefined();
    });

    it(`keeps a zero-valued bar, which is a real measurement`, () => {
        expect(bars({ items: [{ label: `untested`, value: 0 }] })?.items).toHaveLength(1);
    });

    it(`reads stats as authored text`, () => {
        expect(stats({ items: [{ label: `Packages`, value: `42`, note: `18 with tests` }] })).toEqual({
            kind: `stats`,
            items: [{ label: `Packages`, value: `42`, note: `18 with tests` }],
        });
    });

    it(`rejects a stat whose value is a number rather than authored text`, () => {
        // The renderer sets the type, never the content — so the author writes the string they mean.
        expect(stats({ items: [{ label: `Packages`, value: 42 }] })).toBeUndefined();
    });

    it(`trims whitespace and treats blank strings as absent`, () => {
        expect(dag({ nodes: [{ id: `  a  `, label: `  Box  `, note: `   ` }] })?.nodes[0]).toEqual({
            id: `a`,
            label: `Box`,
            note: undefined,
            accent: undefined,
        });
    });

    it(`returns undefined for a non-figure language, malformed JSON and non-objects`, () => {
        expect(parseFigure(`ts`, `{ "nodes": [] }`)).toBeUndefined();
        expect(parseFigure(`dag`, `{ nodes: `)).toBeUndefined();
        expect(parseFigure(`dag`, `[]`)).toBeUndefined();
        expect(parseFigure(`dag`, `"a string"`)).toBeUndefined();
        expect(parseFigure(`dag`, ``)).toBeUndefined();
    });

    /* Mermaid is the one kind this module does not read: its body is a diagram language, and only mermaid's own
     * parser (a lazy import, so nowhere near here) can say whether it is valid. So the body is carried whole and
     * the ONLY thing rejected is emptiness. Syntax that is obvious nonsense still becomes a figure here, and
     * degrades to a code block at render time instead — same contract, later. */
    it(`carries a mermaid body through verbatim and rejects only an empty one`, () => {
        const diagram = `flowchart LR\n    a["One"] --> b["Two"]`;
        expect(parseFigure(`mermaid`, diagram)).toEqual({ kind: `mermaid`, code: diagram });
        expect(parseFigure(`mermaid`, `not a diagram at all`)).toEqual({ kind: `mermaid`, code: `not a diagram at all` });
        expect(parseFigure(`mermaid`, `   \n  `)).toBeUndefined();
        expect(parseFigure(`mermaid`, ``)).toBeUndefined();
    });
});

describe(`splitFigureSegments`, () => {
    const figureCount = (source: string): number => splitFigureSegments(source).filter((segment) => segment.kind === `figure`).length;

    it(`returns one prose segment for a document with no figures`, () => {
        const segments = splitFigureSegments(`# Title\n\nSome prose.`);
        expect(segments).toEqual([{ kind: `prose`, text: `# Title\n\nSome prose.` }]);
    });

    it(`splits prose around a figure, in reading order`, () => {
        const source = [`Before.`, ``, `\`\`\`dag`, `{ "nodes": [{ "id": "a" }] }`, `\`\`\``, ``, `After.`].join(`\n`);
        const segments = splitFigureSegments(source);
        expect(segments.map((segment) => segment.kind)).toEqual([`prose`, `figure`, `prose`]);
        expect(segments[0]).toMatchObject({ text: `Before.\n` });
        expect(segments[2]).toMatchObject({ text: `\nAfter.` });
    });

    it(`leaves a malformed figure fence in the prose so it renders as a code block`, () => {
        const source = `Before.\n\n\`\`\`dag\n{ not json\n\`\`\`\n\nAfter.`;
        expect(figureCount(source)).toBe(0);
        const segments = splitFigureSegments(source);
        expect(segments).toHaveLength(1);
        expect(segments[0]).toMatchObject({ kind: `prose`, text: source });
    });

    it(`leaves ordinary code fences alone, including ones that mention a figure language`, () => {
        const source = `\`\`\`ts\nconst dag = { nodes: [] };\n\`\`\``;
        expect(figureCount(source)).toBe(0);
        expect(splitFigureSegments(source)[0]).toMatchObject({ text: source });
    });

    it(`ignores an indented fence, which belongs to the list item containing it`, () => {
        // Cutting the document there would split the list in half, so an indented figure stays a code block.
        const source = `- item\n\n    \`\`\`dag\n    { "nodes": [{ "id": "a" }] }\n    \`\`\``;
        expect(figureCount(source)).toBe(0);
    });

    it(`handles a document that is nothing but a figure`, () => {
        const segments = splitFigureSegments(`\`\`\`stats\n{ "items": [{ "label": "Packages", "value": "42" }] }\n\`\`\``);
        expect(segments).toHaveLength(1);
        expect(segments[0]?.kind).toBe(`figure`);
    });

    it(`reads consecutive figures as separate segments`, () => {
        const one = `\`\`\`dag\n{ "nodes": [{ "id": "a" }] }\n\`\`\``;
        const two = `\`\`\`bars\n{ "items": [{ "label": "a", "value": 1 }] }\n\`\`\``;
        expect(figureCount(`${one}\n${two}`)).toBe(2);
    });

    it(`splits a mermaid fence out of the prose around it`, () => {
        const source = [`Read it as:`, ``, `\`\`\`mermaid`, `flowchart LR`, `    a --> b`, `\`\`\``, ``, `After.`].join(`\n`);
        const segments = splitFigureSegments(source);
        expect(segments.map((segment) => segment.kind)).toEqual([`prose`, `figure`, `prose`]);
        expect(segments[1]).toMatchObject({ figure: { kind: `mermaid`, code: `flowchart LR\n    a --> b` } });
    });

    it(`leaves an unclosed mermaid fence as prose, so a half-written diagram never draws`, () => {
        const source = `\`\`\`mermaid\nflowchart LR\n    a --> b`;
        expect(figureCount(source)).toBe(0);
    });

    it(`accepts tilde fences and an uppercased language`, () => {
        expect(figureCount(`~~~dag\n{ "nodes": [{ "id": "a" }] }\n~~~`)).toBe(1);
        expect(figureCount(`\`\`\`DAG\n{ "nodes": [{ "id": "a" }] }\n\`\`\``)).toBe(1);
    });

    it(`does not lose text when a fence is never closed`, () => {
        const source = `Before.\n\n\`\`\`dag\n{ "nodes": [{ "id": "a" }] }`;
        const segments = splitFigureSegments(source);
        // The fence is unterminated, so its content is still being written — it stays prose, whole.
        expect(segments.map((segment) => segment.kind)).toEqual([`prose`]);
        expect(segments[0]).toMatchObject({ text: source });
    });

    it(`never throws and always returns at least one segment, whatever it is handed`, () => {
        for (const input of [``, `   `, undefined, null, 123, { not: `a string` }] as unknown[]) {
            const segments = splitFigureSegments(input as string);
            expect(segments.length).toBeGreaterThanOrEqual(1);
        }
    });
});
