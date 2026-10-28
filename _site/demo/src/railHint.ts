import { homeRecording, photographed } from "./mode";

// THE FIRST THING THE HERO SAYS: which way in. The home recording opens on a chat with three sandboxes in the rail, and
// nothing on screen tells a first-time visitor that those icons are the way into each one (the owner's, 2026-10-28). A
// bubble beside the rail says it, in plain DOM over the app like the rest of the demo's own chrome, so no app module
// knows it exists. It waits for the app's first view and a moment more, steps aside while the pointer is on the rail
// (the tiles' own tooltips speak then, double-click included) or a dialog is open, and goes for good once the visitor
// presses anything on the rail, steps inside a sandbox or closes it. The screenshot harness never sees it: the poster is the app alone.

const SHOW_AFTER_MS = 1_800;
const CHECK_EVERY_MS = 400;
const BASE = import.meta.env.BASE_URL;

const STYLE = `
.demo-rail-hint {
    position: fixed; z-index: 2147483000; display: flex; align-items: flex-start; gap: 10px; max-width: 260px;
    padding: 10px 10px 10px 14px; border-radius: 10px; font: 13px/1.4 var(--font-sans, system-ui, sans-serif);
    background: var(--color-content, #f4f1ea); color: var(--color-card, #1c1a17);
    box-shadow: 0 8px 28px rgb(0 0 0 / 0.35); opacity: 0; transform: translateX(-6px);
    transition: opacity 260ms ease, transform 260ms ease; pointer-events: none;
}
.demo-rail-hint[data-shown] { opacity: 1; transform: none; pointer-events: auto; }
.demo-rail-hint[data-shown] .demo-rail-hint-body { animation: demo-rail-hint-nudge 2.4s ease-in-out 1s infinite; }
.demo-rail-hint::before {
    content: ""; position: absolute; left: -6px; top: var(--arrow-top, 18px); width: 12px; height: 12px;
    background: inherit; transform: translateY(-50%) rotate(45deg); border-radius: 2px;
}
.demo-rail-hint strong { display: block; font-weight: 600; }
.demo-rail-hint-close {
    flex: none; width: 22px; height: 22px; margin: -2px -2px 0 0; border: 0; border-radius: 6px; background: transparent;
    color: inherit; opacity: 0.6; font: 16px/1 system-ui, sans-serif; cursor: pointer;
}
.demo-rail-hint-close:hover, .demo-rail-hint-close:focus-visible { opacity: 1; background: rgb(127 127 127 / 0.18); }
@keyframes demo-rail-hint-nudge { 0%, 70%, 100% { transform: none; } 80% { transform: translateX(-4px); } 90% { transform: translateX(2px); } }
@media (prefers-reduced-motion: reduce) {
    .demo-rail-hint { transition: opacity 200ms ease; transform: none; }
    .demo-rail-hint[data-shown] .demo-rail-hint-body { animation: none; }
}
`;

/** The app's address under the demo's base: `home`, `home/…`, `agents`, … */
const appPath = (): string => window.location.pathname.slice(BASE.length).replace(/^\/+/, ``);

const onHome = (): boolean => appPath() === `` || appPath() === `home` || appPath().startsWith(`home/`);

/** The rail's sandbox tiles on Home (HomeSandboxes.vue), without the add tile after them. */
const sandboxTiles = (): HTMLElement[] => {
    const group = document.querySelector<HTMLElement>(`.icon-rail-nav[role="group"]`);
    return group === null ? [] : [...group.querySelectorAll<HTMLElement>(`:scope > button.icon-rail-tile`)];
};

const build = (onClose: () => void): HTMLElement => {
    const style = document.createElement(`style`);
    style.textContent = STYLE;
    document.head.append(style);
    const hint = document.createElement(`div`);
    hint.className = `demo-rail-hint`;
    hint.setAttribute(`role`, `status`);
    const body = document.createElement(`div`);
    body.className = `demo-rail-hint-body`;
    const title = document.createElement(`strong`);
    title.textContent = `Pick a sandbox`;
    const line = document.createElement(`span`);
    line.textContent = `Click an icon to see its chat, double-click to step inside.`;
    body.append(title, line);
    const close = document.createElement(`button`);
    close.type = `button`;
    close.className = `demo-rail-hint-close`;
    close.setAttribute(`aria-label`, `Dismiss`);
    close.textContent = `×`;
    close.addEventListener(`click`, onClose);
    hint.append(body, close);
    hint.hidden = true;
    document.body.append(hint);
    return hint;
};

/** Mounts the bubble once the app has drawn Home's rail; a no-op outside the home recording and for the screenshots. */
export const showRailHint = (): void => {
    if (!homeRecording || photographed) {
        return;
    }
    let hint: HTMLElement | undefined;
    let pointerOnRail = false;
    let watchedRail: HTMLElement | undefined;
    let readyAt: number | undefined;

    const stop = (): void => {
        clearInterval(timer);
        hint?.remove();
        hint = undefined;
    };

    const check = (): void => {
        // Inside a sandbox: the bubble did its work.
        if (!onHome()) {
            stop();
            return;
        }
        const tiles = sandboxTiles();
        const first = tiles[0];
        if (first === undefined) {
            hint?.removeAttribute(`data-shown`);
            return;
        }
        readyAt ??= Date.now() + SHOW_AFTER_MS;
        const rail = first.parentElement ?? undefined;
        if (rail !== undefined && rail !== watchedRail) {
            watchedRail = rail;
            rail.addEventListener(`pointerenter`, () => (pointerOnRail = true));
            rail.addEventListener(`pointerleave`, () => (pointerOnRail = false));
            // Found the rail: from here the tiles' tooltips say the rest.
            rail.addEventListener(`pointerdown`, stop);
        }
        hint ??= build(stop);
        const dialogOpen = document.querySelector(`[role="dialog"], [role="alertdialog"], dialog[open]`) !== null;
        const shown = Date.now() >= readyAt && !pointerOnRail && !dialogOpen;
        if (!shown) {
            hint.removeAttribute(`data-shown`);
            return;
        }
        // Beside the rail, its arrow at the middle of the sandboxes' tiles.
        const top = first.getBoundingClientRect();
        const bottom = (tiles.at(-1) ?? first).getBoundingClientRect();
        const middle = (top.top + bottom.bottom) / 2;
        const railRight = (rail ?? first).getBoundingClientRect().right;
        hint.hidden = false;
        const height = hint.offsetHeight;
        const y = Math.max(8, middle - height / 2);
        hint.style.left = `${railRight + 12}px`;
        hint.style.top = `${y}px`;
        hint.style.setProperty(`--arrow-top`, `${middle - y}px`);
        // A frame after it is placed, so it fades in where it stands rather than sliding from the corner.
        requestAnimationFrame(() => hint?.setAttribute(`data-shown`, ``));
    };

    const timer = setInterval(check, CHECK_EVERY_MS);
};
