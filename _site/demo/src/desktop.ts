import type { DesktopState } from "@intentic/sandbox-contract/schemas/terminal";
import { type ClientFrame, clientFrame, pushDomains } from "./daemon/machine/machineKit";
import type { DemoSession, DemoSocket } from "./transport";
import { startVideoCast } from "./videoCast";

// The sandbox's own desktop (the daemon's desktop/agent-desktop.ts): one X display with a few windows on it, watched
// live on the Desktop page and driven once the owner takes over. The demo draws it: a terminal where the agent ran the
// checkout tests, the browser it checked the page in, and the pull request it opened. What the owner does lands on
// it, so a click focuses a window and typing goes into the terminal.

const WIDTH = 1280;
const HEIGHT = 800;
const PANEL = 28;

interface DesktopWindow {
    readonly id: string;
    readonly app: string;
    readonly title: string;
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
}

const WINDOWS: readonly DesktopWindow[] = [
    { id: `0x1a00003`, app: `chromium`, title: `Checkout · acme — Chromium`, x: 360, y: 64, w: 860, h: 560 },
    { id: `0x1c00007`, app: `xterm`, title: `ada@acme-shop: /work/web`, x: 40, y: 300, w: 620, h: 420 },
];

const desk = {
    focused: `0x1c00007`,
    cursor: { x: 700, y: 420 },
    typed: ``,
    lines: [
        `ada@acme-shop:/work/web$ pnpm test checkout`,
        ` ✓ tests/checkout.spec.ts (3 tests) 214ms`,
        ` ✓ shipping.spec.ts (5 tests) 88ms`,
        ``,
        ` Test Files  2 passed (2)`,
        `      Tests  8 passed (8)`,
    ],
};

export const desktopState = (): DesktopState => ({
    running: true,
    display: `:1`,
    windows: WINDOWS.length,
    list: WINDOWS.map((window) => ({ id: window.id, app: window.app, title: window.title, focused: window.id === desk.focused })),
});

const PROMPT = `ada@acme-shop:/work/web$ `;

// Windows back to front: the focused one last, so it is drawn over the rest.
const stacked = (): DesktopWindow[] => [...WINDOWS.filter((window) => window.id !== desk.focused), ...WINDOWS.filter((window) => window.id === desk.focused)];

const drawTerminal = (context: OffscreenCanvasRenderingContext2D, window: DesktopWindow, now: number): void => {
    context.fillStyle = `#101418`;
    context.fillRect(window.x, window.y + 26, window.w, window.h - 26);
    context.font = `14px ui-monospace, Menlo, monospace`;
    const shown = [...desk.lines.slice(-20), `${PROMPT}${desk.typed}${Math.floor(now / 500) % 2 === 0 ? `█` : ``}`];
    shown.forEach((line, index) => {
        context.fillStyle = line.includes(`✓`) || line.includes(`passed`) ? `#7ee787` : `#d6dde4`;
        context.fillText(line, window.x + 12, window.y + 50 + index * 18, window.w - 24);
    });
};

const drawBrowser = (context: OffscreenCanvasRenderingContext2D, window: DesktopWindow): void => {
    const top = window.y + 26;
    context.fillStyle = `#f1f3f4`;
    context.fillRect(window.x, top, window.w, 40);
    context.fillStyle = `#ffffff`;
    context.fillRect(window.x + 16, top + 8, window.w - 32, 24);
    context.fillStyle = `#5f6368`;
    context.font = `13px system-ui, sans-serif`;
    context.fillText(`acme-shop.test/checkout`, window.x + 28, top + 25);
    context.fillStyle = `#ffffff`;
    context.fillRect(window.x, top + 40, window.w, window.h - 66);
    context.fillStyle = `#1f2328`;
    context.font = `600 24px system-ui, sans-serif`;
    context.fillText(`Checkout`, window.x + 40, top + 90);
    context.font = `15px system-ui, sans-serif`;
    const rows: [string, string][] = [
        [`Trail runner, size 42`, `€129.00`],
        [`Shipping to Germany`, `€6.90`],
        [`Total`, `€135.90`],
    ];
    rows.forEach(([label, price], index) => {
        context.fillStyle = index === 2 ? `#1f2328` : `#57606a`;
        context.fillText(label, window.x + 40, top + 140 + index * 34);
        context.fillText(price, window.x + window.w - 140, top + 140 + index * 34);
    });
    context.fillStyle = `#635bff`;
    context.fillRect(window.x + 40, top + 260, 240, 44);
    context.fillStyle = `#ffffff`;
    context.font = `600 15px system-ui, sans-serif`;
    context.fillText(`Pay €135.90`, window.x + 112, top + 288);
};

