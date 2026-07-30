import type { BrowserContext, CDPSession, Page } from "playwright";

// The live-browser wire, shared by the two surfaces that show a Chromium the user isn't sitting in front of:
// the guided login (browser-login.ts — the owner drives) and the agent's browser view (browser-view.ts — the
// owner watches, and may take the wheel). Both are the same three things: JPEG frames out over CDP's
// screencast, the owner's mouse/keyboard back in over CDP's Input domain, and a rebind that follows popups —
// so they are one module rather than two copies that drift.

// Fixed screencast viewport — the web canvas scales to it. Modest to bound frame size over the tunnel.
export const VIEW_WIDTH = 1280;
export const VIEW_HEIGHT = 800;

// Client → server input frames (JSON, mirrored on the web side — the browser can't import this contract package).
export type ScreencastClientMessage =
    | {
          readonly type: "mouse";
          readonly action: "move" | "down" | "up" | "wheel";
          readonly x: number;
          readonly y: number;
          readonly button?: number;
          readonly deltaX?: number;
          readonly deltaY?: number;
      }
    | { readonly type: "text"; readonly text: string }
    | { readonly type: "key"; readonly key: string }
    | { readonly type: "resize"; readonly width: number; readonly height: number }
    | { readonly type: "done" }
    | { readonly type: "ping" };

const cdpButton = (button: number | undefined): "left" | "middle" | "right" => (button === 1 ? "middle" : button === 2 ? "right" : "left");

// The few non-text keys a form needs; anything printable arrives as a `text` frame (Input.insertText).
const SPECIAL_KEYS: Record<string, { code: string; vk: number; text?: string }> = {
    Enter: { code: "Enter", vk: 13, text: "\r" },
    Backspace: { code: "Backspace", vk: 8 },
    Tab: { code: "Tab", vk: 9 },
    Delete: { code: "Delete", vk: 46 },
    Escape: { code: "Escape", vk: 27 },
    ArrowLeft: { code: "ArrowLeft", vk: 37 },
    ArrowUp: { code: "ArrowUp", vk: 38 },
    ArrowRight: { code: "ArrowRight", vk: 39 },
    ArrowDown: { code: "ArrowDown", vk: 40 },
    Home: { code: "Home", vk: 36 },
    End: { code: "End", vk: 35 },
};

// Forward one input frame to the page the CDP session is attached to. `done`/`ping` are conversation-level and
// belong to the route; everything else is a pointer or a keystroke and lands here.
export const dispatchInput = async (session: CDPSession, message: ScreencastClientMessage): Promise<void> => {
    if (message.type === "mouse") {
        if (message.action === "wheel") {
            await session.send("Input.dispatchMouseEvent", {
                type: "mouseWheel",
                x: message.x,
                y: message.y,
                deltaX: message.deltaX ?? 0,
                deltaY: message.deltaY ?? 0,
            });
            return;
        }
        const type = message.action === "down" ? "mousePressed" : message.action === "up" ? "mouseReleased" : "mouseMoved";
        await session.send("Input.dispatchMouseEvent", {
            type,
            x: message.x,
            y: message.y,
            button: cdpButton(message.button),
            clickCount: message.action === "move" ? 0 : 1,
        });
        return;
    }
    if (message.type === "text") {
        await session.send("Input.insertText", { text: message.text });
        return;
    }
    if (message.type === "key") {
        const spec = SPECIAL_KEYS[message.key];
        if (spec === undefined) {
            return;
        }
        await session.send("Input.dispatchKeyEvent", {
            type: spec.text !== undefined ? "keyDown" : "rawKeyDown",
            key: message.key,
            code: spec.code,
            windowsVirtualKeyCode: spec.vk,
            ...(spec.text !== undefined ? { text: spec.text } : {}),
        });
        await session.send("Input.dispatchKeyEvent", { type: "keyUp", key: message.key, code: spec.code, windowsVirtualKeyCode: spec.vk });
        return;
    }
    if (message.type === "resize") {
        await session.send("Emulation.setDeviceMetricsOverride", {
            width: Math.floor(message.width),
            height: Math.floor(message.height),
            deviceScaleFactor: 1,
            mobile: false,
        });
    }
};

// A live view of ONE browser context: the CDP session currently streaming, rebound as pages come and go.
// `attached` is what an input frame is dispatched to, so mouse/keyboard follow the page on screen automatically.
export interface Screencast {
    readonly attached: () => CDPSession | undefined;
    // Point the stream at another page (the route's own popup/tab handling calls this).
    readonly bind: (page: Page) => Promise<void>;
    readonly stop: () => Promise<void>;
}

/* Stream one context's newest page as JPEG frames.
 *
 * The rebind exists because OAuth buttons ("Continue with Google") open a POPUP window; without following it
 * the popup renders off-screen and the view looks dead. We attach to the newest page and, when it closes, fall
 * back to the opener. The agent's browser needs the same rule for a different reason — a tool call that opens
 * a tab moves the work there — so the follow-the-newest-page policy lives here with the stream. */
export const startScreencast = async (context: BrowserContext, onFrame: (data: string) => void): Promise<Screencast> => {
    let attached: CDPSession | undefined;
    let stopped = false;

    const bind = async (target: Page): Promise<void> => {
        if (stopped) {
            return;
        }
        try {
            await attached?.detach();
        } catch {
            // the previous page may already be gone — ignore
        }
        const session = await context.newCDPSession(target);
        attached = session;
        session.on("Page.screencastFrame", (frame) => {
            onFrame(frame.data);
            session.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
        });
        // Normalize the window so client coords (VIEW_WIDTH x VIEW_HEIGHT) map 1:1 even for a smaller popup.
        await target.setViewportSize({ width: VIEW_WIDTH, height: VIEW_HEIGHT }).catch(() => {});
        await session.send("Page.startScreencast", {
            format: "jpeg",
            quality: 60,
            maxWidth: VIEW_WIDTH,
            maxHeight: VIEW_HEIGHT,
            everyNthFrame: 1,
        });
    };

    const follow = (page: Page): void => {
        page.on("close", () => {
            const back = context.pages().at(-1);
            if (back !== undefined && !stopped) {
                void bind(back).catch(() => {
                    // the fallback page died too — the next `page` event rebinds
                });
            }
        });
        void bind(page).catch(() => {
            // a page that vanished mid-attach; the next one rebinds
        });
    };
    context.on("page", follow);

    const first = context.pages().at(-1);
    if (first !== undefined) {
        await bind(first);
    }

    return {
        attached: () => attached,
        bind,
        stop: async () => {
            stopped = true;
            context.off("page", follow);
            try {
                await attached?.detach();
            } catch {
                // the page (or the whole browser) is already gone
            }
            attached = undefined;
        },
    };
};
