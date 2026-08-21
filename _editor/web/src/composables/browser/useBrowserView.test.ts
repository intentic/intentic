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
    private readonly listeners = new Map<string, (event: { data: string }) => void>();
    send(data: string): void {
        this.sent.push(data);
    }
    close(): void {}
    addEventListener(type: string, handler: (event: { data: string }) => void): void {
        this.listeners.set(type, handler);
    }
    // A frame from the daemon, delivered the way the real socket delivers one.
    deliver(message: object): void {
        this.listeners.get(`message`)?.({ data: JSON.stringify(message) });
    }
}

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
    expect(chord.preventDefault).toHaveBeenCalled();
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
