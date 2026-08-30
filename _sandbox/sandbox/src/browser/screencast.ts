import type { BrowserContext, CDPSession, Page } from "playwright";

// The live-browser wire, shared by the two surfaces that show a Chromium the user isn't sitting in front of:
// a connected account's own profile (browser-profile.ts, the owner drives) and the agent's browser view (browser-view.ts, the
// owner watches, and may take the wheel). Both are the same three things: image frames out over CDP's
// screencast, the owner's mouse/keyboard back in over CDP's Input domain, and a rebind that follows popups,
// so they are one module rather than two copies that drift.

// Fixed screencast viewport, the web canvas scales to it. This is the page's LAYOUT size and stays put: it is
// the agent's page, and a reflow because the owner widened a browser window would change what the agent's own
// screenshots and element positions say. Resolution is a separate axis, and lives in the still below.
export const VIEW_WIDTH = 1280;
export const VIEW_HEIGHT = 800;

/* Motion frames: smooth first, but not cheap at the cost of being unreadable. The still below is what makes a
 * settled page sharp, yet a page that keeps moving (a spinner, a carousel, a site mid-sign-up) never settles,
 * and everything the person is trying to read is a motion frame for as long as that lasts. Quality 70 is where
 * JPEG starts smearing small text, which is why watching a busy page read as "blurry" no matter how good the
 * still was. Frames only flow while something is actually moving, so the extra bytes are paid exactly then. */
const MOTION_QUALITY = 82;
// One high-resolution capture this long after the last motion frame. Long enough that a scroll or a page load
// doesn't fire one per frame, short enough to land before the eye has settled on the picture.
const STILL_DELAY_MS = 400;
const STILL_QUALITY = 85;
// Twice the layout viewport. Past that the wire cost stops buying anything a 1280-CSS-px page can show.
const STILL_SCALE = 2;
/* HOW LONG A CAPTURE KEEPS DISTURBING THE PICTURE IT TOOK. Photographing the page at STILL_SCALE makes Chromium
 * re-raster it, and the screencast dutifully encodes that wobble as motion frames arriving behind the still.
 * Left alone they replace the sharp picture with a blurry one AND re-arm the debounce that took it, so a page
 * where nothing whatsoever is happening pulsed sharp-blurry-sharp twice a second forever, flickering, and
 * paying for an encode and a tunnel round trip each time. Frames inside this window belong to our own camera. */
const CAPTURE_ECHO_MS = 250;
/* …AND HOW LONG THAT IS DEPENDS ON THE MACHINE, which is why a constant on its own was wrong.
 *
 * The wobble is not delivered late, each frame reaches us ~10ms after Chromium stamps it, loaded or idle. It is
 * PRODUCED late: the re-raster that our own screenshot triggers takes as long as the box is slow, and it goes on
 * emitting frames for as long as it takes. Idle, the last of them is stamped ~50ms after the capture returns and
 * 250ms covered it with room to spare. On a box running this monorepo's own suites the same burst was measured
 * trailing 300-550ms behind, where a fixed window expires mid-wobble and forwards the tail of our own camera
 * shake as though the page had moved, the blurry frame lands on top of the sharp one, and the flicker this
 * whole mechanism exists to prevent is back exactly when the machine is too busy to hide it.
 *
 * So the window is measured in the only unit that tracks the machine: the capture we just took. The shake is
 * that same raster work being redone by that same processor, so the capture's own cost is the honest estimate of
 * how long it echoes, three times it, against the worst of the measured spread, with the constant above as the
 * floor for a fast box. Being too wide costs nothing a viewer sees: a real change dropped inside the window is
 * re-read by the next capture and arrives sharp instead of blurry, which is what the sweep in
 * screencast.stale.integration.test.ts holds this to. Ceiling at STILL_IDLE_MS below, so that one freak capture
 * on a thrashing box: 5.5 seconds was the worst measured, cannot answer with half a minute of stills only. */
