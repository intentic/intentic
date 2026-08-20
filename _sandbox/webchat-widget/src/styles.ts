import type { WebchatPublicConfig } from "@intentic/sandbox-contract";

/* The widget's entire stylesheet, as a string injected into its shadow root. A string rather than a .css file
 * because the artifact must stay ONE script: a stylesheet the host page has to fetch is a second request that
 * can 404, be blocked, or arrive after the first paint.
 *
 * `all: initial` on the host is the line that matters. A shadow root stops the host page's selectors reaching
 * in, but inherited properties (font, color, line-height, letter-spacing) still cross the boundary, which is
 * how an embedded widget ends up in a site's 22px display serif. Resetting at the host and restating what we
 * want below is what makes the widget look identical on every site. */

/* Intentic's warm neutral ramp (hue 65), converted from the oklch in @intentic/ui primitive-colors.css to
 * literal hex. Only the steps the roles below actually name.
 *
 * Hex, not oklch(), and not variables read from the host: this sheet ships to a stranger's browser, where
 * neither the app's tokens nor a 2023 colour space is guaranteed. Converting once here keeps the widget's
 * appearance independent of both. The warm greys are the reason the orange sits right, a neutral with no
 * chroma leaves the accent looking pasted on. */
const NEUTRAL = {
    0: "#fdfbfa",
    50: "#faf8f6",
    300: "#d8d3ce",
    400: "#a6a09b",
    500: "#7f7974",
    600: "#625c57",
    700: "#4c4742",
    800: "#312d29",
    900: "#201c19",
    200: "#e8e4e0",
} as const;

/* The app's ROLE tokens, per scheme, a transcription of the `:root` and `[data-mode="dark"]` blocks in
 * @intentic/ui semantic-colors.css, under the same names so the two can be read side by side. Everything
 * visible below is expressed in these, so "does the widget match the app" is a question about this table
 * rather than about forty rules.
 *
 * `overlay === card` in light is not a mistake, it is the app's own value, and the reason intentic's light
 * chat separates its surfaces with hairlines rather than with fills. */
const ROLES = {
    light: {
        card: NEUTRAL[0],
        overlay: NEUTRAL[0],
        line: NEUTRAL[200],
        lineStrong: NEUTRAL[300],
        content: NEUTRAL[900],
        muted: NEUTRAL[600],
        subtle: NEUTRAL[500],
        danger: "#bb0916", // red-700
        /* Which way the accent moves to become INK. The app doesn't reuse one orange for fills and for glyphs:
         * `--role-primary-fill` is brand-700 in light and brand-400 in dark, because a mid-orange that reads as
         * a button on dark is a 2.6:1 glyph on white. The widget has one configurable accent instead of a ramp,
         * so it synthesises those two ends by pulling the accent 15% toward the scheme's extreme, which lands
         * within a step of the ramp values it is imitating (#e47100 → #c26000 light, #e88626 dark). */
        inkToward: "#000000",
    },
    dark: {
        card: NEUTRAL[900],
        overlay: NEUTRAL[800],
        line: NEUTRAL[800],
        lineStrong: NEUTRAL[700],
        content: NEUTRAL[50],
        muted: NEUTRAL[400],
        subtle: NEUTRAL[500],
        danger: "#ff7064", // red-400
        inkToward: "#ffffff",
    },
} as const;

type Scheme = keyof typeof ROLES;

/* Colour maths in TS rather than in CSS. `color-mix()` landed in browsers the same year `oklch()` did, and it
 * would be carrying BACKGROUNDS here, not a nicety: an unsupported `color-mix()` is invalid at computed-value
 * time, so a bubble would paint nothing at all rather than paint slightly wrong. Evaluated once at render, the
 * sheet ships plain hex and needs no baseline. */
const parseHex = (value: string): number[] | undefined => {
    const digits = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim())?.[1];
    if (digits === undefined) {
        return undefined;
    }
    const full = digits.length === 3 ? [...digits].map((char) => char + char).join("") : digits;
    return [0, 2, 4].map((at) => Number.parseInt(full.slice(at, at + 2), 16));
};

