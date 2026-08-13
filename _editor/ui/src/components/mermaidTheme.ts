/* THE APP'S PALETTE, IN THE SHAPE MERMAID TAKES IT.
 *
 * Mermaid ships its own light and dark themes, and both look like someone else's product: lavender boxes on
 * light, slate on dark, neither of which is a colour this design system uses. A diagram in a README is read
 * beside the prose around it, so it has to be dressed from the same tokens as everything else on the page —
 * including the brand themes, which change those tokens under the reader's feet.
 *
 * Mermaid's `base` theme exists for exactly this: hand it a handful of seed colours and it derives the rest.
 * The catch is that deriving means COLOUR ARITHMETIC (khroma's lighten/darken/invert), and khroma reads hex,
 * rgb and hsl — not the OKLch our tokens are written in. Handing it `oklch(23% 0.008 65)` throws somewhere
 * deep inside a theme it computed halfway, and the diagram never appears.
 *
 * So every value is resolved by PAINTING it: a 1×1 canvas is the one colour parser guaranteed to agree with
 * the browser rendering the page, it converts whatever CSS colour syntax the tokens are written in, and it
 * blends two of them in the same call — which is how a node gets a fill that is "a few percent of the accent
 * over the card", the same recipe the surrounding figures use, without hard-coding a shade per scheme.
 *
 * Where there is no 2D canvas (a jsdom test, a context that refuses one), there are no themeVariables at all
 * and mermaid's own themes stand in. A diagram in the wrong palette still says what it says. */

export interface MermaidTheme {
    readonly theme: "base" | "default" | "dark";
    readonly themeVariables?: Readonly<Record<string, string>>;
    // Spacing is not a colour, so it rides along even on the fallback path below — a diagram in mermaid's own
    // palette should still be the size this column can hold.
    readonly flowchart: Readonly<Record<string, number>>;
    readonly sequence: Readonly<Record<string, number>>;
}

// A colour no token holds, used to tell "the canvas rejected this string" from "the canvas painted it". An
// unparseable value leaves fillStyle at whatever it was, so the sentinel has to be set immediately before.
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

/* `base` as #rrggbb, optionally with `over` laid on top at `alpha`. undefined when this environment has no
 * canvas, or when a token resolved to something the browser will not paint (a variable that was never
 * defined resolves to the empty string, which is the usual way that happens). */
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

/* How much of another colour a surface takes. A node has to read as an object sitting ON the page, and a
 * subgraph as a region UNDER its nodes, so the two differ by enough to see and not enough to shout. All three
 * are expressed against the card colour rather than picked per scheme, which is what makes one set of numbers
 * correct in light, in dark, and in a brand theme none of us has looked at yet.
 *
 * A NODE IS TINTED WITH THE ACCENT, NOT WITH THE INK. Washed with the text colour it was grey on grey — legible,
 * and indistinguishable from a wireframe of itself. The accent is the one colour the reader has already agreed
 * to (they chose it), it is what every other control on the page is drawn in, and it costs the diagram nothing
 * in meaning: every box in a flowchart is the same KIND of thing, so the colour is dressing the surface, not
 * encoding anything. Colour that varies per box would be colour carrying no information, which is the one thing
 * a palette exists not to do — the slots below are where a diagram's colour is allowed to mean something.
 *
 * The border takes much more of the accent than the fill: the fill is a surface to read text off, the border is
 * the line that says where the box ends, and matching them leaves a smudge instead of an edge. A subgraph keeps
 * the neutral wash — it is a region behind the nodes, and colouring it puts it in competition with them. */
const NODE_TINT = 0.07;
const NODE_EDGE_TINT = 0.85;
const CLUSTER_TINT = 0.03;

/* The five categorical slots the chart palette exposes, and the achromatic bucket everything past them folds
 * into (semantic-colors.css). Assigned in fixed order and never cycled: past the fifth entity the answer is the
 * tail colour, not a sixth hue this palette never validated. The sixth git branch is told apart by its label,
 * which mermaid draws on every branch anyway — the same relief the palette's own contrast note calls for. */
const SERIES_SLOTS = [1, 2, 3, 4, 5] as const;

// Mermaid's own scale lengths, so a slot past our fifth resolves to the fold rather than to whatever its
// derivation would have invented. Pie sections are 1-indexed; the other two count from zero.
const PIE_SLOTS = 12;
const GIT_SLOTS = 8;
const SCALE_SLOTS = 13;

// `count` colours: the palette in order, then the fold for the rest.
const folded = (count: number, palette: readonly string[], fold: string): string[] =>
    Array.from({ length: count }, (_, index) => palette[index] ?? fold);

// `prefix0, prefix1, …` — the shape mermaid names a scale in.
const numbered = (prefix: string, from: number, values: readonly string[]): Record<string, string> =>
    Object.fromEntries(values.map((value, index) => [`${prefix}${index + from}`, value]));

/* A diagram's own type size — a real step under the prose it sits in (13.2px in a chat bubble). At 13 it was
 * nominally smaller and read as the same size, which is the worst of both: no hierarchy, and a five-box diagram
 * as wide as the column holding it. A flowchart's labels are glanced at, not read in paragraphs. */
const FONT_SIZE = `12px`;

