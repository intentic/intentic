// Mermaid's own themes don't match this app's tokens, and its `base` theme derives colors via arithmetic that can't
// parse OKLCH. Every value here is instead resolved by painting it onto a canvas. Without a 2D canvas (e.g. in tests),
// themeVariables are omitted and mermaid's own theme stands in.

export interface MermaidTheme {
    readonly theme: "base" | "default" | "dark";
    readonly themeVariables?: Readonly<Record<string, string>>;
    // Spacing isn't a color, so it applies even on the fallback path; the diagram must still fit the column.
    readonly flowchart: Readonly<Record<string, number>>;
    readonly sequence: Readonly<Record<string, number>>;
}

// Marks whether the canvas accepted a color string; a bad string leaves fillStyle unchanged, so set this first.
const SENTINEL = `#ff00ff`;

let context: CanvasRenderingContext2D | null | undefined;

const canvas2d = (): CanvasRenderingContext2D | null => {
    if (context === undefined) {
        context = document.createElement(`canvas`).getContext(`2d`, { willReadFrequently: true });
    }
    return context;
};

const hex = (channel: number | undefined): string => (channel ?? 0).toString(16).padStart(2, `0`);

const accepts = (ctx: CanvasRenderingContext2D, color: string): boolean => {
    ctx.fillStyle = SENTINEL;
    ctx.fillStyle = color;
    return ctx.fillStyle !== SENTINEL;
};

// `base` as #rrggbb, optionally blended with `over` at `alpha`. Undefined with no canvas, or when a token resolves to a
// color the browser won't paint (e.g. an undefined CSS variable).
const paint = (base: string, over?: string, alpha = 0): string | undefined => {
    const ctx = canvas2d();
    if (ctx === null || !accepts(ctx, base)) {
        return undefined;
    }
    ctx.clearRect(0, 0, 1, 1);
    ctx.globalAlpha = 1;
    ctx.fillRect(0, 0, 1, 1);
    if (over !== undefined) {
        if (!accepts(ctx, over)) {
            return undefined;
        }
        ctx.globalAlpha = alpha;
        ctx.fillRect(0, 0, 1, 1);
        ctx.globalAlpha = 1;
    }
    const [red, green, blue] = ctx.getImageData(0, 0, 1, 1).data;
    return `#${hex(red)}${hex(green)}${hex(blue)}`;
};

// Blend amounts against the card color, so one set works in any scheme; border blends stronger than fill.
const NODE_TINT = 0.07;
const NODE_EDGE_TINT = 0.85;
const CLUSTER_TINT = 0.03;

// Five categorical slots; anything past the fifth falls to the fold color instead of an unvalidated sixth hue.
const SERIES_SLOTS = [1, 2, 3, 4, 5] as const;

// Mermaid's own scale lengths; slots past our fifth resolve to the fold; pie is 1-indexed, others from zero.
const PIE_SLOTS = 12;
const GIT_SLOTS = 8;
const SCALE_SLOTS = 13;

// `count` colours: the palette in order, then the fold for the rest.
const folded = (count: number, palette: readonly string[], fold: string): string[] =>
    Array.from({ length: count }, (_, index) => palette[index] ?? fold);

// `prefix0, prefix1, …`, the shape mermaid names a scale in.
const numbered = (prefix: string, from: number, values: readonly string[]): Record<string, string> =>
    Object.fromEntries(values.map((value, index) => [`${prefix}${index + from}`, value]));

// Diagram type size, a visible step below the surrounding prose; labels are glanced at, not read as paragraphs.
const FONT_SIZE = `12px`;

// Fractions of mermaid's defaults for a narrow column; sequence width stays untouched so names still fit.
const LAYOUT = {
    flowchart: { padding: 10, nodeSpacing: 32, rankSpacing: 36, diagramPadding: 4 },
    sequence: { diagramMarginX: 16, diagramMarginY: 6, actorMargin: 32, height: 44 },
} as const;

