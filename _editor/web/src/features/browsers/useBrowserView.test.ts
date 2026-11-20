// The view forwards input only while the user has taken control, so every handler here has two answers; paste
// exists separately since the remote Chromium's clipboard is inside the sandbox, unreachable from the user's
// machine.
import "@intentic/testing/dom";
import { waitFor, stubGlobal } from "@intentic/testing/bun";
import type { BrowserMediaClientMessage } from "@intentic/sandbox-contract/browser-wire";
import { effectScope, ref } from "vue";
import type { FromWorker, ToWorker } from "../../models/browsers/media/worker/workerWire";

// The ticket mint is an HTTP round trip; only the socket's URL matters to this suite.
const socketUrl = jest.fn(async (): Promise<string | undefined> => `wss://sandbox.test/system/browser-view`);
jest.mock(`../../client/sandbox/streams/wsTicket`, () => ({ socketUrl }));

const { useBrowserView } = await import(`./useBrowserView`);
const { signalConnection } = await import(`../../client/sandbox/useSandbox`);
const { classifyFailure } = await import(`../../client/sandbox/connection`);

// Records what the view puts on the wire and can answer back; open from the start, since this suite is about the
// handlers, not the connect dance.
class FakeSocket {
    static readonly OPEN = 1;
    readonly readyState = FakeSocket.OPEN;
    readonly sent: string[] = [];
    binaryType = `blob`;
    private readonly listeners = new Map<string, (event: { data: string | ArrayBuffer }) => void>();
    send(data: string): void {
        this.sent.push(data);
    }
    close(): void {}
    addEventListener(type: string, handler: (event: { data: string | ArrayBuffer }) => void): void {
        this.listeners.set(type, handler);
    }
    // A message from the daemon, delivered the way the real socket delivers one.
    deliver(message: object): void {
        this.listeners.get(`message`)?.({ data: JSON.stringify(message) });
    }
    // A picture from the daemon, binary: one format byte then the image (the daemon's encodeFrame).
    deliverFrame(bytes: readonly number[]): void {
        this.listeners.get(`message`)?.({ data: new Uint8Array(bytes).buffer });
    }
}

// Sized so the remote viewport maps 1:1 onto it, so a click's coordinates are exactly what's asserted, not
// letterbox arithmetic (viewportCoords has its own suite).
const stage = (): HTMLElement => ({ getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 800 }) }) as unknown as HTMLElement;

// A pointer event as the host reports it: only the fields the view reads, defaulted to nothing held/no
// modifier/no repeat, so each test states just its own part.
const mouse = (over: Partial<MouseEvent> = {}): MouseEvent =>
    ({
        clientX: 100,
        clientY: 200,
        button: 0,
        buttons: 0,
        detail: 0,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        altKey: false,
        preventDefault: jest.fn(),
        ...over,
    }) as unknown as MouseEvent;

// A keydown as the host reports it: only the fields the view reads.
const press = (key: string, held: { ctrl?: boolean; shift?: boolean } = {}): KeyboardEvent =>
    ({
        key,
        code: ``,
        ctrlKey: held.ctrl === true,
        metaKey: false,
        shiftKey: held.shift === true,
        altKey: false,
        isComposing: false,
        keyCode: 0,
        getModifierState: () => false,
        preventDefault: jest.fn(),
        stopPropagation: jest.fn(),
    }) as unknown as KeyboardEvent;

// A paste as the host browser delivers it: the clipboard answers by MIME type, and only text is asked for.
const pasteOf = (text: string): ClipboardEvent =>
    ({
        clipboardData: { getData: (type: string) => (type === `text/plain` ? text : ``) },
        preventDefault: () => {},
    }) as unknown as ClipboardEvent;

