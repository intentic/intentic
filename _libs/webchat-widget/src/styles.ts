import type { WebchatPublicConfig } from "@intentic/sandbox-contract";

/* The widget's entire stylesheet, as a string injected into its shadow root. A string rather than a .css file
 * because the artifact must stay ONE script: a stylesheet the host page has to fetch is a second request that
 * can 404, be blocked, or arrive after the first paint.
 *
 * `all: initial` on the host is the load-bearing line. A shadow root stops the host page's selectors reaching
 * in, but inherited properties (font, color, line-height, letter-spacing) still cross the boundary — which is
 * how an embedded widget ends up in a site's 22px display serif. Resetting at the host and restating what we
 * want below is what makes the widget look identical on every site. */

/* Intentic's own palette, as literal hex.
 *
 * These are the app's design tokens (@intentic-app/ui primitive-colors.css) converted from oklch: a warm neutral
 * ramp at hue 65 and the brand orange at 55, rather than the cool blue-grey a default widget reaches for. The
 * widget looks like the product it came from, and the warm greys are what make the orange sit right — a neutral
 * with no chroma would leave the accent looking pasted on.
 *
 * Literal hex, not oklch(), and not CSS variables read from the host: this stylesheet ships to a stranger's
 * browser, where neither the app's tokens nor a 2023 colour space is guaranteed to exist. Converting once here
 * is what keeps the widget's appearance independent of both. */
const INTENTIC = {
    light: {
        surface: "#fdfbfa", // neutral-0
        surfaceMuted: "#f4f1ee", // neutral-100
        text: "#201c19", // neutral-900
        textMuted: "#625c57", // neutral-600
        line: "#e8e4e0", // neutral-200
        danger: "#bb0916", // red-700
    },
    dark: {
        surface: "#201c19", // neutral-900
        surfaceMuted: "#312d29", // neutral-800
        text: "#faf8f6", // neutral-50
        textMuted: "#a6a09b", // neutral-400
        line: "#312d29", // neutral-800
        danger: "#ff7064", // red-400
    },
} as const;

/* A translucent wash of the accent, for the focus ring. Computed here rather than with CSS `color-mix()` for
 * exactly the reason the palette above is hex: it landed in browsers the same year oklch did, and a focus ring
 * that silently doesn't paint is worse than one computed in four lines. A non-hex accent (a named colour, a
 * gradient someone got creative with) yields undefined and the caller falls back to a solid outline. */
