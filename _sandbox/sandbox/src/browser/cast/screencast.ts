import type { BrowserViewClientMessage } from "@intentic/sandbox-contract/browser-wire";
import type { BrowserContext, CDPSession, Page } from "playwright";

// The live-browser wire shared by a connected account's own profile (browser-profile.routes.ts) and the agent's browser view
// (browser-view.ts): CDP screencast frames out, Input events back, with a rebind that follows popups.

// Fixed screencast viewport (CSS px); this is the agent's page layout and does not change with the owner's window size.
export const VIEW_WIDTH = 1280;
export const VIEW_HEIGHT = 800;

// Quality for frames while the page is moving; below this JPEG starts smearing small text.
const MOTION_QUALITY = 82;
// Delay after motion settles before taking a high-resolution still; avoids firing on every scroll frame. Shared with
// the video path (stills.ts), which settles by the same rules.
export const STILL_DELAY_MS = 400;
export const STILL_QUALITY = 85;
// Still capture scale relative to the layout viewport; past this a 1280 CSS px page has nothing more to show.
export const STILL_SCALE = 2;
// Window during which frames after a still capture are treated as the capture's own re-raster echo, not real motion.
export const CAPTURE_ECHO_MS = 250;
// Echo window is the capture's own duration times this factor, floored at CAPTURE_ECHO_MS, capped at STILL_IDLE_MS.
export const CAPTURE_ECHO_FACTOR = 3;
// A frame inside the window is not always an echo; it may be the result of the click that ended the quiet. A dropped
// frame always re-arms another still, and byte-identical WebP output confirms the page never moved.
// Cap on the back-off between idle stills; keeps a truly idle page from being polled forever without missing a late
// change.
export const STILL_IDLE_MS = 5000;

const SCREENCAST_OPTIONS = { format: "jpeg", quality: MOTION_QUALITY, maxWidth: VIEW_WIDTH, maxHeight: VIEW_HEIGHT, everyNthFrame: 1 } as const;

// One outgoing frame as raw bytes; format travels with it since the two kinds are encoded differently. Sent as binary
// rather than base64 JSON to avoid the encoding overhead and per-frame string allocation.
export interface ScreencastFrame {
    readonly bytes: Buffer;
    readonly format: "jpeg" | "webp";
}

// Format tag prefixed to each frame, so one socket carries every kind without a separate JSON header. SVG is never
// encoded by this daemon; it's how the recorded demo (_site/demo/src/browser.ts) replays drawn pages on the same wire.
export const FRAME_JPEG = 0;
export const FRAME_WEBP = 1;
export const FRAME_SVG = 2;

// One tag byte followed by the image bytes; shared by both routes so they agree on the frame header.
export const encodeFrame = (frame: ScreencastFrame): Uint8Array<ArrayBuffer> => {
    const wire = new Uint8Array(frame.bytes.byteLength + 1);
    wire[0] = frame.format === "webp" ? FRAME_WEBP : FRAME_JPEG;
    wire.set(frame.bytes, 1);
    return wire;
};

// Client → server messages (JSON), each answered by this view or the session behind it: browser-wire's
// BrowserViewClientMessage, the one definition the editor sends from too. Parsed loosely by the routes, so every field
// is read as the daemon's guess of the client, never trusted as typed.
export type ScreencastClientMessage = BrowserViewClientMessage;

// DOM button index to CDP name; "none" is what a move carries, since CDP treats a move naming a button as a button
// event.
const CDP_BUTTON = ["none", "left", "middle", "right", "back", "forward"] as const;
const cdpButton = (button: number | undefined): (typeof CDP_BUTTON)[number] => CDP_BUTTON[(button ?? 0) + 1] ?? "left";
// Chromium only distinguishes up to a triple-click; anything higher clamps to 3.
const clickCount = (count: number | undefined): number => Math.min(3, Math.max(1, Math.trunc(count ?? 1)));

// CDP packs held modifiers into one integer, shared by pointer and keyboard. Meta (4) is never set; see the `key`
// variant.
const CDP_ALT = 1;
const CDP_CTRL = 2;
const CDP_SHIFT = 8;

const cdpModifiers = (held: { readonly ctrl?: boolean; readonly shift?: boolean; readonly alt?: boolean }): number =>
    (held.alt === true ? CDP_ALT : 0) | (held.ctrl === true ? CDP_CTRL : 0) | (held.shift === true ? CDP_SHIFT : 0);

