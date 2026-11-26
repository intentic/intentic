import { DEVICE_MEDIA_PATH, MEDIA_FLAGS, MEDIA_HEADER_LEN, MEDIA_KINDS } from "@intentic/sandbox-contract/browser-wire";
import { remoteAllowed } from "./daemon/machine/remote.handler";
import { type ClientFrame, clientFrame } from "./daemon/machine/machineKit";
import type { DemoSession, DemoSocket } from "./transport";
import { type CastWire, startVideoCast } from "./videoCast";

/* THE OWNER'S PC'S SCREENS, as its remoted streams one on a media socket (daemon/machine/remote.handler.ts opens them):
   a `hello`, then each frame behind browser-wire's 16-byte header, which the editor's decode worker draws exactly as it
   draws a real computer's. What the demo shows there is what someone watching Ada's PC from the sandbox would see: her
   Windows desktop mid-task on the same checkout the agent is planning, VS Code on CheckoutPanel.tsx and the shop's
   pricing page on localhost on the big screen, the dev server in a terminal on the second. Ada is at the keyboard, so
   her pointer moves and her caret blinks while the visitor only watches; once the PC's card allows control, the
   visitor's pointer, clicks and typing land on it instead. */

const WIDTH = 1920;
const HEIGHT = 1080;
const TASKBAR = 48;

const UI = `"Segoe UI Variable", "Segoe UI", system-ui, sans-serif`;
const MONO = `"Cascadia Code", Consolas, ui-monospace, monospace`;

type Context = OffscreenCanvasRenderingContext2D;

interface Box {
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
}

interface Window extends Box {
    readonly id: string;
    readonly title: string;
    readonly draw: (context: Context, box: Box, now: number) => void;
}

const inside = (box: Box, x: number, y: number): boolean => x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h;

const roundRect = (context: Context, box: Box, radius: number, fill: string): void => {
    context.beginPath();
    context.roundRect(box.x, box.y, box.w, box.h, radius);
    context.fillStyle = fill;
    context.fill();
};

// ── The wallpaper: a soft bloom of light on a deep blue, drawn rather than shipped.
const wallpaper = (context: Context): void => {
    context.fillStyle = `#0b1a33`;
    context.fillRect(0, 0, WIDTH, HEIGHT);
    const bloom = (x: number, y: number, r: number, colour: string): void => {
        const gradient = context.createRadialGradient(x, y, 0, x, y, r);
        gradient.addColorStop(0, colour);
        gradient.addColorStop(1, `rgba(11, 26, 51, 0)`);
        context.fillStyle = gradient;
        context.fillRect(0, 0, WIDTH, HEIGHT);
    };
    bloom(WIDTH * 0.55, HEIGHT * 0.62, 760, `rgba(64, 132, 230, 0.75)`);
    bloom(WIDTH * 0.42, HEIGHT * 0.7, 420, `rgba(150, 200, 255, 0.45)`);
    bloom(WIDTH * 0.8, HEIGHT * 0.2, 520, `rgba(40, 80, 170, 0.5)`);
};

// ── The taskbar: the apps open in the middle, the tray and the clock at the right. The second monitor's has no apps.
const clock = (now: number) => {
    const at = new Date(now);
    const pad = (n: number): string => String(n).padStart(2, `0`);
    return { time: `${pad(at.getHours())}:${pad(at.getMinutes())}`, date: `${pad(at.getDate())}/${pad(at.getMonth() + 1)}/${at.getFullYear()}` };
};