const drawWindow = (context: OffscreenCanvasRenderingContext2D, window: DesktopWindow, now: number): void => {
    context.fillStyle = `rgba(0, 0, 0, 0.35)`;
    context.fillRect(window.x + 6, window.y + 8, window.w, window.h);
    context.fillStyle = window.id === desk.focused ? `#2d333b` : `#444c56`;
    context.fillRect(window.x, window.y, window.w, 26);
    context.fillStyle = `#e6edf3`;
    context.font = `13px system-ui, sans-serif`;
    context.fillText(window.title, window.x + 12, window.y + 17, window.w - 80);
    if (window.app === `xterm`) {
        drawTerminal(context, window, now);
    } else {
        drawBrowser(context, window);
    }
};

const drawCursor = (context: OffscreenCanvasRenderingContext2D): void => {
    const { x, y } = desk.cursor;
    context.beginPath();
    context.moveTo(x, y);
    context.lineTo(x, y + 18);
    context.lineTo(x + 5, y + 14);
    context.lineTo(x + 12, y + 13);
    context.closePath();
    context.fillStyle = `#ffffff`;
    context.strokeStyle = `#000000`;
    context.fill();
    context.stroke();
};

// The panel's clock as the sandbox's own desktop draws it: 24-hour, in the desktop's zone, whoever is watching.
const panelClock = (now: number): string => {
    const at = new Date(now);
    return `${String(at.getHours()).padStart(2, `0`)}:${String(at.getMinutes()).padStart(2, `0`)}`;
};

const paintDesktop = (only: string | undefined) => (context: OffscreenCanvasRenderingContext2D, now: number): void => {
    const gradient = context.createLinearGradient(0, 0, WIDTH, HEIGHT);
    gradient.addColorStop(0, `#1d3557`);
    gradient.addColorStop(1, `#457b9d`);
    context.fillStyle = gradient;
    context.fillRect(0, 0, WIDTH, HEIGHT);
    const window = WINDOWS.find((candidate) => candidate.id === only);
    if (window !== undefined) {
        // One window alone, filling the picture, as the daemon crops its display to that window's frame.
        context.save();
        context.scale(WIDTH / window.w, HEIGHT / window.h);
        context.translate(-window.x, -window.y);
        drawWindow(context, window, now);
        context.restore();
        return;
    }
    context.fillStyle = `#0d1117`;
    context.fillRect(0, 0, WIDTH, PANEL);
    context.fillStyle = `#e6edf3`;
    context.font = `13px system-ui, sans-serif`;
    context.fillText(`Applications    Places`, 12, 19);
    context.fillText(panelClock(now), WIDTH - 60, 19);
    for (const shown of stacked()) {
        drawWindow(context, shown, now);
    }
    drawCursor(context);
};

// A key the terminal understands: Enter runs the line (the demo answers what a shell would), Backspace takes one back.
const pressKey = (key: string): void => {
    if (key === `Enter`) {
        desk.lines.push(`${PROMPT}${desk.typed}`);
        if (desk.typed.trim() !== ``) {
            desk.lines.push(`${desk.typed.trim().split(` `)[0]}: this is a recording of the sandbox's desktop; nothing runs here`);
        }
        desk.typed = ``;
    } else if (key === `Backspace`) {
        desk.typed = desk.typed.slice(0, -1);
    }
};

const focusAt = (x: number, y: number): void => {
    const hit = stacked().toReversed().find((window) => x >= window.x && x <= window.x + window.w && y >= window.y && y <= window.y + window.h);
    if (hit !== undefined && hit.id !== desk.focused) {
        desk.focused = hit.id;
        pushDomains(`desktop`);
    }
};

// The owner's hands, once they have taken over: the pointer moves and clicks, keys and typed text go to the terminal.
const drive = (said: ClientFrame): void => {
    if (said.type === `mouse` && Number.isFinite(said.x) && Number.isFinite(said.y)) {
        desk.cursor = { x: Number(said.x), y: Number(said.y) };
        if (said.action === `down`) {
            focusAt(desk.cursor.x, desk.cursor.y);
        }
    } else if (said.type === `text`) {
        desk.typed += String(said.text ?? ``);
    } else if (said.type === `key`) {
        pressKey(String(said.key ?? ``));
    }
};

/** The Desktop page's socket: the picture, and once the owner takes over, their pointer and keys onto it. */
export const desktopSession: DemoSession = (socket: DemoSocket) => {
    const only = new URL(socket.url).searchParams.get(`window`) ?? undefined;
    const cast = startVideoCast(socket, { width: WIDTH, height: HEIGHT }, paintDesktop(only));
    let driving = false;
    socket.addEventListener(`client`, (event) => {
        const said: ClientFrame = clientFrame(event);
        if (said.type === `ping`) {
            socket.emit(JSON.stringify({ type: `pong` }));
        } else if (said.type === `pause`) {
            cast.pause();
        } else if (said.type === `resume`) {
            cast.resume();
        } else if (said.type === `control`) {
            driving = said.driving === true;
            socket.emit(JSON.stringify({ type: `held`, owner: driving }));
        } else if (driving) {
            drive(said);
            cast.repaint();
        }
    });
};