// Non-text keys a form needs; printable characters arrive as a `text` frame via Input.insertText instead. Space is
// the one printable sent as a key: a button or checkbox answers the keystroke, not an inserted character.
const SPECIAL_KEYS: Record<string, { code: string; vk: number; text?: string }> = {
    Enter: { code: "Enter", vk: 13, text: "\r" },
    " ": { code: "Space", vk: 32, text: " " },
    Backspace: { code: "Backspace", vk: 8 },
    Tab: { code: "Tab", vk: 9 },
    Delete: { code: "Delete", vk: 46 },
    Insert: { code: "Insert", vk: 45 },
    Escape: { code: "Escape", vk: 27 },
    ArrowLeft: { code: "ArrowLeft", vk: 37 },
    ArrowUp: { code: "ArrowUp", vk: 38 },
    ArrowRight: { code: "ArrowRight", vk: 39 },
    ArrowDown: { code: "ArrowDown", vk: 40 },
    Home: { code: "Home", vk: 36 },
    End: { code: "End", vk: 35 },
    PageUp: { code: "PageUp", vk: 33 },
    PageDown: { code: "PageDown", vk: 34 },
    ...Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`F${index + 1}`, { code: `F${index + 1}`, vk: 112 + index }])),
};

// Chromium derives editing commands (select-all, copy, undo) from a key event's code/vk, not the character it would
// produce, so a chord must be synthesized. Shape mirrors Playwright's own keyboard event fields.
interface KeyDescriptor {
    readonly key: string;
    readonly code: string;
    readonly vk: number;
    readonly text?: string;
}

const keyDescriptor = (message: { readonly key: string; readonly shift?: boolean }): KeyDescriptor | undefined => {
    if (/^[a-z]$/i.test(message.key)) {
        const upper = message.key.toUpperCase();
        // Shift changes the reported character (Ctrl+Shift+Z redoes as key "Z"), never the code.
        return { key: message.shift === true ? upper : message.key.toLowerCase(), code: `Key${upper}`, vk: upper.charCodeAt(0) };
    }
    const spec = SPECIAL_KEYS[message.key];
    if (spec === undefined) {
        return undefined;
    }
    return { key: message.key, code: spec.code, vk: spec.vk, ...(spec.text !== undefined ? { text: spec.text } : {}) };
};

export type MouseMessage = Extract<ScreencastClientMessage, { type: "mouse" }>;

// A wheel event as CDP replays it: the page scrolls by exactly these deltas, fractions and all, at the pointer, so a
// trackpad's small steps move it and a wheel's notches do not jump. `shrink` is how many of the picture's pixels make
// one of the page's CSS pixels (the display's scale, a phone's fit): the message is in the picture's, CDP in the page's.
// Buttons and modifiers ride along, for Ctrl+wheel zoom and scrolling during a drag.
export const wheelEvent = (message: MouseMessage, shrink = 1) => ({
    type: "mouseWheel" as const,
    x: message.x / shrink,
    y: message.y / shrink,
    modifiers: cdpModifiers(message),
    buttons: message.buttons ?? 0,
    deltaX: (message.deltaX ?? 0) / shrink,
    deltaY: (message.deltaY ?? 0) / shrink,
});

// What input is dispatched over: a page's CDP session, of which only `send` is used.
export type InputSession = Pick<CDPSession, "send">;

/** Scrolls the page under a wheel message by its exact deltas (see `wheelEvent`). */
export const dispatchWheel = async (session: InputSession, message: MouseMessage, shrink = 1): Promise<void> => {
    await session.send("Input.dispatchMouseEvent", wheelEvent(message, shrink));
};

const dispatchMouse = async (session: InputSession, message: MouseMessage): Promise<void> => {
    // Buttons and modifiers ride on every event, including wheel, for Ctrl+wheel zoom and scroll during a drag.
    const modifiers = cdpModifiers(message);
    const buttons = message.buttons ?? 0;
    if (message.action === "wheel") {
        await dispatchWheel(session, message);
        return;
    }
    const move = message.action === "move";
    const type = message.action === "down" ? "mousePressed" : message.action === "up" ? "mouseReleased" : "mouseMoved";
    await session.send("Input.dispatchMouseEvent", {
        type,
        x: message.x,
        y: message.y,
        modifiers,
        // A move carries no button or count, only `buttons`, which distinguishes a drag from a hover.
        button: move ? "none" : cdpButton(message.button),
        buttons,
        clickCount: move ? 0 : clickCount(message.clickCount),
    });
};

