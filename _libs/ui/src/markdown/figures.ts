/* FIGURES IN PROSE — typed fenced blocks the markdown surface renders as real components.
 *
 * A generated document explains a codebase, and the explanation is half prose and half picture: "here is the
 * request path" wants its diagram at that sentence, not in a sidecar JSON array the reader has to reassemble.
 * So a figure is authored INLINE, as a fenced block whose language names a figure kind:
 *
 *     ```dag
 *     { "nodes": [{ "id": "web", "label": "Browser app" }], "edges": [] }
 *     ```
 *
 * WHY A FENCE AND NOT A SCHEMA FIELD. The alternative is a `flows: [{ steps: [...] }]` field on a sidecar
 * document model, which forces every explanation into one predeclared shape and throws away the reading order
 * the author already had. A fence keeps the document the unit of authorship and lets each figure be the kind
 * that fits — while still being DATA, so the app owns layout, theming and dark mode. That is the whole trade:
 * the model says what the nodes mean, dagre says where they go.
 *
 * WHY IT DEGRADES INSTEAD OF FAILING. A fence whose body does not parse is left exactly where it is, so it
 * renders as an ordinary code block: the reader sees the source instead of a blank space, and a malformed
 * figure costs one figure rather than the page. That is the property a JSON document model cannot have.
 *
 * This module is pure TypeScript with no Vue and no DOM — it ships on the `@intentic-app/ui/markdown` subpath
 * and is unit-tested without mounting anything. MarkdownFigure.vue owns the component switch. */

// The five categorical slots the design system's chart palette exposes (semantic-colors.css), plus its
// fold-to bucket. An author assigns a slot to an ENTITY and keeps it there; slots are never handed out by
// rank, which is why this is an authored field and not a position in the array. Past five groups, fold to
// `neutral` rather than inventing a sixth hue — the same contract the palette itself documents.
export const FIGURE_ACCENTS = [`1`, `2`, `3`, `4`, `5`, `neutral`] as const;
export type FigureAccent = (typeof FIGURE_ACCENTS)[number];

export interface DagFigureNode {
    readonly id: string;
    readonly label: string;
    // One short line under the label — what this box IS, not a second sentence about it.
    readonly note?: string;
    readonly accent?: FigureAccent;
}

/* An arrow between two declared nodes. There is deliberately NO edge label: the renderer (DagGraph) draws
 * paths, not text on paths, and a schema field the renderer silently ignores is a declaration with no effect —
 * the author would write it, see nothing, and have no way to find out why. `dashed` is here instead because it
 * is a distinction DagGraph really can draw, and it covers the one an explanation usually needs: a weaker or
 * optional relationship beside a load-bearing one. */
export interface DagFigureEdge {
    readonly from: string;
    readonly to: string;
    readonly dashed?: boolean;
}

// A component/dependency/flow graph. `direction` defaults to LR: dependency and request-path graphs read
// left-to-right, and a TB graph of the same node count is taller than a prose column wants to be.
export interface DagFigure {
    readonly kind: "dag";
    readonly title?: string;
    readonly direction: "LR" | "TB";
    readonly nodes: readonly DagFigureNode[];
    readonly edges: readonly DagFigureEdge[];
}

export interface BarsFigureItem {
    readonly label: string;
    readonly value: number;
    // The tip label, when the raw number is not what a reader wants to see ("18.2k lines", "3 days").
    // Absent ⇒ the renderer prints the value, thousands-separated.
    readonly display?: string;
    readonly accent?: FigureAccent;
}

// Magnitude across a handful of named things — package sizes, churn, test counts. One measure only: two
// measures of different scale are two figures, never one chart with two axes.
export interface BarsFigure {
    readonly kind: "bars";
    readonly title?: string;
    readonly items: readonly BarsFigureItem[];
}

export interface StatsFigureItem {
    readonly label: string;
    /* Authored as TEXT, not a number: a stat's value is as often "18.2k" or "3 of 42" as it is an integer,
     * and formatting it here would mean guessing units and locale for a string the author already knows how
     * to write. The renderer sets the type, never the content. */
    readonly value: string;
    readonly note?: string;
}

// The orientation strip at the top of a page — counts a reader wants before any prose. Not a chart: per the
// form heuristic, a handful of standalone numbers is a stat row, and drawing them as a bar chart of unrelated
// measures would be the dual-axis mistake in another costume.
export interface StatsFigure {
    readonly kind: "stats";
    readonly items: readonly StatsFigureItem[];
}

export type Figure = DagFigure | BarsFigure | StatsFigure;

// The fence languages that mean "figure". Everything else stays a code block.
export const FIGURE_LANGS: readonly string[] = [`dag`, `bars`, `stats`];

// ---- narrow, total validation ------------------------------------------------------------------------------