/** `color-mix(in srgb, top ${weight}, bottom)`, and, where `bottom` is what sits behind, an alpha composite. */
const mix = (top: string, bottom: string, weight: number): string => {
    const [over, under] = [parseHex(top), parseHex(bottom)];
    if (over === undefined || under === undefined) {
        return top;
    }
    const channels = over.map((value, at) => Math.round(value * weight + under[at]! * (1 - weight)));
    return `#${channels.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
};

// WCAG relative luminance. Unreadable input scores 0, which only decides a label the caller then never uses.
const luminance = (color: string): number => {
    const [r, g, b] = (parseHex(color) ?? [0, 0, 0]).map((channel) => {
        const unit = channel / 255;
        return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const contrast = (a: number, b: number): number => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/* The label that goes ON a solid accent, measured, not assumed. White on intentic's own orange is 3.15:1: it
 * fails AA for text and only scrapes the 3:1 threshold for a glyph, which is why the app pairs its bright fills
 * with a near-black label instead (`--role-fill-content` is surface-900 in dark). Comparing both candidates
 * rather than thresholding the accent's lightness means there is no crossover constant to get wrong, and a
 * customer's brand colour gets the same treatment as ours instead of inheriting a white that suited the default. */
const onAccent = (accent: string): string => {
    const field = luminance(accent);
    return contrast(field, luminance(NEUTRAL[900])) >= contrast(field, luminance("#ffffff")) ? NEUTRAL[900] : "#ffffff";
};

/* One scheme's worth of custom properties. Light and dark go through this same function so a value added to one
 * cannot be forgotten in the other, the failure mode of the two hand-written blocks this replaced.
 *
 * The derivations, each a transcription of a rule in the app:
 *
 *   --accent-ink        the accent as glyph and edge, stepped for the scheme (see `inkToward`)
 *   --accent-wash       chat.css .composer-send, a 14% wash of the fill, not a solid block of it, 22% on hover
 *   --accent-line       the visitor bubble's edge: .chat-surface's `primary-500 22%` mixed into the line colour
 *   --accent-ring       ChatPanel's composer, `ring-primary-500/25`, over the panel it sits on
 *   --bubble-agent      .chat-surface-assistant, `overlay 35%` over the scroller's card
 *   --bubble-visitor    .chat-surface, `overlay 55%`, the BRIGHTER of the pair
 *
 * The last two are the whole correction: the transcript says who spoke with a step in surface and a tinted edge,
 * never by dropping a saturated brand block into the middle of the thread.
 *
 * Rationale lives here rather than in the returned string because that string is the payload, this function
 * runs once per scheme, so a comment inside it would ship to every visitor twice to explain TypeScript. */
const tokens = (scheme: Scheme, accent: string): string => {
    const role = ROLES[scheme];
    const ink = mix(accent, role.inkToward, 0.85);
    return `
    --accent: ${accent};
    --accent-ink: ${ink};
    --on-accent: ${onAccent(accent)};
    --accent-wash: ${mix(ink, role.overlay, 0.14)};
    --accent-wash-hover: ${mix(ink, role.overlay, 0.22)};
    --accent-line: ${mix(ink, role.line, 0.22)};
    --accent-ring: ${mix(ink, role.card, 0.25)};
    --card: ${role.card};
    --overlay: ${role.overlay};
    --line: ${role.line};
    --line-strong: ${role.lineStrong};
    --content: ${role.content};
    --muted: ${role.muted};
    --subtle: ${role.subtle};
    --danger: ${role.danger};
    --bubble-agent: ${mix(role.overlay, role.card, 0.35)};
    --bubble-visitor: ${mix(role.overlay, role.card, 0.55)};`;
};

// Corner → the two offsets that pin both launcher and panel. Kept together so a new position can't set one and
// forget the other.
const CORNERS: Record<WebchatPublicConfig["position"], string> = {
    "top-right": "top: var(--gap); right: var(--gap);",
    "top-left": "top: var(--gap); left: var(--gap);",
    "bottom-right": "bottom: var(--gap); right: var(--gap);",
    "bottom-left": "bottom: var(--gap); left: var(--gap);",
};

// Which way the panel grows from the launcher, so it never opens off-screen.
const PANEL_ANCHOR: Record<WebchatPublicConfig["position"], string> = {
    "top-right": "top: calc(var(--gap) + 3.5rem); right: var(--gap);",
    "top-left": "top: calc(var(--gap) + 3.5rem); left: var(--gap);",
    "bottom-right": "bottom: calc(var(--gap) + 3.5rem); right: var(--gap);",
    "bottom-left": "bottom: calc(var(--gap) + 3.5rem); left: var(--gap);",
};

/* An accent the maths can read. WebchatConfig validates the field as hex for exactly this reason, so this is
 * the branch that cannot be reached from a stored automation, kept because the wire type is a plain string and
 * a widget rendering with its wash, ring and label silently missing is worse than one rendering in the brand
 * orange the daemon defaults to anyway. */
const DEFAULT_ACCENT = "#e47100"; // brand-600

export const styles = (config: WebchatPublicConfig): string => {
    const accent = parseHex(config.accent) === undefined ? DEFAULT_ACCENT : config.accent;
    return `
:host {
    all: initial;
    ${tokens("light", accent)}
    --gap: 1.25rem;
    /* The app's radius scale (@intentic/ui tokens.css), by the names it uses them under: controls at lg,
       bubbles at lg, the panel at xl, the composer shell at 2xl. */
    --radius-md: 0.5rem;
    --radius-lg: 0.75rem;
    --radius-xl: 1rem;
    --radius-2xl: 1.25rem;
    position: fixed;
    z-index: 2147483000;
    ${CORNERS[config.position]}
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    font-size: 14px;
    line-height: 1.5;
    color: var(--content);
}

/* The site decides light or dark; we follow it rather than guessing. */
@media (prefers-color-scheme: dark) {
    :host {
        ${tokens("dark", accent)}
    }
}

*, *::before, *::after { box-sizing: border-box; }

button {
    font: inherit;
    color: inherit;
    cursor: pointer;
    border: 0;
    background: none;
}

/* The one place the accent is painted solid. A wash is what the app uses for controls, but those sit on a
   surface we own — the launcher sits on the customer's page, where a 14% tint composites over an unknown
   colour and can vanish. Conspicuous is the whole job of this button. */
.launcher {
    display: grid;
    place-items: center;
    width: 3.25rem;
    height: 3.25rem;
    border-radius: 999px;
    background: var(--accent);
    color: var(--on-accent);
    box-shadow: 0 6px 20px rgb(0 0 0 / 0.18);
    transition: transform 120ms ease, box-shadow 120ms ease;
}
.launcher:hover { transform: scale(1.05); box-shadow: 0 8px 26px rgb(0 0 0 / 0.24); }
.launcher:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.launcher svg { width: 1.5rem; height: 1.5rem; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }

.panel {
    position: fixed;
    ${PANEL_ANCHOR[config.position]}
    display: flex;
    flex-direction: column;
    width: min(23rem, calc(100vw - 2 * var(--gap)));
    height: min(32rem, calc(100vh - 2 * var(--gap) - 4rem));
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: var(--radius-xl);
    box-shadow: 0 12px 40px rgb(0 0 0 / 0.22);
    overflow: hidden;
}

.header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.75rem 0.75rem 0.75rem 1rem;
    border-bottom: 1px solid var(--line);
}
.title { flex: 1; min-width: 0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.icon-button { display: grid; place-items: center; width: 1.75rem; height: 1.75rem; border-radius: var(--radius-md); color: var(--muted); transition: background-color 120ms ease, color 120ms ease; }
.icon-button:hover { background: var(--overlay); color: var(--content); }
.icon-button:focus-visible { outline: 2px solid var(--accent-ink); outline-offset: 1px; }
.icon-button svg { width: 1rem; height: 1rem; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }

.log {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.875rem;
    overflow-y: auto;
    overscroll-behavior: contain;
}

/* Both bubbles carry a border, so the pair sit on one grid, a bubble that gained an edge only when it was the
   visitor's would be a pixel taller than the one above it. */
.msg {
    max-width: 85%;
    padding: 0.5rem 0.75rem;
    border-radius: var(--radius-lg);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
}
.msg.agent { align-self: flex-start; background: var(--bubble-agent); border: 1px solid var(--line); }
.msg.visitor { align-self: flex-end; background: var(--bubble-visitor); border: 1px solid var(--accent-line); }
.msg.notice { align-self: center; max-width: 100%; text-align: center; color: var(--muted); font-size: 0.8125rem; padding: 0.25rem 0; }
.msg.failed { align-self: center; max-width: 100%; text-align: center; color: var(--danger); font-size: 0.8125rem; }

/* Three dots while the agent is thinking and has written nothing yet, the turn can take seconds, and a panel
   that shows nothing at all reads as a widget that broke. */
.typing { display: inline-flex; gap: 0.25rem; align-items: center; height: 1.5em; }
.typing span { width: 0.375rem; height: 0.375rem; border-radius: 999px; background: var(--muted); animation: blink 1.2s infinite; }
.typing span:nth-child(2) { animation-delay: 0.2s; }
.typing span:nth-child(3) { animation-delay: 0.4s; }
@keyframes blink { 0%, 60%, 100% { opacity: 0.25; } 30% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .typing span { animation: none; opacity: 0.5; } }

.gate { display: flex; flex-direction: column; gap: 0.625rem; padding: 0 0.875rem 0.875rem; }
.gate p { margin: 0; color: var(--muted); font-size: 0.8125rem; }
/* Google's button and Turnstile's iframe are slotted from the light DOM, they are third-party frames and
   belong in the document, not in this shadow root. */
::slotted(*) { display: block; }

/* One shell holding the input and the send button, exactly as the app's composer does (ChatPanel's footer):
   the frame is what takes focus, so the textarea inside it is transparent and borderless. Two nested boxes —
   a bordered field beside a separate button — is the generic-widget arrangement this replaced, and it drew a
   second edge around something that is already inside an edge. */
.composer { padding: 0.75rem; }
.composer-shell {
    display: flex;
    align-items: flex-end;
    gap: 0.5rem;
    padding: 0.25rem 0.25rem 0.25rem 0.75rem;
    background: var(--overlay);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-2xl);
    transition: border-color 120ms ease, box-shadow 120ms ease;
}
.composer-shell:focus-within { border-color: var(--accent-ink); box-shadow: 0 0 0 2px var(--accent-ring); }
.composer textarea {
    flex: 1;
    min-height: 2rem;
    max-height: 7rem;
    padding: 0.375rem 0 0.375rem;
    border: 0;
    background: transparent;
    color: var(--content);
    font: inherit;
    resize: none;
}
.composer textarea:focus { outline: none; }
.composer textarea::placeholder { color: var(--subtle); }
.composer textarea:disabled { color: var(--muted); }

.send {
    display: grid;
    place-items: center;
    width: 2rem;
    height: 2rem;
    flex-shrink: 0;
    border-radius: 999px;
    background: var(--accent-wash);
    color: var(--accent-ink);
    transition: background-color 120ms ease;
}
.send:hover:not(:disabled) { background: var(--accent-wash-hover); }
.send:focus-visible { outline: 2px solid var(--accent-ink); outline-offset: 1px; }
.send:disabled { background: var(--overlay); color: var(--subtle); cursor: default; }
.send svg { width: 1.125rem; height: 1.125rem; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
/* The paper plane's ink sits up and to the right of its box, so it reads off-centre in a circle. Nudge it
   back — the same correction the app makes in chat.css. */
.send svg { translate: -1px 1px; }

.footer { padding: 0 0.75rem 0.625rem; text-align: center; }
.footer a { color: var(--muted); font-size: 0.6875rem; text-decoration: none; }
.footer a:hover { text-decoration: underline; }

[hidden] { display: none !important; }
`;
};
