// @vitest-environment jsdom
//
// WHAT REACHES THE REMOTE PAGE, and — just as much — what does not. The view forwards input only while the user
// has taken control, so every handler here has two answers, and the paste one exists because a sign-in is the
// case where typing is not a substitute: the Chromium being watched keeps its own clipboard inside the sandbox,
// which nothing on the user's machine can write to.
import { expect, test, vi } from "vitest";
import { effectScope, ref } from "vue";

// The ticket mint is an HTTP round trip through the whole sandbox-session stack; the socket's URL is all this
// suite needs from it.
vi.mock(`../sandbox/wsTicket`, () => ({ socketUrl: async () => `wss://sandbox.test/system/browser-view` }));

const { useBrowserView } = await import(`./useBrowserView`);

// A socket that records what the view puts on the wire. Open from the start: this suite is about the handlers,
// not about the connect dance.
class FakeSocket {
    static readonly OPEN = 1;
    readonly readyState = FakeSocket.OPEN;
    readonly sent: string[] = [];
    send(data: string): void {
        this.sent.push(data);
    }
    close(): void {}
    addEventListener(): void {}
}

// A paste as the host browser delivers it — the clipboard answers by MIME type, and only text is asked for.
const pasteOf = (text: string): ClipboardEvent =>
    ({
        clipboardData: { getData: (type: string) => (type === `text/plain` ? text : ``) },
        preventDefault: () => {},
    }) as unknown as ClipboardEvent;

const connected = async (): Promise<{ view: ReturnType<typeof useBrowserView>; wire: () => unknown[] }> => {
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
    return { view, wire: () => sockets[0]!.sent.map((message) => JSON.parse(message) as unknown) };
};

test("a paste from the user's own machine arrives as text the remote page can receive", async () => {
    const { view, wire } = await connected();
    view.driving.value = true;

    view.onPaste(pasteOf(`correct horse battery staple`));
    expect(wire()).toContainEqual({ type: `text`, text: `correct horse battery staple` });

    // Ctrl/Cmd+V itself must stay with the HOST browser — swallowing it is what stops the paste event above
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