/* HOW MUCH ROOM A DIAGRAM TAKES. Mermaid's defaults are drawn for a diagram that owns its page; these are read
 * in a chat bubble or a file preview, in a column beside prose, and at the defaults one four-box flowchart ran
 * past 500px tall — the reader scrolls past the picture to get back to the sentence it belongs to.
 *
 * Every number is a fraction of what mermaid would have used, and none of them touches the label: text stays
 * legible and the AIR around it is what shrinks. `padding` is the box's own inset (it spends double
 * horizontally, which is where the widest boxes came from), `nodeSpacing` the gap between siblings and
 * `rankSpacing` the gap between one row of the graph and the next — kept the roomiest of the three, because an
 * edge label sits in exactly that gap and must not touch the boxes at either end. `diagramPadding` is the
 * margin outside the whole drawing, which the figure's own block spacing already provides.
 *
 * A sequence diagram is trimmed on the same principle and stops where the risk starts: its margins and the gap
 * between actors are pure air, and an actor's box height is generous for one line of a label a step smaller
 * than it used to be. Its WIDTH is left alone deliberately — that box is a fixed size an actor's name has to
 * fit inside, so narrowing it trades space for a clipped name, which is not a trade a reader benefits from. */
const LAYOUT = {
    flowchart: { padding: 10, nodeSpacing: 32, rankSpacing: 36, diagramPadding: 4 },
    sequence: { diagramMarginX: 16, diagramMarginY: 6, actorMargin: 32, height: 44 },
} as const;

/* The mermaid config fragment for the CURRENT scheme, read off the live DOM rather than passed in: the tokens
 * are the truth, and `scheme` only says which set of them is in force (the caller re-renders when it flips).
 * `font` is the surface's own family, so a diagram inside an extension view is lettered like that view. */
export const mermaidTheme = (scheme: "light" | "dark", font: string): MermaidTheme => {
    const tokens = getComputedStyle(document.documentElement);
    const token = (name: string): string => tokens.getPropertyValue(name).trim();
    const card = token(`--color-card`);
    const content = token(`--color-content`);

    // The accent as it is drawn ON this surface — the token every link and control on the page already uses,
    // so it is the one shade of the reader's chosen colour that is known to read against the card in BOTH
    // schemes. Taking the raw brand ramp instead would be a light-mode accent painted on a dark card.
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

    /* The chart palette, resolved as a set. Partial is not useful — five slots minus one is a diagram where a
     * single entity is silently the fold colour — so it is all or nothing, and its absence costs only the
     * categorical scales below. The core theme above still stands, which is what keeps a flowchart (the case
     * that has no categories at all) working in a context where these tokens never resolved. */
    const palette = SERIES_SLOTS.map((slot) => paint(token(`--color-series-${slot}`))).filter((colour): colour is string => colour !== undefined);
    const fold = paint(token(`--color-series-other`));
    /* THE LABEL THAT LANDS ON A FILLED SLOT, and why it does not flip with the scheme.
     *
     * Everywhere else this app puts a number next to a coloured mark, not on it (BarChart) — the palette's own
     * contrast note assumes exactly that. Mermaid's pie draws the percentage INSIDE the slice and offers one
     * colour for all of them, so a label here has to survive all five fills at once.
     *
     * It is white in both schemes, which is NOT the scheme's own on-fill ink: that token is chosen together
     * with the semantic fills, and those invert between light and dark. The chart slots do not — they are
     * stepped into the same mid-lightness band in both, so what reads on them is the same colour in both.
     * Measured against all ten: white's worst pairing is 3.0:1, the dark scheme's own ink drops to 2.5:1 on
     * violet. Neither reaches AA for small text, which is the real reason a figure like this carries its
     * legend as well — the slice is named outside the wheel, not only sized inside it. */
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
                  /* Slices at FULL strength. Mermaid's own default is 0.7, which is not a styling choice here
                   * but a different palette: the slots were measured for adjacent-pair separation and for the
                   * label that sits on them, and 70% of each over the page is a set of colours nobody checked
                   * — visibly paler, and closest exactly where two neighbours were already closest. */
                  pieOpacity: `1`,
                  pieSectionTextColor: onFill,
                  // The page's own colour between slices: two categorical fills meeting at a shared edge read
                  // as one shape, and a hairline of the background is what separates them back into two.
                  pieStrokeColor: background,
                  pieOuterStrokeColor: line,
                  // Legend and title are prose about the chart, so they wear text colour — never a slot's.
                  pieLegendTextColor: text,
                  pieTitleTextColor: text,
              }
            : {};

    /* Seeds first, then the specific variables the flowchart renderer reads. Both are given because `base`
     * derives the second set from the first with arithmetic that assumes mermaid's own palette — deriving a
     * node border from a node fill produced a line too faint to see against our surfaces in either scheme.
     * Every other diagram type still derives from the seeds, which is why they are set at all. */
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
            // Edge labels sit ON the arrows they belong to, so they need the page's own colour behind them or
            // the line strikes the text through.
            edgeLabelBackground: background,
            fontFamily: font,
            fontSize: FONT_SIZE,
            // Last, so a diagram type that has real categories in it overrides whatever `base` derived for
            // that scale from the seeds above.
            ...categorical,
        },
    };
};