const connected = async (): Promise<{
    view: ReturnType<typeof useBrowserView>;
    wire: () => unknown[];
    socket: () => FakeSocket;
}> => {
    const sockets: FakeSocket[] = [];
    stubGlobal(
        `WebSocket`,
        class extends FakeSocket {
            constructor() {
                super();
                sockets.push(this);
            }
        },
    );
    const view = effectScope().run(() => useBrowserView(ref(`browser-abc12345`)))!;
    // connect() awaits the ticket before it constructs anything.
    await waitFor(() => expect(sockets).toHaveLength(1));
    // Geometry comes off the wire, so a test needing readable coordinates must say what the picture is, as the daemon
    // does. `stage()` matches this size, so the letterbox arithmetic is the identity and a click lands where aimed.
    sockets[0]!.deliver({ type: `ready`, kind: `frames`, width: 1280, height: 800 });
    return { view, wire: () => sockets[0]!.sent.map((message) => JSON.parse(message) as unknown), socket: () => sockets[0]! };
};

test("a view whose socket couldn't be authorized says why and asks again, rather than hanging on reconnecting", async () => {
    socketUrl.mockRejectedValueOnce(new Error(`The sandbox did not finish signing in within 10 seconds.`));
    const warn = jest.spyOn(console, `warn`).mockImplementation(() => undefined);
    const sockets: FakeSocket[] = [];
    stubGlobal(
        `WebSocket`,
        class extends FakeSocket {
            constructor() {
                super();
                sockets.push(this);
            }
        },
    );
    const view = effectScope().run(() => useBrowserView(ref(`browser-abc12345`)))!;
    await waitFor(() =>
        expect(view.status.value).toBe(`Couldn't authorize the browser view (The sandbox did not finish signing in within 10 seconds.); retrying.`),
    );
    // The retry waits out the backoff's one-second floor; five is a hang bound, not a latency.
    await waitFor(() => expect(sockets).toHaveLength(1), { timeout: 5_000 });
    warn.mockRestore();
});

// The ladder climbs to half a minute; a view still waiting out a rung when the sandbox's event stream answers again
// must not stay dark for the rest of it.
test("a view waiting to retry dials again the moment the sandbox is reachable, not when its rung runs out", async () => {
    socketUrl.mockRejectedValueOnce(new Error(`The sandbox is restarting.`));
    const warn = jest.spyOn(console, `warn`).mockImplementation(() => undefined);
    const sockets: FakeSocket[] = [];
    stubGlobal(
        `WebSocket`,
        class extends FakeSocket {
            constructor() {
                super();
                sockets.push(this);
            }
        },
    );
    signalConnection({ kind: `failed`, failure: classifyFailure({ message: `tunnel down` }), at: Date.now() });
    const view = effectScope().run(() => useBrowserView(ref(`browser-abc12345`)))!;
    await waitFor(() => expect(view.status.value).toBe(`Couldn't authorize the browser view (The sandbox is restarting.); retrying.`));

    signalConnection({ kind: `frame`, at: Date.now() });

    // The ladder's floor is a second, so a socket inside half of one came from the sandbox coming back.
    await waitFor(() => expect(sockets).toHaveLength(1), { timeout: 500 });
    warn.mockRestore();
});

test("a paste from the user's own machine arrives as text the remote page can receive", async () => {
    const { view, wire } = await connected();
    view.driving.value = true;

    view.onPaste(pasteOf(`correct horse battery staple`));
    expect(wire()).toContainEqual({ type: `text`, text: `correct horse battery staple` });

    // Ctrl/Cmd+V must stay with the host: swallowing it would stop the paste event from ever firing, and the remote
    // clipboard it would reach isn't the user's.
    const chord = { key: `v`, ctrlKey: true, metaKey: false, altKey: false, preventDefault: jest.fn() } as unknown as KeyboardEvent;
    view.onKeyDown(chord);
    expect(chord.preventDefault).not.toHaveBeenCalled();
});

test("nothing is pasted into a browser the user is only watching", async () => {
    const { view, wire } = await connected();
    view.onPaste(pasteOf(`not mine to type`));
    expect(wire()).toHaveLength(0);
});

test("a clipboard with no text in it sends no keystroke at all", async () => {
    const { view, wire } = await connected();
    view.driving.value = true;
    // An image or file: a real paste event with nothing this wire can carry.
    view.onPaste(pasteOf(``));
    expect(wire().filter((message) => (message as { type?: string }).type === `text`)).toHaveLength(0);
});