const appIcon = (context: Context, x: number, y: number, app: string, open: boolean): void => {
    const s = 24;
    if (app === `start`) {
        context.fillStyle = `#4cc2ff`;
        for (const [dx, dy] of [
            [0, 0],
            [13, 0],
            [0, 13],
            [13, 13],
        ] as const) {
            context.fillRect(x + dx, y + dy, 11, 11);
        }
    } else if (app === `files`) {
        roundRect(context, { x, y: y + 3, w: s, h: s - 5 }, 3, `#f3c54a`);
        roundRect(context, { x, y: y + 7, w: s, h: s - 9 }, 3, `#ffd96a`);
    } else if (app === `browser`) {
        context.beginPath();
        context.arc(x + s / 2, y + s / 2, s / 2, 0, Math.PI * 2);
        const gradient = context.createLinearGradient(x, y, x + s, y + s);
        gradient.addColorStop(0, `#35c1f1`);
        gradient.addColorStop(1, `#36d27c`);
        context.fillStyle = gradient;
        context.fill();
    } else if (app === `code`) {
        roundRect(context, { x, y, w: s, h: s }, 4, `#1f9cf0`);
        context.fillStyle = `#ffffff`;
        context.font = `700 15px ${MONO}`;
        context.fillText(`</`, x + 4, y + 17);
    } else if (app === `terminal`) {
        roundRect(context, { x, y, w: s, h: s }, 4, `#2b2b2b`);
        context.fillStyle = `#cccccc`;
        context.font = `700 12px ${MONO}`;
        context.fillText(`>_`, x + 4, y + 16);
    }
    if (open) {
        roundRect(context, { x: x + 8, y: y + 32, w: 8, h: 3 }, 1.5, `#9aa0a6`);
    }
};

const taskbar = (context: Context, now: number, apps: readonly string[], focused: string | undefined): void => {
    const top = HEIGHT - TASKBAR;
    context.fillStyle = `rgba(28, 32, 40, 0.92)`;
    context.fillRect(0, top, WIDTH, TASKBAR);
    context.fillStyle = `rgba(255, 255, 255, 0.08)`;
    context.fillRect(0, top, WIDTH, 1);
    if (apps.length > 0) {
        const all = [`start`, `search`, ...apps];
        const span = all.length * 44 + 140;
        let x = (WIDTH - span) / 2;
        for (const app of all) {
            if (app === `search`) {
                roundRect(context, { x, y: top + 9, w: 180, h: 30 }, 15, `rgba(255, 255, 255, 0.08)`);
                context.fillStyle = `#a8adb5`;
                context.font = `13px ${UI}`;
                context.fillText(`Search`, x + 34, top + 29);
                context.strokeStyle = `#a8adb5`;
                context.lineWidth = 1.5;
                context.beginPath();
                context.arc(x + 18, top + 22, 5, 0, Math.PI * 2);
                context.stroke();
                x += 184;
                continue;
            }
            if (app === focused) {
                roundRect(context, { x: x - 6, y: top + 4, w: 40, h: 40 }, 6, `rgba(255, 255, 255, 0.08)`);
            }
            appIcon(context, x + 2, top + 8, app, app !== `start`);
            x += 44;
        }
    }
    const { time, date } = clock(now);
    context.fillStyle = `#e8eaed`;
    context.font = `12px ${UI}`;
    context.textAlign = `right`;
    context.fillText(time, WIDTH - 16, top + 20);
    context.fillText(date, WIDTH - 16, top + 38);
    if (apps.length > 0) {
        context.fillText(`ENG`, WIDTH - 110, top + 29);
        context.fillText(`ᯤ  🔊`, WIDTH - 150, top + 29);
    }
    context.textAlign = `left`;
};

// ── A window's frame: its title, the three caption buttons, a shadow under it.
const frame = (context: Context, window: Window, focused: boolean, now: number): void => {
    context.save();
    context.shadowColor = `rgba(0, 0, 0, ${focused ? 0.55 : 0.35})`;
    context.shadowBlur = focused ? 40 : 24;
    context.shadowOffsetY = 10;
    roundRect(context, window, 8, `#202020`);
    context.restore();
    context.save();
    context.beginPath();
    context.roundRect(window.x, window.y, window.w, window.h, 8);
    context.clip();
    context.fillStyle = focused ? `#202020` : `#2b2b2b`;
    context.fillRect(window.x, window.y, window.w, 34);
    context.fillStyle = focused ? `#e8eaed` : `#9aa0a6`;
    context.font = `12px ${UI}`;
    context.fillText(window.title, window.x + 14, window.y + 21, window.w - 180);
    context.strokeStyle = focused ? `#e8eaed` : `#9aa0a6`;
    context.lineWidth = 1;
    const right = window.x + window.w;
    context.beginPath();
    context.moveTo(right - 130, window.y + 17.5);
    context.lineTo(right - 120, window.y + 17.5);
    context.rect(right - 79.5, window.y + 12.5, 10, 10);
    context.moveTo(right - 29, window.y + 12);
    context.lineTo(right - 19, window.y + 22);
    context.moveTo(right - 19, window.y + 12);
    context.lineTo(right - 29, window.y + 22);
    context.stroke();
    window.draw(context, { x: window.x, y: window.y + 34, w: window.w, h: window.h - 34 }, now);
    context.restore();
};

