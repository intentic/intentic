// @vitest-environment jsdom
//
// WHAT REACHES THE REMOTE PAGE, and (just as much) what does not. The view forwards input only while the user
// has taken control, so every handler here has two answers, and the paste one exists because a sign-in is the
// case where typing is not a substitute: the Chromium being watched keeps its own clipboard inside the sandbox,
// which nothing on the user's machine can write to.
import { expect, test, vi } from "vitest";
import { effectScope, ref } from "vue";

// The ticket mint is an HTTP round trip through the whole sandbox-session stack; the socket's URL is all this
// suite needs from it.
vi.mock(`../sandbox/wsTicket`, () => ({ socketUrl: async () => `wss://sandbox.test/system/browser-view` }));

const { useBrowserView } = await import(`./useBrowserView`);

// A socket that records what the view puts on the wire, and can answer back. Open from the start: this suite is
// about the handlers, not about the connect dance.
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
    // A PICTURE from the daemon, which is binary: one format byte then the image (the daemon's encodeFrame).
    deliverFrame(bytes: readonly number[]): void {
        this.listeners.get(`message`)?.({ data: new Uint8Array(bytes).buffer });
    }
}

// The picture surface, sized so the remote viewport maps onto it 1:1 and a click's coordinates are the ones
// asserted below rather than the output of the letterbox arithmetic (viewportCoords has its own suite).
const stage = (): HTMLElement => ({ getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 800 }) }) as unknown as HTMLElement;

// A pointer event as the host browser reports it: only the fields the view reads, defaulted to "nothing held,
// no modifier, not a repeat click" so each test states just the part it is about.
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

// A keydown as the host browser reports it: only the fields the view reads.
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
    /* THE GEOMETRY COMES OFF THE WIRE, so a test that wants coordinates it can read has to say what the picture
     * is — exactly as the daemon does before it sends one. The two paths have different shapes (the whole
     * window on video, the page alone on frames), which is why nothing assumes either. `stage()` below is this
     * same size, so the letterbox arithmetic is the identity and a click lands where it was aimed. */
    sockets[0]!.deliver({ type: `ready`, kind: `frames`, width: 1280, height: 800 });
    return { view, wire: () => sockets[0]!.sent.map((message) => JSON.parse(message) as unknown), socket: () => sockets[0]! };
};

test("a paste from the user's own machine arrives as text the remote page can receive", async () => {
    const { view, wire } = await connected();
    view.driving.value = true;

    view.onPaste(pasteOf(`correct horse battery staple`));
    expect(wire()).toContainEqual({ type: `text`, text: `correct horse battery staple` });

    // Ctrl/Cmd+V itself must stay with the HOST browser: swallowing it is what stops the paste event above
    // from ever being generated, and the remote clipboard it would reach is not the user's.
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
    // An image or a file: real paste events, with nothing this wire can carry.
    view.onPaste(pasteOf(``));
    expect(wire().filter((message) => (message as { type?: string }).type === `text`)).toHaveLength(0);
});

/* THE CHORD THAT USED TO ESCAPE. Ctrl+A reached the app AROUND the picture, where it selected the whole of
 * Intentic rather than the field being looked at: the giveaway that the view had the user's attention and not
 * their keyboard. Both halves are asserted: it goes on the wire WITH its modifier, and the host never sees it. */
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
    // And it stays the host's, so a watcher's own select-all still works the way it always did.
    expect(chord.preventDefault).not.toHaveBeenCalled();
});

/* COPY HAS TO CROSS THE GAP. The remote Chromium's clipboard lives in the sandbox, so a copy that only reached
 * it is one the user can never paste anywhere. The ORDER is the load-bearing part: the selection is read back
 * before the chord is allowed through, because the same path carries Ctrl+X, which would otherwise delete the
 * text on its way to being read. */
test("copying puts the remote page's selection on the user's own clipboard, then lets the chord through", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, `clipboard`, { value: { writeText }, configurable: true });
    const { view, wire, socket } = await connected();
    view.driving.value = true;

    view.onKeyDown(press(`x`, { ctrl: true }));
    expect(wire()).toContainEqual({ type: `selection` });
    // Nothing has been cut yet: the page is still holding the text this is about to read.
    expect(wire()).not.toContainEqual({ type: `key`, key: `x`, ctrl: true });

    socket().deliver({ type: `selection`, text: `one-time 314159` });
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(`one-time 314159`));
    await vi.waitFor(() => expect(wire()).toContainEqual({ type: `key`, key: `x`, ctrl: true }));
});

