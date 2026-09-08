// Figures are fenced blocks whose language names a figure kind (dag/bars/stats/mermaid), authored inline so a
// document stays one unit of authorship while a figure's body stays data the app themes and lays out. A fence
// that fails to parse degrades to an ordinary code block instead of failing the page. Pure TypeScript, no Vue/DOM
// (ships as `@intentic/ui/markdown`).

// Five categorical chart-palette slots plus a fold-to `neutral`; an author assigns one per entity, not by rank.
export const FIGURE_ACCENTS = [`1`, `2`, `3`, `4`, `5`, `neutral`] as const;
export type FigureAccent = (typeof FIGURE_ACCENTS)[number];

export interface DagFigureNode {
    readonly id: string;
    readonly label: string;
    // One short line under the label, what this box IS, not a second sentence about it.
    readonly note?: string;
    readonly accent?: FigureAccent;
}

// Arrow between two declared nodes; no label field, since DagGraph draws paths, not text on them. `dashed` is the
// one distinction it can draw, for a weaker/optional relationship.
export interface DagFigureEdge {
    readonly from: string;
    readonly to: string;
    readonly dashed?: boolean;
}

// Component/dependency/flow graph. `direction` defaults to LR: a TB graph of the same size runs taller than a
// prose column wants.
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
    // Tip label for when the raw number isn't ideal ("18.2k lines"); absent prints value thousands-separated.
    readonly display?: string;
    readonly accent?: FigureAccent;
}

// Magnitude across named things (package sizes, churn, test counts). One measure only: two differently-scaled
// measures are two figures, not a dual-axis chart.
export interface BarsFigure {
    readonly kind: "bars";
    readonly title?: string;
    readonly items: readonly BarsFigureItem[];
}

export interface StatsFigureItem {
    readonly label: string;
    // Authored as text, not a number ("18.2k", "3 of 42"): avoids guessing units and locale here.
    readonly value: string;
    readonly note?: string;
}

// Orientation strip of standalone counts at the top of a page. Not a chart: a handful of unrelated numbers as a
// bar chart is the dual-axis mistake in another costume.
export interface StatsFigure {
    readonly kind: "stats";
    readonly items: readonly StatsFigureItem[];
}

// Mermaid diagram, carried as the fence body verbatim: only mermaid's own parser, at render time, can judge
// whether it's valid. Kept beside `dag` since mermaid is what a repository already has hand-written, where `dag`
// is generated.
export interface MermaidFigure {
    readonly kind: "mermaid";
    readonly code: string;
}

export type Figure = DagFigure | BarsFigure | StatsFigure | MermaidFigure;

// Fence languages whose body is JSON; code.ts colours exactly these as JSON when one degrades to a code block.
export const JSON_FIGURE_LANGS: readonly string[] = [`dag`, `bars`, `stats`];

export const MERMAID_LANG = `mermaid`;

// Every fence language that means "figure". Everything else stays a code block.
export const FIGURE_LANGS: readonly string[] = [...JSON_FIGURE_LANGS, MERMAID_LANG];

// ---- narrow, total validation ------------------------------------------------------------------------------

// Hand-rolled rather than zod: three small record shapes don't justify a schema dependency for the whole app.
// Every reader below is total (answers `undefined`, never throws), since an exception here would take the page
// down with it.

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === `object` && value !== null && !Array.isArray(value);

// Non-empty trimmed string, or undefined; an empty box in a diagram is worse than showing the fence's source.
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
    // A node with no label falls back to its id; dropping it would silently break edges that point at it.
    return { id, label: text(value[`label`]) ?? id, note: text(value[`note`]), accent: accent(value[`accent`]) };
};

const dagEdge = (value: unknown, ids: ReadonlySet<string>): DagFigureEdge | undefined => {
    if (!isRecord(value)) {
        return undefined;
    }
    const from = text(value[`from`]);
    const to = text(value[`to`]);
    // An edge to a missing node is dropped, not fatal: the alternative is a phantom, unlabelled node in the layout.
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
        // A negative bar is dropped, not clamped to zero: clamping would draw a bar that isn't there.
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

// One fence to a figure, or `undefined` to leave it as a code block. `lang` is the fence's info string (already
// lowercased by the caller); `code` is the raw body.
export const parseFigure = (lang: string, code: string): Figure | undefined => {
    if (lang === MERMAID_LANG) {
        // Only checks for emptiness: a blank mermaid fence would otherwise draw an error card for nothing.
        return code.trim() === `` ? undefined : { kind: `mermaid`, code };
    }
    if (!JSON_FIGURE_LANGS.includes(lang)) {
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

// Fence rule used here: opens with 3+ backticks/tildes, closes with at least as many of the same char.
const FENCE_OPEN = /^(`{3,}|~{3,})([^\s`]*)\s*$/;

// Only column 0: an indented fence belongs to its list item's content, and cutting the document there would
// split the list in half, so it renders as a code block instead.
const closes = (line: string, marker: string): boolean => {
    const match = /^(`{3,}|~{3,})\s*$/.exec(line);
    return match !== null && match[1] !== undefined && match[1][0] === marker[0] && match[1].length >= marker.length;
};

// Splits a document at top-level figure fences before rendering: a figure is a Vue component, and there's
// nowhere in a v-html string to mount one. Markdown constructs don't span a figure (e.g. a reference link), so
// the split is on fence boundaries only, never blank lines.
export const splitFigureSegments = (source: string): readonly MarkdownSegment[] => {
    const whole = typeof source === `string` ? source : String(source ?? ``);
    // Checks for a fence marker, not a figure language, since a language-name search would misfire on plain prose.
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
        // Finds this fence's own closer; scanning its body for nested fences would misread code as markup.
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
        // An unclosed fence is never a figure, even with valid JSON inside: it stays prose until it closes.
        const figure = closed && FIGURE_LANGS.includes(lang) ? parseFigure(lang, body) : undefined;
        if (figure === undefined) {
            // Not a figure, or a malformed one: the fence (with its delimiters) stays in the prose as a code block.
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
    // An empty split falls back to the original (possibly empty) prose, so a caller never renders nothing.
    return segments.length === 0 ? [{ kind: `prose`, text: whole }] : segments;
};