const dispatchKey = async (session: InputSession, message: Extract<ScreencastClientMessage, { type: "key" }>): Promise<void> => {
    const descriptor = keyDescriptor(message);
    if (descriptor === undefined) {
        return;
    }
    const modifiers = cdpModifiers(message);
    // Chromium treats a keystroke as a command only when it carries no text, hence rawKeyDown for Ctrl/Alt chords.
    const text = (modifiers & (CDP_CTRL | CDP_ALT)) !== 0 ? undefined : descriptor.text;
    const stroke = { modifiers, key: descriptor.key, code: descriptor.code, windowsVirtualKeyCode: descriptor.vk };
    await session.send("Input.dispatchKeyEvent", {
        ...stroke,
        type: text !== undefined ? "keyDown" : "rawKeyDown",
        ...(text !== undefined ? { text } : {}),
    });
    await session.send("Input.dispatchKeyEvent", { ...stroke, type: "keyUp" });
};

// Forwards one input frame to the page's CDP session; `bind`/`pause`/`resume`/`done`/`ping` are handled by the route,
// not here.
export const dispatchInput = async (session: InputSession, message: ScreencastClientMessage): Promise<void> => {
    if (message.type === "mouse") {
        await dispatchMouse(session, message);
        return;
    }
    if (message.type === "text") {
        await session.send("Input.insertText", { text: message.text });
        return;
    }
    if (message.type === "key") {
        await dispatchKey(session, message);
    }
};

// Selection may be in the focused input/textarea (invisible to window.getSelection()) or inside any frame, including an
// embedded sign-in iframe; first non-empty answer wins, a detached frame is skipped.
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

