/* The dialog's styles, as a template string injected into its shadow root.
 *
 * `all: initial` ON THE HOST IS LOAD-BEARING, and it is the lesson the Front Desk widget paid for first: a
 * shadow root blocks the page's SELECTORS but not inherited properties, so without this line the dialog wears
 * the host site's font, colour and line height, and looks broken on exactly the sites that care most about
 * looking right.
 *
 * NO EXTERNAL FONT AND NO EXTERNAL ANYTHING. A system font stack, so the artifact stays one file, the dialog
 * paints on the first frame, and nothing here can be blocked by a Content-Security-Policy the site is entitled
 * to have. */

// The accent arrives as a hex colour (the contract refuses anything else) precisely so channels can be read out
// of it: a wash for the focus ring, a darker step for hover, and a label colour that stays legible on top.
const channels = (hex: string): { r: number; g: number; b: number } => {
    const full = hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex;
    return {
        r: Number.parseInt(full.slice(1, 3), 16),
        g: Number.parseInt(full.slice(3, 5), 16),
        b: Number.parseInt(full.slice(5, 7), 16),
    };
};

/* Whether the accent is light enough that black text belongs on it. The sRGB luminance approximation rather
 * than the exact one: this decides between two colours, and being one percent off the boundary changes nothing
 * anyone can see. Without it a yellow accent gets white text on it, which is the one combination that reads as
 * a broken widget rather than as a bold choice. */
const readableOn = (hex: string): string => {
    const { r, g, b } = channels(hex);
    return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? "#111827" : "#ffffff";
};

export const dialogStyles = (accent: string): string => {
    const { r, g, b } = channels(accent);
    return `
:host {
    all: initial;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    line-height: 1.5;
    color: #111827;
}
.backdrop {
    position: fixed;
    inset: 0;
    z-index: 2147483000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    background: rgba(15, 23, 42, 0.45);
}
.panel {
    width: min(420px, 100%);
    max-height: min(560px, 100%);
    overflow: auto;
    background: #ffffff;
    border-radius: 14px;
    box-shadow: 0 24px 60px rgba(15, 23, 42, 0.28);
    padding: 20px;
    box-sizing: border-box;
}
h2 {
    margin: 0 0 4px;
    font-size: 17px;
    font-weight: 650;
}
p.prompt {
    margin: 0 0 14px;
    font-size: 14px;
    color: #4b5563;
}
label {
    display: block;
    font-size: 12px;
    font-weight: 600;
    color: #4b5563;
    margin: 0 0 4px;
}
textarea, input {
    width: 100%;
    box-sizing: border-box;
    font: inherit;
    font-size: 14px;
    color: inherit;
    background: #ffffff;
    border: 1px solid #d1d5db;
    border-radius: 8px;
    padding: 9px 10px;
    margin: 0 0 12px;
}
textarea { min-height: 104px; resize: vertical; }
textarea:focus-visible, input:focus-visible {
    outline: none;
    border-color: ${accent};
    box-shadow: 0 0 0 3px rgba(${r}, ${g}, ${b}, 0.22);
}
.actions { display: flex; gap: 8px; justify-content: flex-end; align-items: center; }
button {
    font: inherit;
    font-size: 14px;
    font-weight: 600;
    border-radius: 8px;
    padding: 8px 14px;
    border: 1px solid transparent;
    cursor: pointer;
}
button.send { background: ${accent}; color: ${readableOn(accent)}; }
button.send:hover:not(:disabled) { filter: brightness(0.94); }
button.send:disabled { opacity: 0.6; cursor: default; }
button.cancel { background: transparent; color: #4b5563; }
button.cancel:hover { background: #f3f4f6; }
.status { font-size: 13px; color: #6b7280; margin-right: auto; }
.done { font-size: 14px; margin: 0; }
/* The one concession to the host page: a site in dark mode should not get a white rectangle. */
@media (prefers-color-scheme: dark) {
    :host { color: #e5e7eb; }
    .panel { background: #111827; box-shadow: 0 24px 60px rgba(0, 0, 0, 0.55); }
    p.prompt, label, .status { color: #9ca3af; }
    textarea, input { background: #1f2937; border-color: #374151; color: #e5e7eb; }
    button.cancel { color: #9ca3af; }
    button.cancel:hover { background: #1f2937; }
}
@media (prefers-reduced-motion: no-preference) {
    .panel { animation: rise 140ms ease-out; }
}
@keyframes rise {
    from { transform: translateY(8px); opacity: 0; }
    to { transform: none; opacity: 1; }
}
`;
};
