import type { BrowserContext, CDPSession, Page } from "playwright";

// The live-browser wire, shared by the two surfaces that show a Chromium the user isn't sitting in front of:
// a connected account's own profile (browser-profile.ts — the owner drives) and the agent's browser view (browser-view.ts — the
// owner watches, and may take the wheel). Both are the same three things: image frames out over CDP's
// screencast, the owner's mouse/keyboard back in over CDP's Input domain, and a rebind that follows popups —
// so they are one module rather than two copies that drift.

// Fixed screencast viewport — the web canvas scales to it. This is the page's LAYOUT size and stays put: it is
// the agent's page, and a reflow because the owner widened a browser window would change what the agent's own
// screenshots and element positions say. Resolution is a separate axis, and lives in the still below.
export const VIEW_WIDTH = 1280;
export const VIEW_HEIGHT = 800;

// Motion frames: cheap and smooth. Readability is the still's job, so these don't have to pay for it.
const MOTION_QUALITY = 70;
// One high-resolution capture this long after the last motion frame. Long enough that a scroll or a page load
// doesn't fire one per frame, short enough to land before the eye has settled on the picture.
const STILL_DELAY_MS = 400;
const STILL_QUALITY = 85;
// Twice the layout viewport. Past that the wire cost stops buying anything a 1280-CSS-px page can show.
const STILL_SCALE = 2;
/* HOW LONG A CAPTURE KEEPS DISTURBING THE PICTURE IT TOOK. Photographing the page at STILL_SCALE makes Chromium
 * re-raster it, and the screencast dutifully encodes that wobble as motion frames arriving ~20ms behind the
 * still. Left alone they replace the sharp picture with a blurry one AND re-arm the debounce that took it, so a
 * page where nothing whatsoever is happening pulsed sharp-blurry-sharp twice a second forever — flickering, and
 * paying for an encode and a tunnel round trip each time. Frames inside this window belong to our own camera.
 * Generous against a loaded machine and still well under STILL_DELAY_MS, so a real change never waits on it. */
const CAPTURE_ECHO_MS = 250;

const SCREENCAST_OPTIONS = { format: "jpeg", quality: MOTION_QUALITY, maxWidth: VIEW_WIDTH, maxHeight: VIEW_HEIGHT, everyNthFrame: 1 } as const;

// One picture on its way to the client. The format travels WITH the frame because the two kinds are encoded
// differently — see the still below — and the client needs it to build the data URL.
export interface ScreencastFrame {
    readonly data: string;
    readonly format: "jpeg" | "webp";
}

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
    /* A KEYSTROKE, AND THE CHORD IT MAY BE PART OF. Plain typing never comes through here — it rides `text`
     * above — so a key frame is either one of the control keys a form needs or a shortcut the owner pressed:
     * Ctrl+A, Ctrl+Z, Shift+End. There is no `meta`: the Chromium at the far end is a Linux one, where Cmd
     * means nothing, so a Mac's ⌘ arrives here already translated into `ctrl` by the client that read it. */
    | { readonly type: "key"; readonly key: string; readonly ctrl?: boolean; readonly shift?: boolean; readonly alt?: boolean }
    /* WHAT THE OWNER JUST SELECTED, asked for so it can be put on their own clipboard — answered by the routes
     * with a `selection` frame going the other way. Ctrl+C inside this picture would otherwise copy to the
     * SANDBOX's clipboard, which nothing on their machine can read: the exact mirror of the paste problem the
     * clients solve by bridging their own clipboard in as a `text` frame. */
    | { readonly type: "selection" }
    // Stream a specific page instead of whichever the agent opened last — the browser view's tab strip. Pins,
    // so the agent opening a tab no longer moves the picture out from under the user (see `pinned` below).
    | { readonly type: "bind"; readonly pageId: string }
    /* The address bar, which only the owner's own window (browser-profile.ts) has: the picture is the page and
     * nothing else, so there is no window chrome in it to click. Handled by that route against the bound PAGE
     * rather than here against a CDP session — going back is a page's history, not an input event. */
    | { readonly type: "go"; readonly url: string }
    | { readonly type: "back" }
    | { readonly type: "reload" }
    // The tab went to the background (or the route was left). Nobody is looking, so nothing should be encoded
    // or sent — a browsing agent would otherwise push frames down the tunnel at a hidden <img> indefinitely.
    | { readonly type: "pause" }
    | { readonly type: "resume" }
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

