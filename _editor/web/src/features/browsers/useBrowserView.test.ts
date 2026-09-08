// @vitest-environment jsdom
// The view forwards input only while the user has taken control, so every handler here has two answers; paste
// exists separately since the remote Chromium's clipboard is inside the sandbox, unreachable from the user's
// machine.
import { expect, test, vi } from "vitest";
import { effectScope, ref } from "vue";

// The ticket mint is an HTTP round trip; only the socket's URL matters to this suite.
vi.mock(`../sandbox/client/wsTicket`, () => ({ socketUrl: async () => `wss://sandbox.test/system/browser-view` }));

const { useBrowserView } = await import(`./useBrowserView`);

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
        preventDefault: vi.fn(),
        ...over,
    }) as unknown as MouseEvent;

// A keydown as the host reports it: only the fields the view reads.
const press = (key: string, held: { ctrl?: boolean; shift?: boolean } = {}): KeyboardEvent =>
    ({
        key,
        ctrlKey: held.ctrl === true,
        metaKey: false,
        shiftKey: held.shift === true,
        altKey: false,
        preventDefault: vi.fn(),
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
    vi.stubGlobal(
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
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    // Geometry comes off the wire, so a test needing readable coordinates must say what the picture is, as the daemon
    // does. `stage()` matches this size, so the letterbox arithmetic is the identity and a click lands where aimed.
    sockets[0]!.deliver({ type: `ready`, kind: `frames`, width: 1280, height: 800 });
    return { view, wire: () => sockets[0]!.sent.map((message) => JSON.parse(message) as unknown), socket: () => sockets[0]! };
};

test("a paste from the user's own machine arrives as text the remote page can receive", async () => {
    const { view, wire } = await connected();
    view.driving.value = true;

    view.onPaste(pasteOf(`correct horse battery staple`));
    expect(wire()).toContainEqual({ type: `text`, text: `correct horse battery staple` });

    // Ctrl/Cmd+V must stay with the host: swallowing it would stop the paste event from ever firing, and the remote
    // clipboard it would reach isn't the user's.
    const chord = { key: `v`, ctrlKey: true, metaKey: false, altKey: false, preventDefault: vi.fn() } as unknown as KeyboardEvent;
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
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, `clipboard`, { value: { writeText }, configurable: true });
    const { view, wire, socket } = await connected();
    view.driving.value = true;

    view.onKeyDown(press(`x`, { ctrl: true }));
    expect(wire()).toContainEqual({ type: `selection` });
    // Nothing cut yet: the page still holds the text this is about to read.
    expect(wire()).not.toContainEqual({ type: `key`, key: `x`, ctrl: true });

    socket().deliver({ type: `selection`, text: `one-time 314159` });
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(`one-time 314159`));
    await vi.waitFor(() => expect(wire()).toContainEqual({ type: `key`, key: `x`, ctrl: true }));
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
    vi.stubGlobal(`URL`, {
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
    vi.stubGlobal(
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
    vi.stubGlobal(
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
    vi.stubGlobal(`VideoDecoder`, undefined);
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
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, `clipboard`, { value: { writeText }, configurable: true });
    const { view, wire, socket } = await connected();
    view.driving.value = true;

    view.onKeyDown(press(`c`, { ctrl: true }));
    socket().deliver({ type: `selection`, text: `` });
    await vi.waitFor(() => expect(wire()).toContainEqual({ type: `key`, key: `c`, ctrl: true }));
    expect(writeText).not.toHaveBeenCalled();
});
