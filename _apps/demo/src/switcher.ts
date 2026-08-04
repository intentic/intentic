import { DEMO_MODES, demoMode, setDemoMode } from "./mode";

/* THE SWITCHER — the demo's own chrome, and the only pixels on this page the product did not draw.
 *
 * It answers the question a recording cannot: "is this what it looks like, or is this what you filled it with?"
 * Three buttons, one per state (mode.ts), so the visitor sees the same workspace bare, curated and at full
 * tilt, and knows which of the three they are looking at.
 *
 * Built in plain DOM against document.body rather than as a component of the app, for two reasons that are the
 * same reason: the app owns #app and knows nothing about the demo, and this bar has to be on screen before the
 * app has booted — it is mounted first, so the first frame of a cold load already carries it.
 *
 * Its CSS is UNLAYERED, which beats every @layer the app's stylesheet declares, so Tailwind's preflight cannot
 * reset a button out from under it. Colours are the design system's own role tokens, so the bar follows the
 * theme and the light/dark flip like everything else; the fallbacks are dark Ember, for the moment before the
 * app's stylesheet has loaded. Above the app's whole stack (PrimeVue overlays 1000, modals 1100, tooltips
 * 1200): this is the frame around the recording, so it stays reachable from inside anything the recording
 * opens. */

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
   name is on the screen behind them — and the bar lifts clear of the mobile tab bar (MobileTabBar.vue: h-14
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
        // The active one is inert: it is already what the page is showing, and reloading into the same state
        // reads as a broken button rather than as a no-op.
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
