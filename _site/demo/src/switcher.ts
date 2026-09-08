import { DEMO_MODES, demoMode, setDemoMode } from "./mode";

// The demo's own chrome: three buttons, one per mode (mode.ts), so a visitor can tell bare, curated and full apart.
// Built in plain DOM, mounted before the app boots, so the first frame already carries it. CSS is unlayered and above
// the app's whole stack (1300), using the design system's own tokens.

const STYLE = `
#demo-switcher {
    position: fixed;
    bottom: 0.75rem;
    left: 50%;
    transform: translateX(-50%);
    z-index: 1300;
    display: flex;
    align-items: center;
    gap: 0.625rem;
    max-width: calc(100vw - 1.5rem);
    padding: 0.3125rem 0.3125rem 0.3125rem 0.75rem;
    border: 1px solid var(--color-line, #322c26);
    border-radius: 999px;
    background: color-mix(in srgb, var(--color-card, #1c1917) 88%, transparent);
    box-shadow: 0 10px 30px -10px rgb(0 0 0 / 0.6);
    backdrop-filter: blur(8px);
    font-family: var(--font-sans, Inter, system-ui, sans-serif);
    font-size: 0.75rem;
    line-height: 1;
    color: var(--color-muted, #a8a29e);
}
#demo-switcher .demo-switcher-label {
    white-space: nowrap;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    font-size: 0.625rem;
    color: var(--color-subtle, #78716c);
}
#demo-switcher .demo-switcher-modes {
    display: flex;
    gap: 0.125rem;
    padding: 0.125rem;
    border-radius: 999px;
    background: color-mix(in srgb, var(--color-content, #e7e5e4) 8%, transparent);
}
#demo-switcher button {
    appearance: none;
    margin: 0;
    padding: 0.375rem 0.75rem;
    border: 0;
    border-radius: 999px;
    background: transparent;
    font: inherit;
    font-weight: 500;
    color: var(--color-muted, #a8a29e);
    cursor: pointer;
    transition: background 120ms ease, color 120ms ease;
}
#demo-switcher button:hover {
    color: var(--color-content, #e7e5e4);
    background: color-mix(in srgb, var(--color-content, #e7e5e4) 8%, transparent);
}
#demo-switcher button[aria-pressed="true"] {
    background: var(--color-primary-fill, #c2410c);
    color: var(--color-fill-content, #fafaf9);
    cursor: default;
}
#demo-switcher .demo-switcher-note {
    padding-right: 0.5rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
/* The phone shell, at the app's own breakpoint (useDevice's md, 767.98px) so the two agree about when it
   arrives. Two things change there: the words go, because the three buttons are the control and the state they
   name is on the screen behind them, and the bar lifts clear of the mobile tab bar (MobileTabBar.vue: h-14
   over the safe area), which is a row of the app rather than an overlay, so nothing else moves out of its way. */
@media (max-width: 767.98px) {
    #demo-switcher {
        bottom: calc(3.5rem + env(safe-area-inset-bottom) + 0.5rem);
        padding-left: 0.3125rem;
    }
    #demo-switcher .demo-switcher-label,
    #demo-switcher .demo-switcher-note {
        display: none;
    }
}
`;

export const installSwitcher = (): void => {
    const style = document.createElement(`style`);
    style.textContent = STYLE;
    document.head.append(style);

    const bar = document.createElement(`div`);
    bar.id = `demo-switcher`;
    bar.role = `group`;
    bar.ariaLabel = `How full this demo workspace is`;

    const label = document.createElement(`span`);
    label.className = `demo-switcher-label`;
    label.textContent = `Show me`;

    const modes = document.createElement(`div`);
    modes.className = `demo-switcher-modes`;
    for (const mode of DEMO_MODES) {
        const button = document.createElement(`button`);
        button.type = `button`;
        button.textContent = mode.label;
        button.ariaPressed = String(mode.id === demoMode.id);
        button.title = mode.note;
        // Active button is inert: reloading into the same state would look like a broken button.
        button.addEventListener(`click`, () => {
            if (mode.id !== demoMode.id) {
                setDemoMode(mode.id);
            }
        });
        modes.append(button);
    }

    const note = document.createElement(`span`);
    note.className = `demo-switcher-note`;
    note.textContent = demoMode.note;

    bar.append(label, modes, note);
    document.body.append(bar);
};