// Ctrl+A used to reach the app around the picture, selecting everything instead of the field being looked at. Both
// halves asserted: it reaches the page with its modifier, and the host never sees it.
test("select-all reaches the page instead of the app around it", async () => {
    const { view, wire } = await connected();
    view.driving.value = true;

    const chord = press(`a`, { ctrl: true });
    view.onKeyDown(chord);
    expect(wire()).toContainEqual({ type: `key`, key: `a`, ctrl: true });
    expect(chord.preventDefault).toHaveBeenCalledTimes(1);
});

test("nothing is typed into a browser the user is only watching", async () => {
    const { view, wire } = await connected();
    const chord = press(`a`, { ctrl: true });
    view.onKeyDown(chord);
    expect(wire()).toHaveLength(0);
    // Stays the host's, so a watcher's own select-all still works as it always did.
    expect(chord.preventDefault).not.toHaveBeenCalled();
});

// The remote clipboard lives in the sandbox, so copy has to cross to the user's own. Order matters: the selection
// is read back before the chord is let through, since the same path also carries Ctrl+X, which would delete the
// text first.
test("copying puts the remote page's selection on the user's own clipboard, then lets the chord through", async () => {
    const writeText = jest.fn(async () => {});
    Object.defineProperty(navigator, `clipboard`, { value: { writeText }, configurable: true });
    const { view, wire, socket } = await connected();
    view.driving.value = true;

    view.onKeyDown(press(`x`, { ctrl: true }));
    expect(wire()).toContainEqual({ type: `selection` });
    // Nothing cut yet: the page still holds the text this is about to read.
    expect(wire()).not.toContainEqual({ type: `key`, key: `x`, ctrl: true });

    socket().deliver({ type: `selection`, text: `one-time 314159` });
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`one-time 314159`));
    await waitFor(() => expect(wire()).toContainEqual({ type: `key`, key: `x`, ctrl: true }));
});

// Chromium decides a drag from the buttons currently held, not the last press; a move reporting none is a move
// with the mouse up, so press-move-release selected and dragged nothing.
test("a move made with the button down says so, which is what makes it a drag", async () => {
    const { view, wire } = await connected();
    view.driving.value = true;
    const surface = stage();

    view.onMouseDown(mouse({ buttons: 1, detail: 1 }), surface);
    view.onMouseMove(mouse({ clientX: 900, buttons: 1 }), surface);

    expect(wire()).toContainEqual({ type: `mouse`, action: `move`, x: 900, y: 200, buttons: 1 });
});

// Double/triple-click-to-select are the browser's own count reaching the page; sending 1 every time turned them
// into unrelated single clicks.
test("a double click arrives as one, not as two single clicks", async () => {
    const { view, wire } = await connected();
    view.driving.value = true;

    view.onMouseDown(mouse({ buttons: 1, detail: 2 }), stage());

    expect(wire()).toContainEqual({ type: `mouse`, action: `down`, x: 100, y: 200, button: 0, buttons: 1, clickCount: 2 });
});

// Ctrl+click opens a link in a new tab, Shift+click extends a selection; neither reached the page before.
test("a modifier held over the picture reaches the page with the click", async () => {
    const { view, wire } = await connected();
    view.driving.value = true;

    view.onMouseDown(mouse({ buttons: 1, detail: 1, ctrlKey: true, shiftKey: true }), stage());

    expect(wire()).toContainEqual({
        type: `mouse`,
        action: `down`,
        x: 100,
        y: 200,
        button: 0,
        buttons: 1,
        clickCount: 1,
        ctrl: true,
        shift: true,
    });
});

// A Mac's Cmd means nothing to the Linux Chromium at the far end, so it travels as the ctrl it stands for, the same
// translation keyIntent makes for the keyboard.
test("a Mac's command key travels as the ctrl it stands for", async () => {
    const { view, wire } = await connected();
    view.driving.value = true;

    view.onMouseDown(mouse({ buttons: 1, detail: 1, metaKey: true }), stage());

    expect(wire()).toContainEqual({ type: `mouse`, action: `down`, x: 100, y: 200, button: 0, buttons: 1, clickCount: 1, ctrl: true });
});