const accentWash = (accent: string, alpha: number): string | undefined => {
    const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(accent.trim())?.[1];
    if (hex === undefined) {
        return undefined;
    }
    const full = hex.length === 3 ? [...hex].map((char) => char + char).join("") : hex;
    const [r, g, b] = [0, 2, 4].map((at) => Number.parseInt(full.slice(at, at + 2), 16));
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
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

export const styles = (config: WebchatPublicConfig): string => {
    const ring = accentWash(config.accent, 0.22);
    return `
:host {
    all: initial;
    --accent: ${config.accent};
    /* Text ON the accent. The brand orange is light enough that white is the only legible choice, and it is the
       same pairing the app's own primary buttons use. */
    --on-accent: #ffffff;
    --gap: 1.25rem;
    --surface: ${INTENTIC.light.surface};
    --surface-muted: ${INTENTIC.light.surfaceMuted};
    --text: ${INTENTIC.light.text};
    --text-muted: ${INTENTIC.light.textMuted};
    --line: ${INTENTIC.light.line};
    --danger: ${INTENTIC.light.danger};
    --radius: 0.875rem;
    position: fixed;
    z-index: 2147483000;
    ${CORNERS[config.position]}
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    font-size: 14px;
    line-height: 1.5;
    color: var(--text);
}

/* The site decides light or dark; we follow it rather than guessing, and every colour above is a variable so
   this override is six lines instead of a second stylesheet. */
@media (prefers-color-scheme: dark) {
    :host {
        --surface: ${INTENTIC.dark.surface};
        --surface-muted: ${INTENTIC.dark.surfaceMuted};
        --text: ${INTENTIC.dark.text};
        --text-muted: ${INTENTIC.dark.textMuted};
        --line: ${INTENTIC.dark.line};
        --danger: ${INTENTIC.dark.danger};
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
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    box-shadow: 0 12px 40px rgb(0 0 0 / 0.22);
    overflow: hidden;
}

.header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.75rem 0.75rem 0.75rem 1rem;
    border-bottom: 1px solid var(--line);
    background: var(--surface);
}
.title { flex: 1; min-width: 0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.icon-button { display: grid; place-items: center; width: 1.75rem; height: 1.75rem; border-radius: 0.5rem; color: var(--text-muted); }
.icon-button:hover { background: var(--surface-muted); color: var(--text); }
.icon-button svg { width: 1rem; height: 1rem; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }

.log {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
    padding: 0.875rem;
    overflow-y: auto;
    overscroll-behavior: contain;
}

.msg {
    max-width: 85%;
    padding: 0.5rem 0.75rem;
    border-radius: 0.75rem;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
}
.msg.visitor { align-self: flex-end; background: var(--accent); color: var(--on-accent); border-bottom-right-radius: 0.25rem; }
.msg.agent { align-self: flex-start; background: var(--surface-muted); border: 1px solid var(--line); border-bottom-left-radius: 0.25rem; }
.msg.notice { align-self: center; max-width: 100%; text-align: center; color: var(--text-muted); font-size: 0.8125rem; padding: 0.25rem 0; }
.msg.failed { align-self: center; max-width: 100%; text-align: center; color: var(--danger); font-size: 0.8125rem; }

/* Three dots while the agent is thinking and has written nothing yet — the turn can take seconds, and a panel
   that shows nothing at all reads as a widget that broke. */
.typing { display: inline-flex; gap: 0.25rem; align-items: center; height: 1.5em; }
.typing span { width: 0.375rem; height: 0.375rem; border-radius: 999px; background: var(--text-muted); animation: blink 1.2s infinite; }
.typing span:nth-child(2) { animation-delay: 0.2s; }
.typing span:nth-child(3) { animation-delay: 0.4s; }
@keyframes blink { 0%, 60%, 100% { opacity: 0.25; } 30% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .typing span { animation: none; opacity: 0.5; } }

.gate { display: flex; flex-direction: column; gap: 0.625rem; padding: 0.875rem; border-top: 1px solid var(--line); }
.gate p { margin: 0; color: var(--text-muted); font-size: 0.8125rem; }
/* Google's button and Turnstile's iframe are slotted from the light DOM — they are third-party frames and
   belong in the document, not in this shadow root. */
::slotted(*) { display: block; }

.composer { display: flex; gap: 0.5rem; align-items: flex-end; padding: 0.75rem; border-top: 1px solid var(--line); }
.composer textarea {
    flex: 1;
    min-height: 2.5rem;
    max-height: 7rem;
    padding: 0.5rem 0.625rem;
    border: 1px solid var(--line);
    border-radius: 0.625rem;
    background: var(--surface);
    color: var(--text);
    font: inherit;
    resize: none;
}
.composer textarea:focus-visible {
    outline: ${ring === undefined ? `2px solid var(--accent)` : `none`};
    outline-offset: -1px;
    border-color: var(--accent);
    ${ring === undefined ? `` : `box-shadow: 0 0 0 3px ${ring};`}
}
.composer textarea:disabled { opacity: 0.6; }
.send { display: grid; place-items: center; width: 2.5rem; height: 2.5rem; border-radius: 0.625rem; background: var(--accent); color: var(--on-accent); }
.send:disabled { opacity: 0.45; cursor: default; }
.send svg { width: 1.125rem; height: 1.125rem; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }

.footer { padding: 0 0.75rem 0.625rem; text-align: center; }
.footer a { color: var(--text-muted); font-size: 0.6875rem; text-decoration: none; }
.footer a:hover { text-decoration: underline; }

[hidden] { display: none !important; }
`;
};