// CDP's Input domain packs the held modifiers into one integer. Meta is 4 and deliberately never set — see the
// note on the `key` frame.
const CDP_ALT = 1;
const CDP_CTRL = 2;
const CDP_SHIFT = 8;

/* WHY A CHORD HAS TO ARRIVE AS A REAL KEY EVENT, when ordinary typing does not.
 *
 * Select-all, copy, cut, undo, bold — Chromium calls these editing commands, and the renderer derives them
 * ITSELF from a key event's `code` and virtual key code, not from the character it would have produced. So the
 * table above holds no letters (a letter is text, and text is faster and layout-proof through insertText) while
 * a chord needs one synthesized: Ctrl+A is the KeyA key with the control bit set, and nothing else will do.
 *
 * The rest of the shape is Playwright's own keyboard, copied on purpose — the same `rawKeyDown`, the same
 * fields — because that is the shape Chromium is known to read as a command rather than as a lost keypress. */
interface KeyDescriptor {
    readonly key: string;
    readonly code: string;
    readonly vk: number;
    readonly text?: string;
}

const keyDescriptor = (message: { readonly key: string; readonly shift?: boolean }): KeyDescriptor | undefined => {
    if (/^[a-z]$/i.test(message.key)) {
        const upper = message.key.toUpperCase();
        // Shift decides the CHARACTER the page reports (Ctrl+Shift+Z redoes; its key is "Z"), never the code.
        return { key: message.shift === true ? upper : message.key.toLowerCase(), code: `Key${upper}`, vk: upper.charCodeAt(0) };
    }
    const spec = SPECIAL_KEYS[message.key];
    if (spec === undefined) {
        return undefined;
    }
    return { key: message.key, code: spec.code, vk: spec.vk, ...(spec.text !== undefined ? { text: spec.text } : {}) };
};

// Forward one input frame to the page the CDP session is attached to. `bind`/`pause`/`resume`/`done`/`ping` are
// conversation-level and belong to the route; everything else is a pointer or a keystroke and lands here.
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
        const descriptor = keyDescriptor(message);
        if (descriptor === undefined) {
            return;
        }
        const modifiers = (message.alt === true ? CDP_ALT : 0) | (message.ctrl === true ? CDP_CTRL : 0) | (message.shift === true ? CDP_SHIFT : 0);
        // Shift is the modifier that still produces a character; Ctrl and Alt turn the keystroke into a command,
        // and Chromium only reads it as one when the event carries NO text — hence rawKeyDown for every chord.
        const text = (modifiers & (CDP_CTRL | CDP_ALT)) !== 0 ? undefined : descriptor.text;
        const stroke = { modifiers, key: descriptor.key, code: descriptor.code, windowsVirtualKeyCode: descriptor.vk };
        await session.send("Input.dispatchKeyEvent", {
            ...stroke,
            type: text !== undefined ? "keyDown" : "rawKeyDown",
            ...(text !== undefined ? { text } : {}),
        });
        await session.send("Input.dispatchKeyEvent", { ...stroke, type: "keyUp" });
    }
};

/* THE SELECTION, READ OUT OF WHATEVER PART OF THE PAGE HOLDS IT.
 *
 * The far half of the `selection` frame: the owner pressed Ctrl+C over the picture, and the text has to come
 * back here to reach the clipboard on their own machine. Two places have to be asked, and both matter:
 *
 *   - EVERY FRAME, not just the top document. What a person copies out of one of these windows is most often
 *     inside an embedded sign-in — the account name Google shows in its iframe — and a top-frame-only read
 *     would hand back an empty string exactly there.
 *   - THE FOCUSED FIELD, whose selection window.getSelection() cannot see. An <input> keeps its own, which is
 *     where a one-time code or an email address being copied out of a form actually lives.
 *
 * First non-empty answer wins, and a frame that detached mid-read is skipped rather than fatal: the owner is
 * mid-keystroke, and a page that navigated under it has no selection to report anyway. */
