import { DEFAULT_ACCENT, onAccent, parseHex } from "@intentic/sandbox-contract/embed";

// The dialog's styles as a template string injected into its shadow root. `all: initial` is load-bearing: a shadow root
// blocks the page's selectors but not inherited properties, so without it the dialog inherits the host's font and
// color. System fonts only, so the artifact stays one file and nothing is blocked by the site's CSP.

// The dialog's own ink, which is also the label on the accent whenever it contrasts more than white does.
const INK = "#111827";

// The accent arrives as a hex colour so channels can be read out of it: a wash for the focus ring and a legible label
// colour. One the maths cannot read paints as the default orange rather than half-derived.
export const dialogStyles = (configured: string): string => {
    const accent = parseHex(configured) === undefined ? DEFAULT_ACCENT : configured;
    const [r, g, b] = parseHex(accent) ?? [0, 0, 0];
    return `
:host {
    all: initial;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    line-height: 1.5;
    color: ${INK};
}
/* The app's 6px bar (ui/styles/base.css) in this dialog's own greys: base.css cannot reach across the shadow boundary. */
*, *::before, *::after { scrollbar-width: thin; scrollbar-color: #d1d5db transparent; }
::-webkit-scrollbar { width: 6px; height: 6px; }
::-webkit-scrollbar-thumb { background: #d1d5db; border-radius: 9999px; }
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
button.send { background: ${accent}; color: ${onAccent(accent, INK)}; }
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
    *, *::before, *::after { scrollbar-color: #374151 transparent; }
    ::-webkit-scrollbar-thumb { background: #374151; }
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