/* Hand-rolled rather than zod: this package is the design system, and a figure's shape is small enough that a
 * schema dependency would cost the whole app a package to validate three record types. Every reader below is
 * total — it answers `undefined` for anything unexpected and never throws — because the caller's contract is
 * "unparseable figures render as code blocks", and an exception would take the page with it. */

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === `object` && value !== null && !Array.isArray(value);

// A non-empty trimmed string, or undefined. Empty labels are rejected rather than rendered: an empty box in a
// diagram is worse than the fence's source.
const text = (value: unknown): string | undefined => {
    if (typeof value !== `string`) {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed === `` ? undefined : trimmed;
};

const finite = (value: unknown): number | undefined => (typeof value === `number` && Number.isFinite(value) ? value : undefined);

const accent = (value: unknown): FigureAccent | undefined =>
    typeof value === `string` && (FIGURE_ACCENTS as readonly string[]).includes(value) ? (value as FigureAccent) : undefined;

const dagNode = (value: unknown): DagFigureNode | undefined => {
    if (!isRecord(value)) {
        return undefined;
    }
    const id = text(value[`id`]);
    if (id === undefined) {
        return undefined;
    }
    // A node with no label is labelled by its id — the id is authored and readable, and dropping the node
    // would silently break the edges that point at it.
    return { id, label: text(value[`label`]) ?? id, note: text(value[`note`]), accent: accent(value[`accent`]) };
};

const dagEdge = (value: unknown, ids: ReadonlySet<string>): DagFigureEdge | undefined => {
    if (!isRecord(value)) {
        return undefined;
    }
    const from = text(value[`from`]);
    const to = text(value[`to`]);
    /* An edge to a node that isn't there is DROPPED, not fatal. dagre would otherwise lay out a phantom node
     * with no label — a blank box the reader cannot interpret and the author cannot see the cause of. Dropping
     * loses one arrow from an otherwise correct diagram, which is the smaller loss. */
    if (from === undefined || to === undefined || !ids.has(from) || !ids.has(to)) {
        return undefined;
    }
    return { from, to, dashed: value[`dashed`] === true };
};

const dagFigure = (body: Record<string, unknown>): DagFigure | undefined => {
    const rawNodes = body[`nodes`];
    if (!Array.isArray(rawNodes)) {
        return undefined;
    }
    const nodes = rawNodes.flatMap((node) => {
        const parsed = dagNode(node);
        return parsed === undefined ? [] : [parsed];
    });
    if (nodes.length === 0) {
        return undefined;
    }
    const ids = new Set(nodes.map((node) => node.id));
    const rawEdges = body[`edges`];
    const edges = (Array.isArray(rawEdges) ? rawEdges : []).flatMap((edge) => {
        const parsed = dagEdge(edge, ids);
        return parsed === undefined ? [] : [parsed];
    });
    return {
        kind: `dag`,
        direction: body[`direction`] === `TB` ? `TB` : `LR`,
        nodes,
        edges,
        title: text(body[`title`]),
    };
};

const barsFigure = (body: Record<string, unknown>): BarsFigure | undefined => {
    const rawItems = body[`items`];
    if (!Array.isArray(rawItems)) {
        return undefined;
    }
    const items = rawItems.flatMap((item): BarsFigureItem[] => {
        if (!isRecord(item)) {
            return [];
        }
        const label = text(item[`label`]);
        const value = finite(item[`value`]);
        // A negative bar has no meaning in a magnitude comparison drawn from a single baseline, so it is not
        // clamped to zero (which would show a bar that isn't there) — the item is dropped.
        if (label === undefined || value === undefined || value < 0) {
            return [];
        }
        return [{ label, value, display: text(item[`display`]), accent: accent(item[`accent`]) }];
    });
    return items.length === 0 ? undefined : { kind: `bars`, items, title: text(body[`title`]) };
};

const statsFigure = (body: Record<string, unknown>): StatsFigure | undefined => {
    const rawItems = body[`items`];
    if (!Array.isArray(rawItems)) {
        return undefined;
    }
    const items = rawItems.flatMap((item): StatsFigureItem[] => {
        if (!isRecord(item)) {
            return [];
        }
        const label = text(item[`label`]);
        const value = text(item[`value`]);
        if (label === undefined || value === undefined) {
            return [];
        }
        return [{ label, value, note: text(item[`note`]) }];
    });
    return items.length === 0 ? undefined : { kind: `stats`, items };
};

/* One fence → a figure, or undefined for "leave it as a code block". `lang` is the fence's info string as
 * marked reports it (already lowercased by the caller); `code` is the raw body. */
export const parseFigure = (lang: string, code: string): Figure | undefined => {
    if (!FIGURE_LANGS.includes(lang)) {
        return undefined;
    }
    let body: unknown;
    try {
        body = JSON.parse(code);
    } catch {
        return undefined;
    }
    if (!isRecord(body)) {
        return undefined;
    }
    if (lang === `dag`) {
        return dagFigure(body);
    }
    if (lang === `bars`) {
        return barsFigure(body);
    }
    return statsFigure(body);
};

// ---- splitting a document into prose and figures -----------------------------------------------------------

export type MarkdownSegment = { readonly kind: "prose"; readonly text: string } | { readonly kind: "figure"; readonly figure: Figure };

/* CommonMark fence rules, as much of them as this needs: a fence opens with three or more backticks or tildes
 * and closes with at least as many of the SAME character and nothing else on the line. */
const FENCE_OPEN = /^(`{3,}|~{3,})([^\s`]*)\s*$/;