// ── VS Code on the file the agent's plan touches, as Ada left it: the pending and failed states half written.
const CODE = [
    `import { useState } from "react";`,
    `import { startCheckout } from "../api/checkout";`,
    `import { Button } from "../ui/Button";`,
    ``,
    `type State = "idle" | "pending" | "failed";`,
    ``,
    `export function CheckoutPanel({ priceId }: { priceId: string }) {`,
    `    const [state, setState] = useState<State>("idle");`,
    ``,
    `    const onClick = async () => {`,
    `        setState("pending");`,
    `        try {`,
    `            const { url } = await startCheckout(priceId);`,
    `            window.location.assign(url);`,
    `        } catch {`,
    `            setState("failed");`,
    `        }`,
    `    };`,
    ``,
    `    return (`,
    `        <div className="checkout-panel">`,
    `            <Button onClick={onClick} disabled={state === "pending"}>`,
    `                {state === "pending" ? "Redirecting…" : "Upgrade to Pro"}`,
    `            </Button>`,
    `            {state === "failed" && <p role="alert">Checkout didn't start.</p>}`,
    `        </div>`,
    `    );`,
    `}`,
];
const KEYWORDS = new Set([`import`, `from`, `export`, `function`, `const`, `async`, `await`, `try`, `catch`, `return`, `type`]);
const CARET_LINE = 24;
// Where Ada's caret sits on that line: before the closing `</p>}`, as if she just finished the sentence.
const CARET_TAIL = 5;

const typedAt = { code: ``, shell: `` };

// Dark Modern's colours, by what a token looks like: a string, a keyword, a JSX tag, a type, a name, punctuation.
const TOKEN_COLOURS: readonly (readonly [(token: string) => boolean, string])[] = [
    [(token) => token.startsWith(`"`), `#ce9178`],
    [(token) => KEYWORDS.has(token), `#c586c0`],
    [(token) => token.startsWith(`<`), `#569cd6`],
    [(token) => /^[A-Z]\w*$/u.test(token), `#4ec9b0`],
    [(token) => /^\w+$/u.test(token), `#9cdcfe`],
];
const tokenColour = (token: string): string => TOKEN_COLOURS.find(([matches]) => matches(token))?.[1] ?? `#d4d4d4`;