// Native `<select>` menus render outside the page's captured surface, so the client draws its own from the options read
// here and applies the pick via Playwright's selectOption (fires input/change properly).
export interface SelectMenu {
    readonly options: readonly { readonly label: string; readonly disabled: boolean }[];
    readonly selected: number;
    // Closed control's position in the streamed viewport, for the client to anchor its menu.
    readonly rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

export const readSelect = async (page: Page): Promise<SelectMenu | undefined> => {
    for (const frame of page.frames()) {
        const found = await frame
            .evaluate(() => {
                const active = document.activeElement;
                // A `multiple` select renders inline already and is visible and clickable directly.
                if (!(active instanceof HTMLSelectElement) || active.multiple) {
                    return undefined;
                }
                const box = active.getBoundingClientRect();
                return {
                    options: Array.from(active.options).map((option) => ({ label: option.label || option.text, disabled: option.disabled })),
                    selected: active.selectedIndex,
                    rect: { x: box.left, y: box.top, width: box.width, height: box.height },
                };
            })
            .catch(() => undefined);
        if (found === undefined) {
            continue;
        }
        // boundingBox() is relative to the main frame's viewport, so one offset covers any nesting depth.
        const holder = frame === page.mainFrame() ? undefined : await frame.frameElement().catch(() => undefined);
        // boundingBox() returns null for an element with no box, treated the same as no offset.
        const offset = holder === undefined ? undefined : ((await holder.boundingBox().catch(() => undefined)) ?? undefined);
        return offset === undefined ? found : { ...found, rect: { ...found.rect, x: found.rect.x + offset.x, y: found.rect.y + offset.y } };
    }
    return undefined;
};

// Applies the owner's pick to the `<select>` the page still has focused, the one readSelect described.
export const applySelect = async (page: Page, index: number): Promise<void> => {
    for (const frame of page.frames()) {
        const handle = await frame.evaluateHandle(() => document.activeElement).catch(() => undefined);
        const element = handle?.asElement() ?? undefined;
        if (element === undefined) {
            continue;
        }
        const isSelect = await element.evaluate((node) => node instanceof HTMLSelectElement && !node.multiple).catch(() => false);
        if (!isSelect) {
            continue;
        }
        // Uses Playwright's selectOption rather than a hand-set index so input/change fire and value trackers update.
        await element.selectOption({ index }).catch(() => undefined);
        return;
    }
};

// Cursor shape isn't in the captured surface either, so it's read via elementFromPoint/getComputedStyle rather than
// drawn by Chromium. Walks same-origin frames (controls are often inside an embedded iframe); bounded depth guards
// against a frame cycle.
const CURSOR_PROBE = `(() => {
    let x = __X__, y = __Y__, doc = document;
    for (let depth = 0; depth < 8; depth += 1) {
        const el = doc.elementFromPoint(x, y);
        if (el === null) { return "default"; }
        const style = getComputedStyle(el).cursor;
        if (el.tagName !== "IFRAME" && el.tagName !== "FRAME") { return style; }
        let inner = null;
        try { inner = el.contentDocument; } catch { inner = null; }
        if (inner === null) { return style; }
        const box = el.getBoundingClientRect();
        x -= box.left; y -= box.top; doc = inner;
    }
    return "default";
})()`;

// Cursor keywords only; a longer value (e.g. a `url()` data URI) is not forwarded, since the client maps keywords to
// its own CSS.
const CURSOR_MAX = 32;

export const readCursor = async (session: CDPSession, x: number, y: number): Promise<string | undefined> => {
    const result = await session
        .send("Runtime.evaluate", {
            expression: CURSOR_PROBE.replace("__X__", String(Math.round(x))).replace("__Y__", String(Math.round(y))),
            returnByValue: true,
        })
        // Navigated mid-probe or no document yet; the next move probes again.
        .catch(() => undefined);
    const value: unknown = result?.result?.value;
    return typeof value === "string" && value !== "" && value.length <= CURSOR_MAX ? value : undefined;
};

// How often the cursor shape is polled while moving; the probe is fire-and-forget and sent only when the shape changes.
const CURSOR_INTERVAL_MS = 60;

// One throttled cursor probe per socket, shared by both surfaces so they can't disagree on a gesture's cursor. Holds
// the last reported shape so an unchanged pointer stays quiet.
export const cursorReporter = (send: (cursor: string) => void): ((session: CDPSession, x: number, y: number) => void) => {
    let reported: string | undefined;
    let probedAt = 0;
    let inFlight = false;
    return (session, x, y) => {
        const now = Date.now();
        // One probe in flight at a time; a slow tunnel must not queue one probe per move.
        if (inFlight || now - probedAt < CURSOR_INTERVAL_MS) {
            return;
        }
        probedAt = now;
        inFlight = true;
        void readCursor(session, x, y)
            .then((cursor) => {
                if (cursor !== undefined && cursor !== reported) {
                    reported = cursor;
                    send(cursor);
                }
            })
            .finally(() => {
                inFlight = false;
            });
    };
};

// What a view puts on each page it streams and takes off again (a phone, emulation.ts), and whether a settled page is
// worth a sharp still: a still is clipped to the fixed viewport, which says nothing true of a page dressed as a device.
export interface ScreencastHooks {
    // A page's session, once it is bound and sized and before its first frame.
    readonly bound?: (session: CDPSession, page: Page) => Promise<void>;
    // The same, before it is let go: rebound elsewhere, or the view stopping.
    readonly unbinding?: (session: CDPSession, page: Page) => Promise<void>;
    readonly sharp?: () => boolean;
}

// A live view of one browser context: the CDP session currently streaming, rebound as pages open and close. `attached`
// is where input frames are dispatched, so mouse/keyboard follow the page on screen.
export interface Screencast {
    readonly attached: () => CDPSession | undefined;
    // Marks that the owner just acted, so the next frame is read as a response rather than the capture's own echo.
    // Called by the routes on every forwarded pointer/keystroke.
    readonly noteInput: () => void;
    // The page these frames are of; used for navigation and reading the address bar text.
    readonly page: () => Page | undefined;
    // Points the stream at another page; `pin` marks it as the user's choice, stopping the auto-follow below.
    readonly bind: (page: Page, pin?: boolean) => Promise<void>;
    // Stops/restarts frame flow without losing the binding; distinct from `stop`, which ends the view entirely.
    readonly setPaused: (paused: boolean) => Promise<void>;
    // Puts a device on the streamed page or takes it off (`change`, given the page's session), never beside a still
    // capture: Chromium ends a capture by putting back the device metrics it began with, so a phone put on meanwhile was
    // undone (`captureStill`). The stream starts again after it, so the new screen is sent (`restartScreencast`).
    // Nothing is done while no page is bound.
    readonly dress: (change: (session: CDPSession, page: Page) => Promise<void>) => Promise<void>;
    readonly stop: () => Promise<void>;
}

// One sharp still of the viewport, as base64 WebP; undefined when the page navigated, closed or is blocked on a dialog
// mid-capture. Clip is in document coordinates, not viewport; a stale scroll offset gets a blank image back from
// Chromium. A clip at a scale is taken by emulating a device for the capture and putting back the metrics in force when
// it began (measured on Chromium 156, 2026-11-20), which is why a device change waits for it (`Screencast.dress`).
const captureStill = async (session: CDPSession): Promise<string | undefined> => {
    const shot = await session
        .send("Page.getLayoutMetrics")
        .then(({ visualViewport }) =>
            session.send("Page.captureScreenshot", {
                format: "webp",
                quality: STILL_QUALITY,
                clip: { x: visualViewport.pageX, y: visualViewport.pageY, width: VIEW_WIDTH, height: VIEW_HEIGHT, scale: STILL_SCALE },
            }),
        )
        // allow(silent-catch): navigated, closed, or blocked on a dialog mid-capture; the next motion frame schedules another.
        .catch(() => undefined);
    return shot?.data;
};

// The stream started again on the same page, whose first frame is the surface as it stands: a device change alone does
// not always bring one (measured on Chromium 156, 2026-11-20: a phone put on just after a still capture sent no frame in
// 4 runs of 8 until the page next painted), and an idle page may not paint again for as long as it is watched.
const restartScreencast = async (session: CDPSession): Promise<void> => {
    await session.send("Page.stopScreencast");
    await session.send("Page.startScreencast", SCREENCAST_OPTIONS);
};

// Streams one of a context's pages, following the newest page by default (an OAuth popup, or an agent-opened tab). Once
// the user explicitly binds a page it's pinned, and only that page closing releases the pin.
export const startScreencast = async (context: BrowserContext, onFrame: (frame: ScreencastFrame) => void, hooks: ScreencastHooks = {}): Promise<Screencast> => {
    let attached: CDPSession | undefined;
    let stopped = false;
    let paused = false;
    let pinned = false;
    // Page `attached` is streaming; needed to tell whether a closing page is the pinned one.
    let boundTo: Page | undefined;
    let stillTimer: NodeJS.Timeout | undefined;
    // The still capture in flight (a frame now may be its echo, CAPTURE_ECHO_MS), and the device changes waiting it out.
    let capturing: Promise<string | undefined> | undefined;
    let dressing = 0;
    let echoUntil = 0;
    // When the current echo-suppressed capture began, and when the owner last acted; a frame in the window is ours only
    // if nothing was input since. See `noteInput`.
    let captureStartedAt = 0;
    let lastInputAt = 0;
    // Sharp frame the client currently shows; compared against the next capture to tell an echo from a real change.
    let lastStill: string | undefined;
    // Consecutive captures that found nothing new; exponent for the still back-off, see STILL_IDLE_MS.
    let quiet = 0;

    // Motion stays smooth and low-res; each settle is followed by one high-resolution still that replaces it. Scaled
    // via captureScreenshot's own argument rather than page zoom, so the agent's own devicePixelRatio and srcset are
    // untouched.
    const still = async (session: CDPSession): Promise<void> => {
        if (stopped || paused || session !== attached || hooks.sharp?.() === false || dressing > 0) {
            return;
        }
        const startedAt = Date.now();
        captureStartedAt = startedAt;
        capturing = captureStill(session);
        const shot = await capturing;
        capturing = undefined;
        // Echo duration scales with what this capture cost; see CAPTURE_ECHO_FACTOR.
        const echoFor = Math.min(Math.max(CAPTURE_ECHO_MS, (Date.now() - startedAt) * CAPTURE_ECHO_FACTOR), STILL_IDLE_MS);
        echoUntil = Date.now() + echoFor;
        if (shot === undefined || stopped || paused || session !== attached || hooks.sharp?.() === false) {
            return;
        }
        if (shot === lastStill) {
            // Pixel-identical to the client's current frame: nothing moved, so this confirms the recent frames were
            // echoes.
            quiet += 1;
            return;
        }
        quiet = 0;
        // Compared as base64 (what CDP returns) but sent as decoded bytes, so the cheap check runs on every capture and
        // the decode only on ones worth sending.
        lastStill = shot;
        onFrame({ bytes: Buffer.from(shot, "base64"), format: "webp" });
    };

    // Every path wanting another sharp reading goes through here, so the back-off is applied consistently.
    const armStill = (session: CDPSession): void => {
        clearTimeout(stillTimer);
        stillTimer = setTimeout(() => void still(session), Math.min(STILL_DELAY_MS * 2 ** quiet, STILL_IDLE_MS));
    };

    const bind = async (target: Page, pin = false): Promise<void> => {
        if (stopped) {
            return;
        }
        pinned ||= pin;
        const previous = attached === undefined || boundTo === undefined ? undefined : { session: attached, page: boundTo };
        boundTo = target;
        clearTimeout(stillTimer);
        // A new page's first frames are nobody's echo; the previous page's sharp frame says nothing about this one's
        // rest state.
        echoUntil = 0;
        lastStill = undefined;
        quiet = 0;
        // allow(silent-catch): a page already closed has nothing left to take off.
        await (previous === undefined ? undefined : hooks.unbinding?.(previous.session, previous.page).catch(() => undefined));
        try {
            await attached?.detach();
        } catch {
            // Previous page may already be gone.
        }
        const session = await context.newCDPSession(target);
        attached = session;
        session.on("Page.screencastFrame", (frame) => {
            // Every frame is acked regardless of outcome; an unacked frame stalls the stream, including ones dropped
            // below.
            session.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
            // stopScreencast doesn't block: a frame captured just before pausing/stopping can still arrive after and
            // must be dropped here.
            if (paused || stopped) {
                return;
            }
            // Input since the capture began means this frame is a real response, and with stills off (a phone) none would
            // come to replace it, which left an emulated phone's screen unshown under load: forward it, not drop it as an echo.
            if ((capturing !== undefined || Date.now() < echoUntil) && lastInputAt < captureStartedAt && hooks.sharp?.() !== false) {
                // Dropping a frame still schedules another still to settle the question.
                armStill(session);
                return;
            }
            // Reset quiet detection after real motion.
            quiet = 0;
            lastStill = undefined;
            onFrame({ bytes: Buffer.from(frame.data, "base64"), format: "jpeg" });
            armStill(session);
        });
        // Normalizes the window so client coordinates (VIEW_WIDTH x VIEW_HEIGHT) map 1:1 even for a smaller popup.
        await target.setViewportSize({ width: VIEW_WIDTH, height: VIEW_HEIGHT }).catch(() => {});
        // After the size, which the view's own overrides replace.
        // allow(silent-catch): a page that closed under its binding is followed by the next one, which is dressed then.
        await hooks.bound?.(session, target).catch(() => undefined);
        if (paused) {
            // Bound but silent while hidden; resume's first frame from Chromium is the current surface, so nothing is
            // missed.
            return;
        }
        await session.send("Page.startScreencast", SCREENCAST_OPTIONS);
    };

    const follow = (page: Page): void => {
        page.on("close", () => {
            // Pin dies with the page it pointed at, freeing the fallback below to move the stream.
            if (page === boundTo) {
                pinned = false;
            }
            const back = context.pages().at(-1);
            if (back !== undefined && !stopped) {
                void bind(back).catch(() => {
                    // Fallback page died too; the next `page` event rebinds.
                });
            }
        });
        if (pinned) {
            // User is watching a chosen page; a tab the agent just opened doesn't steal it.
            return;
        }
        void bind(page).catch(() => {
            // Page vanished mid-attach; the next one rebinds.
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
        noteInput: () => {
            lastInputAt = Date.now();
        },
        bind,
        setPaused: async (next) => {
            if (stopped || paused === next) {
                return;
            }
            paused = next;
            clearTimeout(stillTimer);
            // Resuming starts a fresh stream; even an unmoved page needs a fresh still for its first frame.
            echoUntil = 0;
            lastStill = undefined;
            quiet = 0;
            const session = attached;
            if (session === undefined) {
                return;
            }
            // A page gone while hidden is normal, not an error; the close handler already rebound elsewhere.
            await (next ? session.send("Page.stopScreencast") : session.send("Page.startScreencast", SCREENCAST_OPTIONS)).catch(() => {});
        },
        dress: async (change) => {
            dressing += 1;
            try {
                await capturing;
                await (attached === undefined || boundTo === undefined ? undefined : change(attached, boundTo));
                await (attached === undefined || paused || stopped ? undefined : restartScreencast(attached));
            } finally {
                dressing -= 1;
            }
        },
        stop: async () => {
            stopped = true;
            clearTimeout(stillTimer);
            context.off("page", follow);
            if (attached !== undefined && boundTo !== undefined) {
                // allow(silent-catch): a page or browser already gone has nothing left to take off.
                await hooks.unbinding?.(attached, boundTo).catch(() => undefined);
            }
            try {
                await attached?.detach();
            } catch {
                // Page or browser already gone.
            }
            attached = undefined;
        },
    };
};