const CAPTURE_ECHO_FACTOR = 3;
/* …EXCEPT THAT A FRAME INSIDE THAT WINDOW IS NOT ALWAYS OURS, and assuming it was is how the view came to lie.
 *
 * The window is our own camera's shake MOST of the time; it is also exactly where the frame showing the result
 * of a click lands, because the click is what ended the quiet that armed the capture. Dropping it silently and
 * scheduling nothing left the person looking at the screen they had already left: they pressed Continue, the
 * page really did move on, and the picture kept the old button sitting there. So they pressed it again, on a
 * button that no longer existed, in a form that had moved a step ahead of what they could see.
 *
 * A dropped frame therefore always buys another look. What keeps that from becoming the old self-feeding loop
 * is that a capture can now tell whether anything moved: WebP of identical pixels at a fixed quality is
 * byte-identical (true of a busy page, not just a blank one), so a still matching the one the client is already
 * showing is proof the page is at rest and there was nothing to miss. */
/* HOW FAST TO KEEP LOOKING once it is at rest. Doubling from STILL_DELAY_MS, capped here. A page that will
 * never move again must not cost a capture every half second for as long as someone leaves the tab open; a
 * change that slipped into a suppression window must not wait forever to be noticed. Backing off to this is
 * both at once, and the common case never gets here at all, because a change that lands OUTSIDE a window (the
 * overwhelming majority) is forwarded the moment it arrives, exactly as before. */
const STILL_IDLE_MS = 5000;

const SCREENCAST_OPTIONS = { format: "jpeg", quality: MOTION_QUALITY, maxWidth: VIEW_WIDTH, maxHeight: VIEW_HEIGHT, everyNthFrame: 1 } as const;

/* One picture on its way to the client, AS BYTES. The format travels with it because the two kinds are encoded
 * differently (see the still below) and the decoder on the far side has to be told which it is.
 *
 * WHY NOT BASE64 IN JSON, which is what this was. CDP hands frames over base64-encoded, so shipping them on as
 * text looked free; it is not. Base64 is a flat 33% on top of a 1280x800 JPEG that is already 150-250 kB, and the
 * client then held each one as a `data:` URL string, so every frame allocated a fresh multi-hundred-kB string in
 * a hot path and left it for the collector. A WebSocket carries binary natively. The decode here costs a memcpy
 * and buys back a third of the wire on the most bandwidth-hungry thing this daemon sends. */
export interface ScreencastFrame {
    readonly bytes: Buffer;
    readonly format: "jpeg" | "webp";
}

/* The format byte a binary frame is prefixed with, so one socket can carry every kind (and, later, coded video)
 * without a parallel JSON message describing what just arrived. SVG is nothing this daemon ever encodes: it is
 * how the recorded demo (_site/demo/src/browser.ts) plays drawn pages down the same wire, which is only possible
 * because the format traveling WITH the frame means the client never assumes one. */
export const FRAME_JPEG = 0;
export const FRAME_WEBP = 1;
export const FRAME_SVG = 2;

// A frame as it goes on the wire: one tag byte, then the image. Shared by both routes so the two surfaces
// cannot disagree about the header the client is about to parse.
export const encodeFrame = (frame: ScreencastFrame): Uint8Array<ArrayBuffer> => {
    const wire = new Uint8Array(frame.bytes.byteLength + 1);
    wire[0] = frame.format === "webp" ? FRAME_WEBP : FRAME_JPEG;
    wire.set(frame.bytes, 1);
    return wire;
};