// Watching stays watching: a pointer over a page the agent is filling in changes nothing.
test("no pointer event reaches a browser the user is only watching", async () => {
    const { view, wire } = await connected();
    const surface = stage();

    view.onMouseDown(mouse({ buttons: 1, detail: 1 }), surface);
    view.onMouseMove(mouse({ buttons: 1 }), surface);
    view.onMouseUp(mouse(), surface);

    expect(wire()).toHaveLength(0);
});

// A picture is binary now, one format byte then the image, since base64 in JSON cost a third of the wire and a
// fresh giant string per frame. The tag byte lets one socket carry a cheap jpeg while moving and a sharp webp once
// settled.
test("a frame arrives as bytes, and its tag byte decides how it is read", async () => {
    const made: string[] = [];
    stubGlobal(`URL`, {
        createObjectURL: (blob: Blob) => {
            made.push(blob.type);
            return `blob:frame-${made.length}`;
        },
        revokeObjectURL: () => {},
    });
    const { view, socket } = await connected();
    expect(view.frame.value).toBeUndefined();

    socket().deliverFrame([1, 0x52, 0x49]);
    expect(view.frame.value).toBe(`blob:frame-1`);
    expect(made).toEqual([`image/webp`]);

    socket().deliverFrame([0, 0xff, 0xd8]);
    expect(view.frame.value).toBe(`blob:frame-2`);
    expect(made).toEqual([`image/webp`, `image/jpeg`]);
});

// The video path a browser with its own display sends; `ready` carries both codec (read from the daemon's own
// stream) and geometry (the whole window, not just the page), since assuming either would misplace every click.
test("a video stream is announced by its ready, and the geometry it brings is what clicks are measured against", async () => {
    const decoded: { codec?: string; chunks: { key: boolean; bytes: number[] }[] } = { chunks: [] };
    stubGlobal(
        `VideoDecoder`,
        class {
            state = `configured`;
            configure(config: { codec: string }): void {
                decoded.codec = config.codec;
            }
            decode(chunk: { type: string; data: Uint8Array }): void {
                decoded.chunks.push({ key: chunk.type === `key`, bytes: [...chunk.data] });
            }
            close(): void {}
        },
    );
    stubGlobal(
        `EncodedVideoChunk`,
        class {
            constructor(readonly init: { type: string; data: Uint8Array }) {
                return init as never;
            }
        },
    );
    const { view, socket } = await connected();

    socket().deliver({ type: `ready`, kind: `video`, width: 1280, height: 880, codec: `avc1.42C028` });
    expect(view.kind.value).toBe(`video`);
    expect([view.viewWidth.value, view.viewHeight.value]).toEqual([1280, 880]);
    expect(decoded.codec).toBe(`avc1.42C028`);

    // Tag 3 is a keyframe, 4 a delta, and the tag byte itself is stripped before the decoder sees the frame.
    socket().deliverFrame([3, 0, 0, 0, 1, 9]);
    socket().deliverFrame([4, 0, 0, 0, 1, 9]);
    expect(decoded.chunks).toEqual([
        { key: true, bytes: [0, 0, 0, 1, 9] },
        { key: false, bytes: [0, 0, 0, 1, 9] },
    ]);
    // Nothing goes to the <img> on this path: the picture is in the canvas.
    expect(view.frame.value).toBeUndefined();
});

// No decoder means no fallback; saying so beats a permanently black rectangle that looks like a stopped browser.
test("a client that cannot decode video says so instead of showing nothing", async () => {
    stubGlobal(`VideoDecoder`, undefined);
    const { view, socket } = await connected();

    socket().deliver({ type: `ready`, kind: `video`, width: 1280, height: 880, codec: `avc1.42C028` });

    expect(view.status.value).not.toBe(`Waiting for the first frame…`);
    expect(view.frame.value).toBeUndefined();
});