export const readSelection = async (page: Page): Promise<string> => {
    for (const frame of page.frames()) {
        const selected = await frame
            .evaluate(() => {
                const active = document.activeElement;
                if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
                    const { selectionStart: start, selectionEnd: end } = active;
                    if (typeof start === "number" && typeof end === "number" && start !== end) {
                        return active.value.slice(start, end);
                    }
                }
                return window.getSelection()?.toString() ?? "";
            })
            .catch(() => "");
        if (selected !== "") {
            return selected;
        }
    }
    return "";
};

// A live view of ONE browser context: the CDP session currently streaming, rebound as pages come and go.
// `attached` is what an input frame is dispatched to, so mouse/keyboard follow the page on screen automatically.
export interface Screencast {
    readonly attached: () => CDPSession | undefined;
    // The page those frames are of — what a navigation acts on and where an address bar reads its text. The
    // session above is the input path; this is the same picture asked about as a page rather than a socket.
    readonly page: () => Page | undefined;
    // Point the stream at another page. `pin` marks the choice as the USER's, which stops the auto-follow below
    // from overriding it; the route passes it for a `bind` frame and omits it for its own popup handling.
    readonly bind: (page: Page, pin?: boolean) => Promise<void>;
    // Stop and restart the flow of frames without losing the binding — what a hidden tab asks for. Distinct
    // from `stop`, which ends the view; a paused screencast still holds its page and its pin.
    readonly setPaused: (paused: boolean) => Promise<void>;
    readonly stop: () => Promise<void>;
}

/* Stream one of a context's pages, following the agent by default.
 *
 * The auto-rebind exists because OAuth buttons ("Continue with Google") open a POPUP window; without following
 * it the popup renders off-screen and the view looks dead. We attach to the newest page and, when it closes,
 * fall back to the opener. The agent's browser wants the same rule for a different reason — a tool call that
 * opens a tab moves the work there — so following the newest page is the default for both surfaces.
 *
 * PINNING is what makes a tab strip possible on top of that. Once the user picks a page, following the agent
 * would be the bug rather than the feature: the picture would jump away from what they chose the moment the
 * agent opened anything. So an explicit bind pins, and only a page CLOSING can move a pinned stream — at which
 * point there is nothing left to be pinned to and falling back beats a frozen last frame. */