// Client → server input frames (JSON, mirrored on the web side, the browser can't import this contract package).
export type ScreencastClientMessage =
    /* A POINTER EVENT, WITH THE THREE FIELDS THAT MAKE IT ONE. `x`/`y`/`button` alone describe a click and
     * nothing else, which is how this window came to be unable to drag, to double-click, or to Ctrl-click:
     *
     *   - `buttons` is the DOM bitmask of what is HELD (left 1, right 2, middle 4), and CDP uses the identical
     *     encoding, so it passes straight through. Without it every move is dispatched as `buttons: 0` and the
     *     renderer sees a hover, so a press-move-release selects no text, moves no slider, drags no file and
     *     draws on no canvas — the button may as well not have been down. It is read off the DOM event rather
     *     than tracked here on purpose: a lost `up` (the pointer left the picture, the socket blinked) would
     *     otherwise strand this end believing a button is still down forever.
     *   - `clickCount` is the browser's own `detail`, which is how double-click-to-select-a-word and
     *     triple-click-to-select-a-line reach the page. Hardcoding 1 made both of them a pair of single clicks.
     *   - the modifiers, so Ctrl+click opens in a new tab and Shift+click extends a selection.
     *
     * No `meta`, for the same reason the key frame has none: the Chromium at the far end is a Linux one, and a
     * Mac's ⌘ arrives here already translated to `ctrl` by the client that read it. */
    | {
          readonly type: "mouse";
          readonly action: "move" | "down" | "up" | "wheel";
          readonly x: number;
          readonly y: number;
          // Which button changed, in DOM numbering (0 left, 1 middle, 2 right, 3 back, 4 forward).
          readonly button?: number;
          // Which buttons are held, as a DOM/CDP bitmask. Present on every action, including moves.
          readonly buttons?: number;
          readonly clickCount?: number;
          readonly ctrl?: boolean;
          readonly shift?: boolean;
          readonly alt?: boolean;
          readonly deltaX?: number;
          readonly deltaY?: number;
      }
    | { readonly type: "text"; readonly text: string }
    /* A KEYSTROKE, AND THE CHORD IT MAY BE PART OF. Plain typing never comes through here, it rides `text`
     * above, so a key frame is either one of the control keys a form needs or a shortcut the owner pressed:
     * Ctrl+A, Ctrl+Z, Shift+End. There is no `meta`: the Chromium at the far end is a Linux one, where Cmd
     * means nothing, so a Mac's ⌘ arrives here already translated into `ctrl` by the client that read it. */
    | { readonly type: "key"; readonly key: string; readonly ctrl?: boolean; readonly shift?: boolean; readonly alt?: boolean }
    /* WHAT THE OWNER JUST SELECTED, asked for so it can be put on their own clipboard, answered by the routes
     * with a `selection` frame going the other way. Ctrl+C inside this picture would otherwise copy to the
     * SANDBOX's clipboard, which nothing on their machine can read: the exact mirror of the paste problem the
     * clients solve by bridging their own clipboard in as a `text` frame. */
    | { readonly type: "selection" }
    /* WHICH ENTRY OF A DROP-DOWN THE OWNER PICKED, from the menu the CLIENT drew, see readSelect below for why
     * there is no other way to answer one of these. Applied to whichever <select> the page has focused, which
     * is the same one the `select` frame going the other way described. */
    | { readonly type: "selectOption"; readonly index: number }
    // Stream a specific page instead of whichever the agent opened last, the browser view's tab strip. Pins,
    // so the agent opening a tab no longer moves the picture out from under the user (see `pinned` below).
    | { readonly type: "bind"; readonly pageId: string }
    /* THERE IS NO `go`/`back`/`reload` ANY MORE, and the reason is the whole X-capture design. Those existed
     * because the picture was a page's compositor surface — the browser's own chrome was not in it, so an
     * address bar and three buttons had to be drawn in HTML and wired back to Playwright navigations. The
     * picture is the WINDOW now (videocast.ts), so the real address bar and the real back button are in it, and
     * XTEST clicks them like a person would. See live-view.ts. */
    // The tab went to the background (or the route was left). Nobody is looking, so nothing should be encoded
    // or sent, a browsing agent would otherwise push frames down the tunnel at a hidden <img> indefinitely.
    | { readonly type: "pause" }
    | { readonly type: "resume" }
    | { readonly type: "done" }
    | { readonly type: "ping" };

/* DOM button numbering to CDP's names, indexed rather than branched so back and forward are not silently
 * reported as left clicks. "none" is what a MOVE carries: CDP reads a move that names a button as a button
 * event, and `buttons` below is the field that says what is actually held. */
const CDP_BUTTON = ["none", "left", "middle", "right", "back", "forward"] as const;
const cdpButton = (button: number | undefined): (typeof CDP_BUTTON)[number] => CDP_BUTTON[(button ?? 0) + 1] ?? "left";
// Chromium counts 1, 2 and 3; anything past a triple-click is a triple-click as far as any page is concerned.
const clickCount = (count: number | undefined): number => Math.min(3, Math.max(1, Math.trunc(count ?? 1)));

// CDP's Input domain packs the held modifiers into one integer. Meta is 4 and deliberately never set, see the
// note on the `key` frame. Shared by pointer and keyboard: Shift+click and Shift+End are the same bit.
const CDP_ALT = 1;
const CDP_CTRL = 2;
const CDP_SHIFT = 8;