// No frame carries pointer shape: a screencast is just the compositor surface, and Chromium draws the cursor in
// its own window. Without this the arrow never changed over a link.
test("the pointer takes the shape the remote page would give it", async () => {
    const { view, socket } = await connected();
    expect(view.cursor.value).toBe(`default`);

    socket().deliver({ type: `cursor`, cursor: `pointer` });
    expect(view.cursor.value).toBe(`pointer`);
});

// A copy over nothing selected must not leave stale text on the clipboard, and must still let the page have its
// chord, in case the site binds Ctrl+C itself.
test("copying an empty selection writes nothing", async () => {
    const writeText = jest.fn(async () => {});
    Object.defineProperty(navigator, `clipboard`, { value: { writeText }, configurable: true });
    const { view, wire, socket } = await connected();
    view.driving.value = true;

    view.onKeyDown(press(`c`, { ctrl: true }));
    socket().deliver({ type: `selection`, text: `` });
    await waitFor(() => expect(wire()).toContainEqual({ type: `key`, key: `c`, ctrl: true }));
    expect(writeText).not.toHaveBeenCalled();
});

// The chrome is the pane's own: its buttons speak to the daemon in verbs, never as keystrokes into a picture of a
// toolbar. What each verb puts on the wire is the contract screencast.ts's ScreencastClientMessage reads.
test("the chrome's verbs go to the daemon as messages", async () => {
    const { view, wire } = await connected();

    view.navigate(`https://example.com/`);
    view.navigate(`https://example.net/`, `p3`);
    view.back();
    view.forward();
    view.reload();
    view.newTab();
    view.newTab(`https://example.org/`);
    view.closeTab(`p2`);
    view.answerDialog(true, `hi`);
    view.answerDialog(false);

    expect(wire()).toEqual([
        { type: `navigate`, url: `https://example.com/` },
        { type: `navigate`, url: `https://example.net/`, pageId: `p3` },
        { type: `back` },
        { type: `forward` },
        { type: `reload` },
        { type: `newTab` },
        { type: `newTab`, url: `https://example.org/` },
        { type: `closeTab`, pageId: `p2` },
        { type: `dialog`, accept: true, text: `hi` },
        { type: `dialog`, accept: false },
    ]);
});

// Ctrl+T over the picture used to be the host's tab; now it is the browser's, answered by the pane's own strip, and
// nothing about it travels as a keystroke.
test("a browser chord is handed to the pane as a command, not sent to the page", async () => {
    const { view, wire } = await connected();
    view.driving.value = true;
    const commands: string[] = [];

    const chord = press(`t`, { ctrl: true });
    view.onKeyDown(chord, (command) => commands.push(command));

    expect(commands).toEqual([`newTab`]);
    expect(wire()).toHaveLength(0);
    expect(chord.preventDefault).toHaveBeenCalledTimes(1);
});

// Chromium's find bar is browser chrome, so its keystrokes have to land on the display rather than the page; the
// view marks them raw from the chord that opened the bar until the Escape that closes it, or a click.
test("keystrokes go raw to the display while the find bar is open", async () => {
    const { view, wire } = await connected();
    view.driving.value = true;

    view.find();
    view.onKeyDown(press(`a`));
    view.onKeyDown(press(`Enter`));
    view.onKeyDown(press(`Escape`));
    view.onKeyDown(press(`b`));

    expect(wire()).toEqual([
        { type: `key`, key: `f`, ctrl: true, raw: true },
        { type: `text`, text: `a`, raw: true },
        { type: `key`, key: `Enter`, raw: true },
        { type: `key`, key: `Escape`, raw: true },
        { type: `text`, text: `b` },
    ]);
});

// The box the picture gets is what the daemon sizes the page to; asked once it holds still, and not again for the
// same box, since every ask restarts the encoder.
test("the picture box's size is asked of the daemon once it settles, and only when it changes", async () => {
    const { view, wire, socket } = await connected();
    socket().deliver({ type: `ready`, kind: `video`, width: 1280, height: 880, scale: 1, codec: `avc1.42C028` });

    view.requestSize(900.4, 600.2);
    view.requestSize(900.4, 600.2);
    await waitFor(() => expect(wire()).toContainEqual({ type: `resize`, width: 900, height: 600 }));
    expect(wire().filter((message) => (message as { type?: string }).type === `resize`)).toHaveLength(1);

    // A fresh `ready` for a stream the daemon restarted is not a new box; nothing is asked again.
    socket().deliver({ type: `ready`, kind: `video`, width: 900, height: 600, scale: 1, codec: `avc1.42C028` });
    expect(wire().filter((message) => (message as { type?: string }).type === `resize`)).toHaveLength(1);
});

