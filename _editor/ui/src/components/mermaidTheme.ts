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
 * blends two of them in the same call — which is how a node gets a fill that is "a few percent of the text
 * colour over the card", the same recipe the surrounding figures use, without hard-coding a grey per scheme.
 *
 * Where there is no 2D canvas (a jsdom test, a context that refuses one), there are no themeVariables at all
 * and mermaid's own themes stand in. A diagram in the wrong palette still says what it says. */

export interface MermaidTheme {
    readonly theme: "base" | "default" | "dark";
    readonly themeVariables?: Readonly<Record<string, string>>;
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

/* How much of the text colour a surface takes. A node has to read as an object sitting ON the page, and a
 * subgraph as a region UNDER its nodes, so the two differ by enough to see and not enough to shout. Both are
 * expressed against the card colour rather than picked per scheme, which is what makes one pair of numbers
 * correct in light, in dark, and in a brand theme none of us has looked at yet. */
const NODE_TINT = 0.06;
const CLUSTER_TINT = 0.03;

// A diagram's own type size. A step under the prose it sits in — a flowchart's labels are glanced at, not
// read in paragraphs, and matching the body size makes a five-box diagram wider than the column holding it.
const FONT_SIZE = `13px`;

/* The mermaid config fragment for the CURRENT scheme, read off the live DOM rather than passed in: the tokens
 * are the truth, and `scheme` only says which set of them is in force (the caller re-renders when it flips).
 * `font` is the surface's own family, so a diagram inside an extension view is lettered like that view. */
export const mermaidTheme = (scheme: "light" | "dark", font: string): MermaidTheme => {
    const tokens = getComputedStyle(document.documentElement);
    const token = (name: string): string => tokens.getPropertyValue(name).trim();
    const card = token(`--color-card`);
    const content = token(`--color-content`);

    const background = paint(card);
    const text = paint(content);
    const node = paint(card, content, NODE_TINT);
    const cluster = paint(card, content, CLUSTER_TINT);
    const border = paint(token(`--color-line-strong`));
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
        return { theme: scheme === `dark` ? `dark` : `default` };
    }

    /* Seeds first, then the specific variables the flowchart renderer reads. Both are given because `base`
     * derives the second set from the first with arithmetic that assumes mermaid's own palette — deriving a
     * node border from a node fill produced a line too faint to see against our surfaces in either scheme.
     * Every other diagram type still derives from the seeds, which is why they are set at all. */
    return {
        theme: `base`,
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
        },
    };
};