const cdpModifiers = (held: { readonly ctrl?: boolean; readonly shift?: boolean; readonly alt?: boolean }): number =>
    (held.alt === true ? CDP_ALT : 0) | (held.ctrl === true ? CDP_CTRL : 0) | (held.shift === true ? CDP_SHIFT : 0);

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

/* WHY A CHORD HAS TO ARRIVE AS A REAL KEY EVENT, when ordinary typing does not.
 *
 * Select-all, copy, cut, undo, bold. Chromium calls these editing commands, and the renderer derives them
 * ITSELF from a key event's `code` and virtual key code, not from the character it would have produced. So the
 * table above holds no letters (a letter is text, and text is faster and layout-proof through insertText) while
 * a chord needs one synthesized: Ctrl+A is the KeyA key with the control bit set, and nothing else will do.
 *
 * The rest of the shape is Playwright's own keyboard, copied on purpose, the same `rawKeyDown`, the same
 * fields, because that is the shape Chromium is known to read as a command rather than as a lost keypress. */
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

export type MouseMessage = Extract<ScreencastClientMessage, { type: "mouse" }>;

const dispatchMouse = async (session: CDPSession, message: MouseMessage): Promise<void> => {
    // Held buttons and modifiers ride on EVERY pointer event, wheel included: Ctrl+wheel is zoom, and a wheel
    // mid-drag is a page scrolling under a selection that has to keep growing.
    const modifiers = cdpModifiers(message);
    const buttons = message.buttons ?? 0;
    if (message.action === "wheel") {
        await session.send("Input.dispatchMouseEvent", {
            type: "mouseWheel",
            x: message.x,
            y: message.y,
            modifiers,
            buttons,
            deltaX: message.deltaX ?? 0,
            deltaY: message.deltaY ?? 0,
        });
        return;
    }
    const move = message.action === "move";
    const type = message.action === "down" ? "mousePressed" : message.action === "up" ? "mouseReleased" : "mouseMoved";
    await session.send("Input.dispatchMouseEvent", {
        type,
        x: message.x,
        y: message.y,
        modifiers,
        // A move names no button and carries no count; what it carries is `buttons`, which is what makes it a
        // drag rather than a hover.
        button: move ? "none" : cdpButton(message.button),
        buttons,
        clickCount: move ? 0 : clickCount(message.clickCount),
    });
};

const dispatchKey = async (session: CDPSession, message: Extract<ScreencastClientMessage, { type: "key" }>): Promise<void> => {
    const descriptor = keyDescriptor(message);
    if (descriptor === undefined) {
        return;
    }
    const modifiers = cdpModifiers(message);
    // Shift is the modifier that still produces a character; Ctrl and Alt turn the keystroke into a command,
    // and Chromium only reads it as one when the event carries NO text, hence rawKeyDown for every chord.
    const text = (modifiers & (CDP_CTRL | CDP_ALT)) !== 0 ? undefined : descriptor.text;
    const stroke = { modifiers, key: descriptor.key, code: descriptor.code, windowsVirtualKeyCode: descriptor.vk };
    await session.send("Input.dispatchKeyEvent", {
        ...stroke,
        type: text !== undefined ? "keyDown" : "rawKeyDown",
        ...(text !== undefined ? { text } : {}),
    });
    await session.send("Input.dispatchKeyEvent", { ...stroke, type: "keyUp" });
};