test("a page framed as a phone is sized by the phone, and back to itself is sized by the box again", async () => {
    const { view, wire, socket } = await connected();
    socket().deliver({ type: `ready`, kind: `video`, width: 1280, height: 800, scale: 1, codec: `avc1.42C028` });
    const resizes = (): unknown[] => wire().filter((message) => (message as { type?: string }).type === `resize`);
    const phone = { width: 393, height: 852, mobile: true, userAgent: `iPhone` };

    view.emulate(phone);
    view.emulate({ ...phone });
    expect(wire().filter((message) => (message as { type?: string }).type === `emulate`)).toEqual([{ type: `emulate`, device: phone }]);

    // The box moving under a phone asks nothing: the device decides the picture's size.
    view.requestSize(900, 600);
    await new Promise((settle) => setTimeout(settle, 300));
    expect(resizes()).toHaveLength(0);

    view.emulate(undefined);
    expect(wire()).toContainEqual({ type: `emulate` });
    expect(resizes()).toEqual([{ type: `resize`, width: 900, height: 600 }]);
});

test("a picture nobody can see is paused, and resumed the moment it can be", async () => {
    const sockets: FakeSocket[] = [];
    stubGlobal(
        `WebSocket`,
        class extends FakeSocket {
            constructor() {
                super();
                sockets.push(this);
            }
        },
    );
    const visible = ref(true);
    effectScope().run(() => useBrowserView(ref(`browser-abc12345`), { visible }));
    await waitFor(() => expect(sockets).toHaveLength(1));
    const wire = (): unknown[] => sockets[0]!.sent.map((message) => JSON.parse(message) as unknown);

    visible.value = false;
    await waitFor(() => expect(wire().at(-1)).toEqual({ type: `pause` }));
    visible.value = true;
    await waitFor(() => expect(wire().at(-1)).toEqual({ type: `resume` }));
});

// On the video path a webp is the settled page's sharp still, laid over the canvas; it must never reach the <img>
// the frames path uses, which would show it beside the video.
test("a still on the video path goes to the canvas, not the img", async () => {
    stubGlobal(
        `VideoDecoder`,
        class {
            state = `configured`;
            configure(): void {}
            decode(): void {}
            close(): void {}
        },
    );
    const { view, socket } = await connected();
    socket().deliver({ type: `ready`, kind: `video`, width: 1280, height: 880, scale: 1, codec: `avc1.42C028` });

    socket().deliverFrame([1, 0x52, 0x49]);

    expect(view.frame.value).toBeUndefined();
});

// The pane says how long the picture has been on its way (LiveBrowser), so the view keeps when that wait began: one wait
// from the connect through the first frame, over as a picture lands, and never a clock beside a reason there will be none.
test("a view keeps one wait from connecting to its first picture, and none once it says why there won't be one", async () => {
    stubGlobal(`URL`, { createObjectURL: () => `blob:frame`, revokeObjectURL: () => {} });
    const { view, socket } = await connected();
    expect(view.waitingSince.value).toEqual(expect.any(Number));
    expect(view.status.value).toBe(`Waiting for the first frame…`);

    socket().deliverFrame([1, 0x52, 0x49]);
    expect(view.waitingSince.value).toBeUndefined();

    stubGlobal(`VideoDecoder`, undefined);
    socket().deliver({ type: `ready`, kind: `video`, width: 1280, height: 880, codec: `avc1.42C028` });
    expect(view.waitingSince.value).toBeUndefined();
});

// The window whole, as its socket sends it on every change: what the strip and the address bar draw from once it comes,
// since the browsers list it otherwise reads trails it by up to a second.
const windowState = (name: string, front: string, seq: number) => ({
    type: `state`,
    session: { name, seq, label: `x`, server: `web`, running: true, activityAt: 0, pages: [{ id: front, url: `https://example.com/`, active: true }] },
});