export const startScreencast = async (context: BrowserContext, onFrame: (frame: ScreencastFrame) => void): Promise<Screencast> => {
    let attached: CDPSession | undefined;
    let stopped = false;
    let paused = false;
    let pinned = false;
    // The page `attached` is streaming — only needed to tell whether a closing page is the pinned one.
    let boundTo: Page | undefined;
    let stillTimer: NodeJS.Timeout | undefined;
    // Whether a frame arriving now is the page moving or our own still capture shaking it — see CAPTURE_ECHO_MS.
    let capturing = false;
    let echoUntil = 0;

    /* THE PICTURE ANYONE ACTUALLY READS IS A STILL ONE. Watching an agent browse is mostly watching a page that
     * is not moving — so the motion stream is tuned for smoothness (1x, quality 70, enough to follow a scroll)
     * and every settle is chased by ONE high-resolution capture that replaces it. Sharpness lands exactly where
     * the eye is, and costs nothing during the motion where it would not have been visible anyway.
     *
     * `scale` is a captureScreenshot argument, which is why this leaves the AGENT'S page alone: raising
     * deviceScaleFactor through Emulation would have got the same pixels, but it is a mutation of the thing we
     * are here to observe — window.devicePixelRatio changes under the agent, srcset picks different assets, and
     * the page's own screenshots stop matching what it saw a tool call ago. webp because captureScreenshot
     * takes it and screencast doesn't: ~40% off the wire at matched quality, on the one frame worth spending on. */
    const still = async (session: CDPSession): Promise<void> => {
        if (stopped || paused || session !== attached) {
            return;
        }
        /* A CLIP IS IN DOCUMENT COORDINATES, NOT VIEWPORT ONES, so the still has to ask the page where it is
         * before it can photograph it. A fixed {0,0} names the top of the DOCUMENT — right only while nothing
         * has scrolled, and Chromium answers a clip that isn't on the composited surface with a BLANK image
         * rather than an error. So every settle after a scroll wiped the picture white and the next motion
         * frame brought it back: the view flickered exactly when someone was reading it. */
        capturing = true;
        const shot = await session
            .send("Page.getLayoutMetrics")
            .then(({ visualViewport }) =>
                session.send("Page.captureScreenshot", {
                    format: "webp",
                    quality: STILL_QUALITY,
                    clip: { x: visualViewport.pageX, y: visualViewport.pageY, width: VIEW_WIDTH, height: VIEW_HEIGHT, scale: STILL_SCALE },
                }),
            )
            // Navigated, closed, or blocked on a dialog mid-capture — the next motion frame schedules another.
            .catch(() => undefined);
        capturing = false;
        echoUntil = Date.now() + CAPTURE_ECHO_MS;
        if (shot === undefined || stopped || paused || session !== attached) {
            return;
        }
        onFrame({ data: shot.data, format: "webp" });
    };

    const bind = async (target: Page, pin = false): Promise<void> => {
        if (stopped) {
            return;
        }
        pinned ||= pin;
        boundTo = target;
        clearTimeout(stillTimer);
        // A different page's first frames are nobody's echo, however recently we photographed the last one.
        echoUntil = 0;
        try {
            await attached?.detach();
        } catch {
            // the previous page may already be gone — ignore
        }
        const session = await context.newCDPSession(target);
        attached = session;
        session.on("Page.screencastFrame", (frame) => {
            // Acked whatever happens to it: an unacked frame stops the stream, including the ones below that
            // are dropped precisely because nothing has changed.
            session.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
            if (capturing || Date.now() < echoUntil) {
                // Our own still shaking the page it photographed. Forwarding it would undo the sharp frame we
                // just sent, and re-arming the debounce would take another — which is the loop, not the page.
                return;
            }
            onFrame({ data: frame.data, format: "jpeg" });
            clearTimeout(stillTimer);
            stillTimer = setTimeout(() => void still(session), STILL_DELAY_MS);
        });
        // Normalize the window so client coords (VIEW_WIDTH x VIEW_HEIGHT) map 1:1 even for a smaller popup.
        await target.setViewportSize({ width: VIEW_WIDTH, height: VIEW_HEIGHT }).catch(() => {});
        if (paused) {
            // Bound but silent: the tab is hidden. `resume` starts the flow, and Chromium's first frame after
            // that is the current surface — so nothing about this page is missed by not streaming it now.
            return;
        }
        await session.send("Page.startScreencast", SCREENCAST_OPTIONS);
    };

    const follow = (page: Page): void => {
        page.on("close", () => {
            // The pin dies with the page it pointed at, so the fallback below is free to move the stream.
            if (page === boundTo) {
                pinned = false;
            }
            const back = context.pages().at(-1);
            if (back !== undefined && !stopped) {
                void bind(back).catch(() => {
                    // the fallback page died too — the next `page` event rebinds
                });
            }
        });
        if (pinned) {
            // The user is watching a page they chose; a tab the agent just opened does not get to steal it.
            return;
        }
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
        page: () => boundTo,
        bind,
        setPaused: async (next) => {
            if (stopped || paused === next) {
                return;
            }
            paused = next;
            clearTimeout(stillTimer);
            // Coming back is a fresh stream, and its first frame is the surface as it stands — not an echo.
            echoUntil = 0;
            const session = attached;
            if (session === undefined) {
                return;
            }
            // A page that went away while the tab was hidden is the ordinary case, not an error — the `close`
            // handler's rebind has already moved on, and this session is nobody's stream any more.
            await (next ? session.send("Page.stopScreencast") : session.send("Page.startScreencast", SCREENCAST_OPTIONS)).catch(() => {});
        },
        stop: async () => {
            stopped = true;
            clearTimeout(stillTimer);
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