// Config fragment for the current scheme, read live off the DOM tokens; `scheme` only says which set is in force.
// `font` is the surface's own family.
export const mermaidTheme = (scheme: "light" | "dark", font: string): MermaidTheme => {
    const tokens = getComputedStyle(document.documentElement);
    const token = (name: string): string => tokens.getPropertyValue(name).trim();
    const card = token(`--color-card`);
    const content = token(`--color-content`);

    // The link token, not the raw brand ramp: the one accent shade proven to read against the card in both schemes.
    const accent = token(`--color-link`);

    const background = paint(card);
    const text = paint(content);
    const node = paint(card, accent, NODE_TINT);
    const cluster = paint(card, content, CLUSTER_TINT);
    const border = paint(card, accent, NODE_EDGE_TINT);
    const line = paint(token(`--color-line`));
    const stroke = paint(token(`--color-muted`));
    if (
        background === undefined ||
        text === undefined ||
        node === undefined ||
        cluster === undefined ||
        border === undefined ||
        line === undefined ||
        stroke === undefined
    ) {
        return { theme: scheme === `dark` ? `dark` : `default`, ...LAYOUT };
    }

    // Resolved all-or-nothing: a partial palette would silently fold one entity into the tail color.
    const palette = SERIES_SLOTS.map((slot) => paint(token(`--color-series-${slot}`))).filter((colour): colour is string => colour !== undefined);
    const fold = paint(token(`--color-series-other`));
    // Fixed white in both schemes, not the scheme's on-fill ink, since these slots don't invert like the fills do.
    const onFill = paint(token(`--color-white`));

    const categorical =
        palette.length === SERIES_SLOTS.length && fold !== undefined && onFill !== undefined
            ? {
                  ...numbered(`pie`, 1, folded(PIE_SLOTS, palette, fold)),
                  ...numbered(`git`, 0, folded(GIT_SLOTS, palette, fold)),
                  ...numbered(`cScale`, 0, folded(SCALE_SLOTS, palette, fold)),
                  // Every label that lands on one of those fills, rather than beside it.
                  ...numbered(
                      `gitBranchLabel`,
                      0,
                      Array.from({ length: GIT_SLOTS }, () => onFill),
                  ),
                  ...numbered(
                      `cScaleLabel`,
                      0,
                      Array.from({ length: SCALE_SLOTS }, () => onFill),
                  ),
                  // Full opacity; mermaid's 0.7 default would pale these slots below the contrast they were tuned for.
                  pieOpacity: `1`,
                  pieSectionTextColor: onFill,
                  // Background-colored hairline between slices, so two adjacent fills don't read as one shape.
                  pieStrokeColor: background,
                  pieOuterStrokeColor: line,
                  // Legend and title are prose about the chart, so they wear text colour, never a slot's.
                  pieLegendTextColor: text,
                  pieTitleTextColor: text,
              }
            : {};

    // Seeds plus the flowchart-specific variables `base` would otherwise derive from them with arithmetic tuned for
    // mermaid's own palette (a derived border came out too faint here). Other diagram types still derive from the
    // seeds.
    return {
        theme: `base`,
        ...LAYOUT,
        themeVariables: {
            darkMode: String(scheme === `dark`),
            background,
            primaryColor: node,
            primaryTextColor: text,
            primaryBorderColor: border,
            secondaryColor: cluster,
            secondaryTextColor: text,
            secondaryBorderColor: line,
            tertiaryColor: cluster,
            tertiaryTextColor: text,
            tertiaryBorderColor: line,
            lineColor: stroke,
            textColor: text,
            mainBkg: node,
            nodeBorder: border,
            nodeTextColor: text,
            clusterBkg: cluster,
            clusterBorder: line,
            titleColor: text,
            // Edge labels sit on their arrows; without this, the line strikes through the text.
            edgeLabelBackground: background,
            fontFamily: font,
            fontSize: FONT_SIZE,
            // Spread last, so a diagram type with real categories overrides whatever `base` derived from the seeds.
            ...categorical,
        },
    };
};