test("the window's own state is held as it arrives, and a copy of any other window is not taken for it", async () => {
    const { view, socket } = await connected();
    expect(view.session.value).toBeUndefined();
    socket().deliver(windowState(`browser-abc12345`, `p2`, 7));
    await waitFor(() => expect(view.session.value?.pages[0]?.id).toBe(`p2`));
    socket().deliver(windowState(`browser-other111`, `p9`, 8));
    socket().deliver({ type: `state`, session: { name: `browser-abc12345` } });
    socket().deliver(windowState(`browser-abc12345`, `p3`, 9));
    await waitFor(() => expect(view.session.value?.pages[0]?.id).toBe(`p3`));
    expect(view.session.value?.seq).toBe(9);
});

// A trackpad sends many small steps; each used to become a whole 53 px notch or nothing. They reach the page at their
// size now, summed over a frame, in the picture's own pixels.
test("a trackpad's small scroll steps reach the page whole, one message a frame", async () => {
    const { view, wire } = await connected();
    view.driving.value = true;
    for (const deltaY of [0.4, 0.75, 1.1]) {
        view.onWheel(new WheelEvent(`wheel`, { clientX: 300, clientY: 400, deltaY, cancelable: true }), stage());
    }
    // A mouse wheel in lines (Firefox) is Chromium's own 40 px a line.
    await waitFor(() => expect(wire()).toContainEqual({ type: `mouse`, action: `wheel`, x: 300, y: 400, buttons: 0, deltaX: 0, deltaY: 2.25 }));
    view.onWheel(new WheelEvent(`wheel`, { clientX: 300, clientY: 400, deltaY: 3, deltaMode: 1, ctrlKey: true, cancelable: true }), stage());
    await waitFor(() =>
        expect(wire()).toContainEqual({ type: `mouse`, action: `wheel`, x: 300, y: 400, buttons: 0, deltaX: 0, deltaY: 120, ctrl: true }),
    );
});

test("nothing scrolls a browser the user is only watching, and the wheel stays the host's", async () => {
    const { view, wire } = await connected();
    const event = new WheelEvent(`wheel`, { clientX: 300, clientY: 400, deltaY: 100, cancelable: true });
    view.onWheel(event, stage());
    expect(event.defaultPrevented).toBe(false);
    expect(wire()).toHaveLength(0);
});

// Focus leaving mid-drag (a click on the address bar, another window) used to leave the remote button down, so the next
// move dragged.
test("the picture losing the keyboard lets go of a held button", async () => {
    const { view, wire } = await connected();
    view.driving.value = true;
    view.onMouseDown(mouse({ button: 0, buttons: 1, detail: 1 }), stage());
    view.releaseInput();
    expect(wire().at(-1)).toEqual({ type: `mouse`, action: `up`, x: 100, y: 200, button: 0, buttons: 0 });
});

test("handing the wheel back lets go of a held button too", async () => {
    const { view, wire } = await connected();
    view.driving.value = true;
    view.onMouseDown(mouse({ button: 2, buttons: 2, detail: 1 }), stage());
    view.driving.value = false;
    await waitFor(() => expect(wire().at(-1)).toEqual({ type: `mouse`, action: `up`, x: 100, y: 200, button: 2, buttons: 0 }));
});

// The browser zooms itself, so the page reflows as it would under a local Ctrl+=.
test("zooming the page is Chromium's own chord on the display", async () => {
    const { view, wire } = await connected();
    view.zoomPage(`in`);
    view.zoomPage(`out`);
    view.zoomPage(`reset`);
    expect(wire().slice(-3)).toEqual([
        { type: `key`, key: `=`, ctrl: true, raw: true },
        { type: `key`, key: `-`, ctrl: true, raw: true },
        { type: `key`, key: `0`, ctrl: true, raw: true },
    ]);
});