const codeLine = (context: Context, line: string, x: number, y: number): number => {
    let at = x;
    for (const token of line.split(/("[^"]*"|\b\w+\b|<\/?\w+|\s+)/u).filter((part) => part !== ``)) {
        context.fillStyle = tokenColour(token);
        context.fillText(token, at, y);
        at += context.measureText(token).width;
    }
    return at;
};

const drawCode = (context: Context, box: Box, now: number): void => {
    context.fillStyle = `#181818`;
    context.fillRect(box.x, box.y, 48, box.h);
    const files = [`api`, `  checkout.ts`, `pricing`, `  CheckoutPanel.tsx`, `  PricingPage.tsx`, `  plans.ts`, `ui`, `  Button.tsx`];
    context.fillStyle = `#181818`;
    context.fillRect(box.x + 48, box.y, 230, box.h);
    context.font = `11px ${UI}`;
    context.fillStyle = `#bbbbbb`;
    context.fillText(`EXPLORER`, box.x + 64, box.y + 22);
    context.font = `13px ${UI}`;
    files.forEach((file, index) => {
        const y = box.y + 52 + index * 24;
        if (file.trim() === `CheckoutPanel.tsx`) {
            context.fillStyle = `#37373d`;
            context.fillRect(box.x + 48, y - 16, 230, 22);
        }
        context.fillStyle = file.startsWith(` `) ? `#cccccc` : `#e8e8e8`;
        context.fillText(file.startsWith(` `) ? `   ${file.trim()}` : `⌄ ${file}`, box.x + 64, y);
    });
    for (const [index, glyph] of [`⧉`, `⌕`, `⑂`, `▷`].entries()) {
        context.fillStyle = index === 0 ? `#e8e8e8` : `#858585`;
        context.font = `20px ${UI}`;
        context.fillText(glyph, box.x + 14, box.y + 34 + index * 48);
    }
    const left = box.x + 278;
    context.fillStyle = `#1f1f1f`;
    context.fillRect(left, box.y, box.w - 278, box.h);
    context.fillStyle = `#181818`;
    context.fillRect(left, box.y, box.w - 278, 34);
    context.fillStyle = `#1f1f1f`;
    context.fillRect(left, box.y, 190, 34);
    context.fillStyle = `#ffffff`;
    context.font = `13px ${UI}`;
    context.fillText(`CheckoutPanel.tsx  M`, left + 14, box.y + 22);
    context.font = `14px ${MONO}`;
    const lineHeight = 21;
    CODE.forEach((line, index) => {
        const y = box.y + 62 + index * lineHeight;
        if (y > box.y + box.h - 30) {
            return;
        }
        if (index === CARET_LINE) {
            context.fillStyle = `#2a2d2e`;
            context.fillRect(left, y - 15, box.w - 278, lineHeight);
        }
        context.fillStyle = index === CARET_LINE ? `#c6c6c6` : `#6e7681`;
        context.textAlign = `right`;
        context.fillText(String(index + 1), left + 44, y);
        context.textAlign = `left`;
        const end = codeLine(context, index === CARET_LINE ? `${line.slice(0, -CARET_TAIL)}${typedAt.code}` : line, left + 64, y);
        if (index === CARET_LINE) {
            codeLine(context, line.slice(-CARET_TAIL), end, y);
            if (Math.floor(now / 530) % 2 === 0) {
                context.fillStyle = `#aeafad`;
                context.fillRect(end, y - 15, 2, 19);
            }
        }
    });
    context.fillStyle = `#0078d4`;
    context.fillRect(box.x, box.y + box.h - 24, box.w, 24);
    context.fillStyle = `#ffffff`;
    context.font = `12px ${UI}`;
    context.fillText(`⑂ checkout-cta*    ⊗ 0  ⚠ 1`, box.x + 12, box.y + box.h - 8);
    context.textAlign = `right`;
    context.fillText(`Ln ${CARET_LINE + 1}, Col ${(CODE[CARET_LINE] ?? ``).length - CARET_TAIL + 1 + typedAt.code.length}    Spaces: 4    UTF-8    TypeScript JSX`, box.x + box.w - 14, box.y + box.h - 8);
    context.textAlign = `left`;
};

// ── The shop's pricing page on the dev server, with the Upgrade button that throws today.
const drawBrowser = (context: Context, box: Box): void => {
    context.fillStyle = `#2b2b2b`;
    context.fillRect(box.x, box.y, box.w, 44);
    roundRect(context, { x: box.x + 96, y: box.y + 8, w: box.w - 140, h: 28 }, 14, `#1c1c1c`);
    context.fillStyle = `#9aa0a6`;
    context.font = `13px ${UI}`;
    context.fillText(`←   →   ⟳`, box.x + 16, box.y + 27);
    context.fillStyle = `#e8eaed`;
    context.fillText(`localhost:5173/pricing`, box.x + 116, box.y + 27);
    const page = { x: box.x, y: box.y + 44, w: box.w, h: box.h - 44 };
    context.fillStyle = `#faf7f2`;
    context.fillRect(page.x, page.y, page.w, page.h);
    context.fillStyle = `#2f4858`;
    context.fillRect(page.x, page.y, page.w, 52);
    context.fillStyle = `#faf7f2`;
    context.font = `600 18px Georgia, serif`;
    context.fillText(`acme shop`, page.x + 28, page.y + 33);
    context.font = `14px ${UI}`;
    context.fillText(`Shop    Pricing    Account`, page.x + page.w - 240, page.y + 32);
    context.fillStyle = `#2b2622`;
    context.font = `600 30px Georgia, serif`;
    context.textAlign = `center`;
    context.fillText(`Plans for every shop`, page.x + page.w / 2, page.y + 112);
    context.fillStyle = `#7a6f66`;
    context.font = `15px ${UI}`;
    context.fillText(`Cancel any time. Prices in EUR.`, page.x + page.w / 2, page.y + 142);
    const plans = [
        { name: `Starter`, price: `€0`, lines: [`1 storefront`, `100 orders / month`, `Community support`], cta: `Current plan` },
        { name: `Pro`, price: `€29`, lines: [`3 storefronts`, `Unlimited orders`, `Email support`], cta: `Upgrade to Pro` },
        { name: `Scale`, price: `€99`, lines: [`Unlimited storefronts`, `Priority support`, `SSO`], cta: `Contact sales` },
    ];
    const cardWidth = (page.w - 120) / 3;
    plans.forEach((plan, index) => {
        const card = { x: page.x + 30 + index * (cardWidth + 30), y: page.y + 176, w: cardWidth, h: 330 };
        const pro = plan.name === `Pro`;
        roundRect(context, card, 12, pro ? `#ffffff` : `#f3eee6`);
        if (pro) {
            context.strokeStyle = `#c2703d`;
            context.lineWidth = 2;
            context.beginPath();
            context.roundRect(card.x, card.y, card.w, card.h, 12);
            context.stroke();
        }
        context.fillStyle = `#2b2622`;
        context.font = `600 18px ${UI}`;
        context.fillText(plan.name, card.x + card.w / 2, card.y + 40);
        context.font = `600 40px Georgia, serif`;
        context.fillText(plan.price, card.x + card.w / 2, card.y + 98);
        context.fillStyle = `#7a6f66`;
        context.font = `14px ${UI}`;
        context.fillText(`per month`, card.x + card.w / 2, card.y + 122);
        plan.lines.forEach((line, row) => context.fillText(line, card.x + card.w / 2, card.y + 166 + row * 26));
        const button = { x: card.x + 24, y: card.y + card.h - 70, w: card.w - 48, h: 42 };
        roundRect(context, button, 8, pro ? `#c2703d` : `#e4ddd2`);
        context.fillStyle = pro ? `#ffffff` : `#2b2622`;
        context.font = `600 14px ${UI}`;
        context.fillText(plan.cta, card.x + card.w / 2, button.y + 26);
    });
    context.textAlign = `left`;
    // The bug the agent was asked about, as Ada sees it: DevTools' console counting the throw.
    roundRect(context, { x: page.x + page.w - 250, y: page.y + page.h - 54, w: 230, h: 36 }, 8, `#3c1f1f`);
    context.fillStyle = `#ff8a80`;
    context.font = `12px ${MONO}`;
    context.fillText(`⊗ NotImplemented: checkout`, page.x + page.w - 236, page.y + page.h - 31);
};

// ── The second monitor: the dev server and the test watcher in Windows Terminal.
const SHELL = [
    `PS C:\\Users\\ada\\intentic\\acme-shop> pnpm dev`,
    ``,
    `> acme-shop@0.4.2 dev`,
    `> vite`,
    ``,
    `  VITE v6.2.1  ready in 412 ms`,
    ``,
    `  ➜  Local:   http://localhost:5173/`,
    `  ➜  Network: use --host to expose`,
    ``,
    `10:42:07 [vite] hmr update /src/pricing/PricingPage.tsx`,
    `10:42:31 [vite] hmr update /src/pricing/CheckoutPanel.tsx`,
    `10:43:02 [vite] hmr update /src/pricing/CheckoutPanel.tsx`,
];

const drawTerminal = (context: Context, box: Box, now: number): void => {
    context.fillStyle = `#0c0c0c`;
    context.fillRect(box.x, box.y, box.w, box.h);
    context.fillStyle = `#2b2b2b`;
    context.fillRect(box.x, box.y, 200, 30);
    context.fillStyle = `#e8eaed`;
    context.font = `12px ${UI}`;
    context.fillText(`PowerShell   ✕     +  ⌄`, box.x + 12, box.y + 20);
    context.font = `15px ${MONO}`;
    const lines = [...SHELL, `PS C:\\Users\\ada\\intentic\\acme-shop> ${typedAt.shell}`];
    lines.forEach((line, index) => {
        context.fillStyle = line.includes(`ready`) || line.includes(`➜`) ? `#16c60c` : line.includes(`[vite]`) ? `#61d6d6` : `#cccccc`;
        context.fillText(line, box.x + 16, box.y + 60 + index * 22, box.w - 32);
    });
    if (Math.floor(now / 530) % 2 === 0) {
        const last = lines.at(-1) ?? ``;
        context.fillStyle = `#cccccc`;
        context.fillRect(box.x + 16 + context.measureText(last).width, box.y + 60 + (lines.length - 1) * 22 - 14, 9, 18);
    }
};

interface Monitor {
    readonly windows: readonly Window[];
    readonly apps: readonly string[];
}

// By the monitor's id as remote.handler.ts lists them: the DELL with the work on it, the LG with the dev server.
const MONITORS = new Map<string, Monitor>([
    [
        `0`,
        {
            windows: [
                { id: `browser`, title: `Pricing · acme shop — localhost:5173`, x: 780, y: 90, w: 1080, h: 740, draw: (context, box) => drawBrowser(context, box) },
                { id: `code`, title: `CheckoutPanel.tsx — acme-shop — Visual Studio Code`, x: 60, y: 40, w: 1010, h: 900, draw: drawCode },
            ],
            apps: [`files`, `browser`, `code`, `terminal`],
        },
    ],
    [`1`, { windows: [{ id: `terminal`, title: `Windows PowerShell`, x: 120, y: 80, w: 1400, h: 720, draw: drawTerminal }], apps: [] }],
]);

// Ada's own pointer while she works: it wanders over the editor and back toward the page, never quite still.
const drift = (monitor: string, now: number): { x: number; y: number } => {
    const t = now / 1000;
    return monitor === `0`
        ? { x: 760 + Math.sin(t / 3.1) * 420 + Math.sin(t * 1.7) * 18, y: 520 + Math.sin(t / 2.3) * 220 + Math.cos(t * 1.3) * 12 }
        : { x: 1640 + Math.sin(t / 4) * 60, y: 900 + Math.cos(t / 5) * 40 };
};

const drawPointer = (context: Context, { x, y }: { x: number; y: number }): void => {
    context.beginPath();
    context.moveTo(x, y);
    context.lineTo(x, y + 22);
    context.lineTo(x + 6, y + 17);
    context.lineTo(x + 10, y + 26);
    context.lineTo(x + 14, y + 24);
    context.lineTo(x + 10, y + 15);
    context.lineTo(x + 17, y + 15);
    context.closePath();
    context.fillStyle = `#ffffff`;
    context.strokeStyle = `#000000`;
    context.lineWidth = 1.2;
    context.fill();
    context.stroke();
};

interface Screen {
    readonly monitor: string;
    order: string[];
    // Where the visitor's pointer is, once they drive; undefined while Ada's own moves.
    pointer: { x: number; y: number } | undefined;
}

const paintScreen =
    (screen: Screen) =>
    (context: Context, now: number): void => {
        const { windows, apps } = MONITORS.get(screen.monitor) ?? MONITORS.get(`0`)!;
        wallpaper(context);
        for (const id of screen.order) {
            const window = windows.find((candidate) => candidate.id === id);
            if (window !== undefined) {
                frame(context, window, id === screen.order.at(-1), now);
            }
        }
        taskbar(context, now, apps, screen.order.at(-1));
        drawPointer(context, screen.pointer ?? drift(screen.monitor, now));
    };

// remoted's wire: each frame behind browser-wire's header, whole (one stripe), its capture time counted from the hello.
const mediaWire = (readOnly: boolean): CastWire => {
    let helloAt = 0;
    return {
        opening: (size, codec) => {
            helloAt = Date.now();
            return JSON.stringify({ type: `hello`, width: size.width, height: size.height, scale: 1, codec, readOnly });
        },
        frame: (payload, key, index) => {
            const out = new Uint8Array(MEDIA_HEADER_LEN + payload.byteLength);
            const view = new DataView(out.buffer);
            view.setUint8(0, MEDIA_KINDS.video);
            view.setUint8(1, key ? MEDIA_FLAGS.key : 0);
            view.setUint32(2, index);
            view.setUint32(6, Math.max(0, Date.now() - helloAt));
            view.setUint16(10, 0);
            view.setUint8(12, 0);
            view.setUint8(13, 1);
            out.set(payload, MEDIA_HEADER_LEN);
            return out.buffer;
        },
    };
};

const KEYS_TYPED = new Map([
    [`Space`, ` `],
    [`Tab`, `    `],
]);

// A click raises the window under it.
const raiseAt = (screen: Screen, x: number, y: number): void => {
    const windows = MONITORS.get(screen.monitor)?.windows ?? [];
    const hit = screen.order.toReversed().find((id) => {
        const window = windows.find((candidate) => candidate.id === id);
        return window !== undefined && inside(window, x, y);
    });
    if (hit !== undefined) {
        screen.order = [...screen.order.filter((id) => id !== hit), hit];
    }
};

// A key pressed into a field: Backspace takes one back, Enter ends the line, a space or a tab is typed.
const pressKey = (field: keyof typeof typedAt, key: string): void => {
    if (key === `Backspace`) {
        typedAt[field] = typedAt[field].slice(0, -1);
    } else if (key === `Enter`) {
        typedAt[field] = ``;
    } else {
        typedAt[field] += KEYS_TYPED.get(key) ?? ``;
    }
};

// The visitor's hands, where the card allows control: a click raises the window under it, typing goes to the front one.
const drive = (screen: Screen, said: ClientFrame): void => {
    const front = screen.order.at(-1);
    const field = front === `terminal` ? `shell` : front === `code` ? `code` : undefined;
    if (said.type === `mouse` && Number.isFinite(said.x) && Number.isFinite(said.y)) {
        screen.pointer = { x: Number(said.x), y: Number(said.y) };
        if (said.action === `down`) {
            raiseAt(screen, screen.pointer.x, screen.pointer.y);
        }
    } else if (field !== undefined && said.type === `text`) {
        typedAt[field] += String(said.text ?? ``);
    } else if (field !== undefined && said.type === `key` && said.action !== `up`) {
        pressKey(field, String(said.key ?? ``));
    }
};

const screenSession =
    (monitor: string): DemoSession =>
    (socket: DemoSocket) => {
        const readOnly = !remoteAllowed().control;
        const screen: Screen = { monitor, order: (MONITORS.get(monitor)?.windows ?? []).map((window) => window.id), pointer: undefined };
        const cast = startVideoCast(socket, { width: WIDTH, height: HEIGHT }, paintScreen(screen), mediaWire(readOnly));
        socket.emit(JSON.stringify({ type: `cursor`, cursor: { css: `default` } }));
        socket.addEventListener(`client`, (event) => {
            const said: ClientFrame = clientFrame(event);
            if (said.type === `ping`) {
                socket.emit(JSON.stringify({ type: `pong`, t: Number(said.t) }));
            } else if (said.type === `pause`) {
                cast.pause();
            } else if (said.type === `resume`) {
                cast.resume();
            } else if (said.type === `keyframe`) {
                cast.keyframe();
            } else if (!readOnly && (said.type === `mouse` || said.type === `text` || said.type === `key`)) {
                drive(screen, said);
                cast.repaint();
            }
        });
    };

/** The session behind a screen's media path (`/system/device-media/<device>/screen-<monitor>`), or none. */
export const deviceScreenSocket = (url: URL): DemoSession | undefined => {
    if (!url.pathname.startsWith(`${DEVICE_MEDIA_PATH}/`)) {
        return undefined;
    }
    const session = url.pathname.split(`/`).at(-1) ?? ``;
    return screenSession(session.replace(/^screen-/u, ``));
};