// Only column 0. A fence indented under a list item belongs to that item's content, and cutting the document
// there would split the list in half — so an indented figure fence renders as a code block instead. Authors
// put figures at the top level, which is where a figure belongs anyway.
const closes = (line: string, marker: string): boolean => {
    const match = /^(`{3,}|~{3,})\s*$/.exec(line);
    return match !== null && match[1] !== undefined && match[1][0] === marker[0] && match[1].length >= marker.length;
};

/* Split a document at its top-level figure fences.
 *
 * WHY SPLIT BEFORE PARSING rather than substituting placeholders into rendered HTML: a figure is a Vue
 * component, and the engine's output is an HTML string bound with v-html — there is nowhere in a string to put
 * a component. The alternative is mounting into `[data-md-figure]` elements after render, which means DOM
 * surgery that has to be redone every time the source changes. Splitting keeps the whole thing declarative:
 * each prose run is rendered by the one markdown engine exactly as before, and the figures sit between them.
 *
 * The cost is that markdown constructs do not span a figure: a reference-style link defined in one prose run
 * is not visible to the next. Figures sit at block level between paragraphs, where nothing legitimately spans
 * them, and authored documents use inline links — so this has no effect in practice. It is the reason
 * splitting is done on FENCE BOUNDARIES ONLY, never on blank lines. */
export const splitFigureSegments = (source: string): readonly MarkdownSegment[] => {
    const whole = typeof source === `string` ? source : String(source ?? ``);
    /* The overwhelmingly common case — prose with no fences at all — costs two indexOf scans and allocates one
     * segment, so every existing markdown surface pays effectively nothing for this feature.
     *
     * The test is for a FENCE, not for a figure language: `includes("dag")` would have to be case-insensitive
     * (```DAG is a valid fence) and would still fire on every document that happens to use the word. A fence
     * marker is the actual precondition, and no figure can exist without one. */
    if (!whole.includes(`\`\`\``) && !whole.includes(`~~~`)) {
        return [{ kind: `prose`, text: whole }];
    }
    const lines = whole.split(`\n`);
    const segments: MarkdownSegment[] = [];
    let prose: string[] = [];
    const flushProse = (): void => {
        if (prose.length > 0) {
            const joined = prose.join(`\n`);
            if (joined.trim() !== ``) {
                segments.push({ kind: `prose`, text: joined });
            }
            prose = [];
        }
    };
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? ``;
        const open = FENCE_OPEN.exec(line);
        const marker = open?.[1];
        const lang = open?.[2]?.toLowerCase() ?? ``;
        if (marker === undefined) {
            prose.push(line);
            continue;
        }
        // Find this fence's closer so a non-figure fence is copied through whole — scanning its body for
        // fences would treat the code inside it as markup.
        let end = lines.length;
        let closed = false;
        for (let scan = index + 1; scan < lines.length; scan += 1) {
            if (closes(lines[scan] ?? ``, marker)) {
                end = scan;
                closed = true;
                break;
            }
        }
        const body = lines.slice(index + 1, end).join(`\n`);
        /* An UNCLOSED fence is never a figure, even when its body happens to be valid JSON. The fence is what
         * delimits the figure, so without a closer the content is by definition still arriving — and rendering
         * a diagram from a half-written body is how a streamed document flickers between two wrong pictures.
         * It stays prose, whole, and becomes a figure the moment the closing fence lands. */
        const figure = closed && FIGURE_LANGS.includes(lang) ? parseFigure(lang, body) : undefined;
        if (figure === undefined) {
            // Not a figure (or a malformed one): the fence stays in the prose, including its delimiters, and
            // renders as an ordinary code block.
            for (let copy = index; copy <= Math.min(end, lines.length - 1); copy += 1) {
                prose.push(lines[copy] ?? ``);
            }
        } else {
            flushProse();
            segments.push({ kind: `figure`, figure });
        }
        index = end;
    }
    flushProse();
    // A document that is nothing but one figure still needs to render, and a caller that gets an empty array
    // would render nothing at all — so an empty split answers with the (empty) prose it was given.
    return segments.length === 0 ? [{ kind: `prose`, text: whole }] : segments;
};