test("a finger's tap is a click where it landed", async () => {
    const { view, wire } = await connected();
    view.driving.value = true;
    const touch = (type: string) => new PointerEvent(type, { pointerId: 7, pointerType: `touch`, clientX: 640, clientY: 400, cancelable: true });
    view.onTouch(`down`, touch(`pointerdown`), stage(), stage());
    view.onTouch(`up`, touch(`pointerup`), stage(), stage());
    expect(wire().slice(-3)).toEqual([
        { type: `mouse`, action: `move`, x: 640, y: 400, buttons: 0 },
        { type: `mouse`, action: `down`, x: 640, y: 400, button: 0, buttons: 1, clickCount: 1 },
        { type: `mouse`, action: `up`, x: 640, y: 400, button: 0, buttons: 0, clickCount: 1 },
    ]);
});

// An IME's commit, an emoji from the panel and dictation arrive as text in the field, never as a keydown that names them.
test("text an input method commits reaches the page once, inserted", async () => {
    const { view, wire } = await connected();
    view.driving.value = true;
    view.onKeyDown(press(`Process`));
    view.onCompositionEnd(new CompositionEvent(`compositionend`, { data: `日本語` }));
    view.onBeforeInput(new InputEvent(`beforeinput`, { inputType: `insertText`, data: `🎉`, cancelable: true }));
    expect(wire()).toEqual([
        { type: `text`, text: `日本語` },
        { type: `text`, text: `🎉` },
    ]);
});

// The real URL, before a test above stands in for its object URLs: the media path resolves its worker's script with it.
const RealUrl = URL;

// The decode worker the media path starts, as the page sees one: what it was told, and a way to answer.
class FakeWorker {
    static made: FakeWorker[] = [];
    readonly posted: ToWorker[] = [];
    private listener: ((event: { data: FromWorker }) => void) | undefined;
    constructor() {
        FakeWorker.made.push(this);
    }
    postMessage(message: ToWorker): void {
        this.posted.push(message);
    }
    addEventListener(_type: string, listener: (event: { data: FromWorker }) => void): void {
        this.listener = listener;
    }
    terminate(): void {}
    say(message: FromWorker): void {
        this.listener?.({ data: message });
    }
    sent(): BrowserMediaClientMessage[] {
        return this.posted.flatMap((message) => (message.type === `send` ? [message.message] : []));
    }
}

test("where castd serves the window, its picture and the person's input move to the media socket", async () => {
    FakeWorker.made = [];
    stubGlobal(`URL`, RealUrl);
    stubGlobal(`Worker`, FakeWorker);
    // What the page asks of the browser before it starts a decode worker: that one could draw and decode there.
    stubGlobal(`OffscreenCanvas`, function OffscreenCanvas() {});
    stubGlobal(`VideoDecoder`, function VideoDecoder() {});
    const { view, wire, socket } = await connected();
    socket().deliver({ type: `media`, path: `/system/browser-media/cast-1`, token: `t.m`, expiresAt: Date.now() + 60_000 });
    await waitFor(() => expect(FakeWorker.made[0]?.posted.some((message) => message.type === `dial`)).toBe(true));
    const worker = FakeWorker.made[0]!;
    const dial = worker.posted.find((message) => message.type === `dial`);
    expect(dial).toMatchObject({ url: `wss://sandbox.test/system/browser-media/cast-1?token=t.m&lossless=1` });
    const id = dial?.type === `dial` ? dial.socket : 0;
    worker.say({ type: `open`, socket: id });
    worker.say({ type: `text`, socket: id, data: JSON.stringify({ type: `hello`, width: 1280, height: 800, scale: 1, codec: `avc1.42c033`, readOnly: false }) });
    expect(view.kind.value).toBe(`media`);

    view.driving.value = true;
    const before = wire().length;
    view.onMouseDown(mouse({ buttons: 1 }), stage());
    view.find();
    expect(worker.sent().slice(-2)).toEqual([
        { type: `mouse`, action: `down`, x: 100, y: 200, button: 0, buttons: 1 },
        { type: `key`, key: `f`, ctrl: true },
    ]);
    // Nothing of it went on the window's own socket.
    expect(wire().slice(before)).toEqual([]);
});