/* THE FIELD THAT MADE A DRAG A DRAG, and whose absence made every one of them a hover.
 *
 * Chromium decides whether a move is part of a drag from the buttons currently HELD, not from whatever the last
 * press said. A move that reports none is a move with the mouse up, so press-move-release selected no text,
 * moved no slider and drew on no canvas — the whole gesture was delivered as a click and a wander. */
test("a move made with the button down says so, which is what makes it a drag", async () => {
    const { view, wire } = await connected();
    view.driving.value = true;
    const surface = stage();

    view.onMouseDown(mouse({ buttons: 1, detail: 1 }), surface);
    view.onMouseMove(mouse({ clientX: 900, buttons: 1 }), surface);

    expect(wire()).toContainEqual({ type: `mouse`, action: `move`, x: 900, y: 200, buttons: 1 });
});

// Double-click-to-select-a-word and triple-click-to-select-a-line are the browser's own count reaching the page.
// Sending 1 every time turned both into a series of unrelated single clicks.
test("a double click arrives as one, not as two single clicks", async () => {
    const { view, wire } = await connected();
    view.driving.value = true;

    view.onMouseDown(mouse({ buttons: 1, detail: 2 }), stage());

    expect(wire()).toContainEqual({ type: `mouse`, action: `down`, x: 100, y: 200, button: 0, buttons: 1, clickCount: 2 });
});

// Ctrl+click opens a link in a new tab, Shift+click extends a selection. Neither reached the page at all.
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

// A Mac's ⌘ means nothing to the Linux Chromium at the far end, so it travels as the ctrl it stands for — the
// same translation keyIntent makes for the keyboard half.
test("a Mac's command key travels as the ctrl it stands for", async () => {
    const { view, wire } = await connected();
    view.driving.value = true;

    view.onMouseDown(mouse({ buttons: 1, detail: 1, metaKey: true }), stage());

    expect(wire()).toContainEqual({ type: `mouse`, action: `down`, x: 100, y: 200, button: 0, buttons: 1, clickCount: 1, ctrl: true });
});

// Watching must stay watching: a pointer over a page the agent is filling in changes nothing about it.
test("no pointer event reaches a browser the user is only watching", async () => {
    const { view, wire } = await connected();
    const surface = stage();

    view.onMouseDown(mouse({ buttons: 1, detail: 1 }), surface);
    view.onMouseMove(mouse({ buttons: 1 }), surface);
    view.onMouseUp(mouse(), surface);

    expect(wire()).toHaveLength(0);
});

/* A PICTURE IS BINARY NOW, one format byte then the image, because base64 inside JSON cost a third of the wire
 * and a fresh multi-hundred-kilobyte string per frame. The tag byte is what lets one socket carry both a cheap
 * jpeg while the page moves and a sharp webp once it settles. */
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

/* THE VIDEO PATH, which is what a browser with a display of its own actually sends. `ready` is what selects it,
 * and it carries the geometry AND the codec — the codec because the daemon reads it out of its own stream
 * rather than agreeing it in advance, and the geometry because the video is the whole WINDOW where a frame is
 * the page alone. A client that assumed either would put every click in the wrong place. */
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

// A browser with no decoder cannot show this, and there is no second implementation to fall back to. Saying so
// beats a permanently black rectangle that looks like a browser which stopped painting.
test("a client that cannot decode video says so instead of showing nothing", async () => {
    vi.stubGlobal(`VideoDecoder`, undefined);
    const { view, socket } = await connected();

    socket().deliver({ type: `ready`, kind: `video`, width: 1280, height: 880, codec: `avc1.42C028` });

    expect(view.status.value).toContain(`can't play the live view`);
});

/* THE SHAPE THE POINTER TAKES, which no frame can carry: a screencast is the page's compositor surface, and
 * Chromium draws the cursor above it, in the window. Without this the arrow stayed an arrow over every link. */
test("the pointer takes the shape the remote page would give it", async () => {
    const { view, socket } = await connected();
    expect(view.cursor.value).toBe(`default`);

    socket().deliver({ type: `cursor`, cursor: `pointer` });
    expect(view.cursor.value).toBe(`pointer`);
});

// A copy over a page with nothing selected must not leave stale text on the clipboard, and must still let the
// page have its chord, in case the site binds Ctrl+C itself.
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