// Forward one input frame to the page the CDP session is attached to. `bind`/`pause`/`resume`/`done`/`ping` are
// conversation-level and belong to the route; everything else is a pointer or a keystroke and lands here.
export const dispatchInput = async (session: CDPSession, message: ScreencastClientMessage): Promise<void> => {
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

/* THE SELECTION, READ OUT OF WHATEVER PART OF THE PAGE HOLDS IT.
 *
 * The far half of the `selection` frame: the owner pressed Ctrl+C over the picture, and the text has to come
 * back here to reach the clipboard on their own machine. Two places have to be asked, and both matter:
 *
 *   - EVERY FRAME, not just the top document. What a person copies out of one of these windows is most often
 *     inside an embedded sign-in, the account name Google shows in its iframe, and a top-frame-only read
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

/* THE ONE CONTROL THE PICTURE CANNOT SHOW, and the reason a date of birth could not be filled in by hand.
 *
 * A <select>'s open list is not part of the page. Chromium draws it as a native menu belonging to the BROWSER,
 * a separate window on the virtual display, and `Page.startScreencast` streams the page's compositor surface,
 * so the list is simply absent from every frame. Clicking the control does focus it and the menu really does
 * open somewhere; the owner just sees nothing happen, and the click they aim at the option they wanted lands on
 * whatever the page has at those coordinates instead. Keyboard was the only way through, and only if you
 * guessed that it was.
 *
 * So the menu is drawn where it can be seen: in the operator's own browser, from the options read out here.
 * Nothing is injected into the page to do it, an overlay of our own in the agent's DOM would be a mutation of
 * the very thing these views exist to observe, visible to the agent's next snapshot. This reads, and the pick
 * that comes back is applied through Playwright's own selectOption, which sets the value the way the frameworks
 * on the far side expect (React tracks its own, and a hand-set .selectedIndex is invisible to it).
 *
 * EVERY FRAME, like readSelection above and for the same reason: these controls are as often inside an embedded
 * form as in the top document. A frame's rect is added back in so the coordinates are the picture's own. */
export interface SelectMenu {
    readonly options: readonly { readonly label: string; readonly disabled: boolean }[];
    readonly selected: number;
    // Where the closed control sits in the streamed viewport, for the client to anchor its menu to.
    readonly rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

export const readSelect = async (page: Page): Promise<SelectMenu | undefined> => {
    for (const frame of page.frames()) {
        const found = await frame
            .evaluate(() => {
                const active = document.activeElement;
                // A `multiple` list renders inline and is already visible and clickable in the picture.
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
        // boundingBox() is already relative to the main frame's viewport, so one hop places any depth of nesting.
        const holder = frame === page.mainFrame() ? undefined : await frame.frameElement().catch(() => undefined);
        // boundingBox answers null for an element with no box at all, which is as good as having no offset.
        const offset = holder === undefined ? undefined : ((await holder.boundingBox().catch(() => undefined)) ?? undefined);
        return offset === undefined ? found : { ...found, rect: { ...found.rect, x: found.rect.x + offset.x, y: found.rect.y + offset.y } };
    }
    return undefined;
};

// Apply what the owner picked to the <select> the page still has focused, the same one readSelect described.
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
        // Playwright's own, rather than a hand-set selectedIndex: it fires input and change the way a real pick
        // does and updates the value tracker React and friends dedupe against.
        await element.selectOption({ index }).catch(() => undefined);
        return;
    }
};

/* WHAT SHAPE THE POINTER SHOULD BE, which the picture by itself can never say.
 *
 * `Page.startScreencast` streams the page's COMPOSITOR SURFACE, and a cursor is not part of it — Chromium draws
 * that on top, in the window, where no frame goes. So the owner's arrow stayed an arrow over every link, every
 * text field, every resize handle and every drag grip in the remote page. Half of "does this thing respond to
 * me" is the pointer changing before the click, and none of it was arriving: the window read as dead even when
 * it was keeping up.
 *
 * The page is ASKED rather than instrumented. `elementFromPoint` and `getComputedStyle` are reads, exactly like
 * readSelection and readSelect above, so nothing is injected into a page the agent is working in and the answer
 * cannot show up in the agent's own next snapshot.
 *
 * SAME-ORIGIN FRAMES ARE WALKED, because the interesting controls are so often inside an embedded sign-in, and
 * `elementFromPoint` on the top document answers `<iframe>` for every one of them. A cross-origin frame refuses
 * `contentDocument`, and its own computed cursor is the honest fallback — an OAuth button that reports `pointer`
 * on the frame is still better than an arrow, and the click lands either way. Bounded depth: a page that nests
 * frames in a cycle must not spin here. */
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

// A cursor keyword long enough to be a `url(...)` with a data URI in it is not one this is going to forward:
// the client maps a keyword onto its own CSS, and an unbounded string from a page is not a keyword.
const CURSOR_MAX = 32;

export const readCursor = async (session: CDPSession, x: number, y: number): Promise<string | undefined> => {
    const result = await session
        .send("Runtime.evaluate", {
            expression: CURSOR_PROBE.replace("__X__", String(Math.round(x))).replace("__Y__", String(Math.round(y))),
            returnByValue: true,
        })
        // Navigated mid-probe, or a page that has no document yet. The next move asks again.
        .catch(() => undefined);
    const value: unknown = result?.result?.value;
    return typeof value === "string" && value !== "" && value.length <= CURSOR_MAX ? value : undefined;
};

/* How often the pointer's shape is re-read while it moves, and why this is not a round trip per move. The probe
 * is fire-and-forget — it never sits in front of the input it followed — and an answer is only SENT when the
 * shape actually changed, so a pointer crossing a paragraph reports once rather than sixty times. 60ms is well
 * under how long a person takes to notice a shape change and well over the cost of one Runtime.evaluate. */
const CURSOR_INTERVAL_MS = 60;

/* One throttled cursor probe per socket, shared by both surfaces so the two cannot drift into different answers
 * for the same gesture. Holds the last reported shape, which is what makes this quiet: the common case is a
 * pointer that has been over the same kind of thing for the last twenty moves. */
export const cursorReporter = (send: (cursor: string) => void): ((session: CDPSession, x: number, y: number) => void) => {
    let reported: string | undefined;
    let probedAt = 0;
    let inFlight = false;
    return (session, x, y) => {
        const now = Date.now();
        // One probe in the air at a time: a tunnel slower than the interval must not queue a probe per move.
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

// A live view of ONE browser context: the CDP session currently streaming, rebound as pages come and go.
// `attached` is what an input frame is dispatched to, so mouse/keyboard follow the page on screen automatically.
export interface Screencast {
    readonly attached: () => CDPSession | undefined;
    /* THE OWNER JUST DID SOMETHING, so the next frame is an answer and not an echo. Called by the routes on
     * every pointer and keystroke they forward, and read by the frame handler below to decide whether a frame
     * inside a suppression window is the page responding or our own camera shaking the picture it took.
     *
     * Without it the two were indistinguishable and the suppressor guessed "shake", which is why taking the
     * wheel felt broken: a click's own repaint was dropped and re-read up to a still-delay later, so every
     * press, every hover and every keystroke paid half a second before anything on screen moved. */
    readonly noteInput: () => void;
    // The page those frames are of, what a navigation acts on and where an address bar reads its text. The
    // session above is the input path; this is the same picture asked about as a page rather than a socket.
    readonly page: () => Page | undefined;
    // Point the stream at another page. `pin` marks the choice as the USER's, which stops the auto-follow below
    // from overriding it; the route passes it for a `bind` frame and omits it for its own popup handling.
    readonly bind: (page: Page, pin?: boolean) => Promise<void>;
    // Stop and restart the flow of frames without losing the binding, what a hidden tab asks for. Distinct
    // from `stop`, which ends the view; a paused screencast still holds its page and its pin.
    readonly setPaused: (paused: boolean) => Promise<void>;
    readonly stop: () => Promise<void>;
}

/* Stream one of a context's pages, following the agent by default.
 *
 * The auto-rebind exists because OAuth buttons ("Continue with Google") open a POPUP window; without following
 * it the popup renders off-screen and the view looks dead. We attach to the newest page and, when it closes,
 * fall back to the opener. The agent's browser wants the same rule for a different reason, a tool call that
 * opens a tab moves the work there, so following the newest page is the default for both surfaces.
 *
 * PINNING is what makes a tab strip possible on top of that. Once the user picks a page, following the agent
 * would be the bug rather than the feature: the picture would jump away from what they chose the moment the
 * agent opened anything. So an explicit bind pins, and only a page CLOSING can move a pinned stream, at which
 * point there is nothing left to be pinned to and falling back beats a frozen last frame. */
export const startScreencast = async (context: BrowserContext, onFrame: (frame: ScreencastFrame) => void): Promise<Screencast> => {
    let attached: CDPSession | undefined;
    let stopped = false;
    let paused = false;
    let pinned = false;
    // The page `attached` is streaming, only needed to tell whether a closing page is the pinned one.
    let boundTo: Page | undefined;
    let stillTimer: NodeJS.Timeout | undefined;
    // Whether a frame arriving now is the page moving or our own still capture shaking it, see CAPTURE_ECHO_MS.
    let capturing = false;
    let echoUntil = 0;
    // When the capture whose echo is being suppressed began, and when the owner last put something into the
    // page. A frame in the window is ours only if nothing was clicked or typed since. See `noteInput`.
    let captureStartedAt = 0;
    let lastInputAt = 0;
    // The sharp frame the client is currently showing, kept to compare the next capture against: same bytes
    // means the page has not moved since, which is the only reliable way to tell an echo from a real change.
    let lastStill: string | undefined;
    // How many captures in a row have found nothing new, the back-off's exponent. See STILL_IDLE_MS.
    let quiet = 0;

    /* THE PICTURE ANYONE ACTUALLY READS IS A STILL ONE. Watching an agent browse is mostly watching a page that
     * is not moving, so the motion stream is tuned for smoothness (1x, quality 70, enough to follow a scroll)
     * and every settle is chased by ONE high-resolution capture that replaces it. Sharpness lands exactly where
     * the eye is, and costs nothing during the motion where it would not have been visible anyway.
     *
     * `scale` is a captureScreenshot argument, which is why this leaves the AGENT'S page alone: raising
     * deviceScaleFactor through Emulation would have got the same pixels, but it is a mutation of the thing we
     * are here to observe, window.devicePixelRatio changes under the agent, srcset picks different assets, and
     * the page's own screenshots stop matching what it saw a tool call ago. webp because captureScreenshot
     * takes it and screencast doesn't: ~40% off the wire at matched quality, on the one frame worth spending on. */
    const still = async (session: CDPSession): Promise<void> => {
        if (stopped || paused || session !== attached) {
            return;
        }
        /* A CLIP IS IN DOCUMENT COORDINATES, NOT VIEWPORT ONES, so the still has to ask the page where it is
         * before it can photograph it. A fixed {0,0} names the top of the DOCUMENT, right only while nothing
         * has scrolled, and Chromium answers a clip that isn't on the composited surface with a BLANK image
         * rather than an error. So every settle after a scroll wiped the picture white and the next motion
         * frame brought it back: the view flickered exactly when someone was reading it. */
        capturing = true;
        const startedAt = Date.now();
        captureStartedAt = startedAt;
        const shot = await session
            .send("Page.getLayoutMetrics")
            .then(({ visualViewport }) =>
                session.send("Page.captureScreenshot", {
                    format: "webp",
                    quality: STILL_QUALITY,
                    clip: { x: visualViewport.pageX, y: visualViewport.pageY, width: VIEW_WIDTH, height: VIEW_HEIGHT, scale: STILL_SCALE },
                }),
            )
            // Navigated, closed, or blocked on a dialog mid-capture, the next motion frame schedules another.
            .catch(() => undefined);
        capturing = false;
        // What the capture cost is what its echo will cost, see CAPTURE_ECHO_FACTOR.
        const echoFor = Math.min(Math.max(CAPTURE_ECHO_MS, (Date.now() - startedAt) * CAPTURE_ECHO_FACTOR), STILL_IDLE_MS);
        echoUntil = Date.now() + echoFor;
        if (shot === undefined || stopped || paused || session !== attached) {
            return;
        }
        if (shot.data === lastStill) {
            // Pixel-for-pixel what the client already has. Nothing moved while we were photographing, so the
            // frames suppressed to take this really were our own, count the confirmation and stop chasing.
            quiet += 1;
            return;
        }
        quiet = 0;
        // Compared as base64 (what CDP hands over) and sent as bytes: the equality test above is the cheap half
        // and runs on every capture, the decode is the expensive half and runs only on the ones worth sending.
        lastStill = shot.data;
        onFrame({ bytes: Buffer.from(shot.data, "base64"), format: "webp" });
    };

    // Every path that wants another sharp reading goes through here, so the back-off is applied in one place.
    const armStill = (session: CDPSession): void => {
        clearTimeout(stillTimer);
        stillTimer = setTimeout(() => void still(session), Math.min(STILL_DELAY_MS * 2 ** quiet, STILL_IDLE_MS));
    };

    const bind = async (target: Page, pin = false): Promise<void> => {
        if (stopped) {
            return;
        }
        pinned ||= pin;
        boundTo = target;
        clearTimeout(stillTimer);
        // A different page's first frames are nobody's echo, however recently we photographed the last one,
        // and nothing about the last page's sharp frame says anything about whether this one is at rest.
        echoUntil = 0;
        lastStill = undefined;
        quiet = 0;
        try {
            await attached?.detach();
        } catch {
            // the previous page may already be gone, ignore
        }
        const session = await context.newCDPSession(target);
        attached = session;
        session.on("Page.screencastFrame", (frame) => {
            // Acked whatever happens to it: an unacked frame stops the stream, including the ones below that
            // are dropped precisely because nothing has changed.
            session.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
            /* SILENCE IS OURS TO KEEP, NOT CHROMIUM'S. `Page.stopScreencast` is a request, not a barrier: a
             * frame it captured a moment earlier is still being encoded on a worker thread, and it arrives
             * afterwards, on a loaded machine, a second or more afterwards. So a paused view went on pushing
             * pictures down the tunnel at a tab nobody was looking at, which is the one thing pausing exists to
             * stop, and a stopped one called back into a route that had already closed its socket.
             *
             * Acked above and dropped here, in that order, because the two halves answer different owners: the
             * ack is Chromium's bookkeeping (an unacked frame leaves a slot in flight and the stream never
             * restarts on resume), the drop is ours. */
            if (paused || stopped) {
                return;
            }
            /* OUR OWN CAMERA SHAKING THE PICTURE IT TOOK — BUT ONLY IF NOBODY TOUCHED ANYTHING.
             *
             * A frame inside the suppression window has two possible authors, and for a long time this could
             * not tell them apart, so it assumed the flattering one: its own still capture. That assumption is
             * right whenever the view is being WATCHED, which is most of the time, and wrong at exactly the
             * moment somebody takes the wheel. The whole point of a click is that the page moves right after
             * it, which puts the frame that proves the click worked squarely inside this window.
             *
             * Dropping it and re-reading later is not a small penalty. The re-read waits a still delay and then
             * pays for a 2560x1600 capture, so every press, every hover, every keystroke went dark for half a
             * second or more — and because interacting keeps arming stills, driving the browser spent most of
             * its time inside a window built for a page nobody was touching. Hovers "slow and unresponsive" and
             * clicks with "no feedback from buttons" were both this, not the network.
             *
             * `lastInputAt` settles it honestly. Input since the capture began means the page is answering a
             * person and the frame goes out AT ONCE, blurry or not: feedback beats sharpness while a hand is on
             * the mouse, and the still that follows the settle sharpens it a moment later anyway. No input means
             * nothing but our own shutter can have moved anything, which is the original case, unchanged. */
            if ((capturing || Date.now() < echoUntil) && lastInputAt < captureStartedAt) {
                // Dropping it is never the last word: look again, and let the capture settle the question.
                armStill(session);
                return;
            }
            /* A frame nobody's camera can account for: the page really moved, so the back-off starts over, and
             * the sharp frame is no longer what the client is looking at. Forgetting it matters, because the
             * comparison below reads `lastStill` as "the picture already on their screen": leave it standing
             * after a motion frame has covered it and the next capture recognises its own last still, calls the
             * page unchanged, and sends nothing, stranding the viewer on the blurry one for good. */
            quiet = 0;
            lastStill = undefined;
            onFrame({ bytes: Buffer.from(frame.data, "base64"), format: "jpeg" });
            armStill(session);
        });
        // Normalize the window so client coords (VIEW_WIDTH x VIEW_HEIGHT) map 1:1 even for a smaller popup.
        await target.setViewportSize({ width: VIEW_WIDTH, height: VIEW_HEIGHT }).catch(() => {});
        if (paused) {
            // Bound but silent: the tab is hidden. `resume` starts the flow, and Chromium's first frame after
            // that is the current surface, so nothing about this page is missed by not streaming it now.
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
                    // the fallback page died too, the next `page` event rebinds
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
            // Coming back is a fresh stream, and its first frame is the surface as it stands, not an echo.
            // That first frame is a motion one, so the sharp reading of it has to be taken again even if the
            // page held perfectly still the whole time the tab was hidden.
            echoUntil = 0;
            lastStill = undefined;
            quiet = 0;
            const session = attached;
            if (session === undefined) {
                return;
            }
            // A page that went away while the tab was hidden is the ordinary case, not an error, the `close`
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
