// The desktop view sends nothing to the desktop until the owner takes over, says so to the daemon when they do, and
// shows the hold only for as long as the daemon keeps it. Each case reads what went on the wire.
import "@intentic/testing/dom";
import { stubGlobal, waitFor } from "@intentic/testing/bun";
import { effectScope, type EffectScope, ref } from "vue";

// The ticket mint is an HTTP round trip; only the socket's URL matters to this suite.
const socketUrl = jest.fn(async (): Promise<string | undefined> => `wss://sandbox.test/system/desktop-view`);
jest.mock(`../sandbox/session/wsTicket`, () => ({ socketUrl }));

const { HOLD_MS, useDesktopView } = await import(`./useDesktopView`);
const { signalConnection } = await import(`../../client/sandbox/useSandbox`);
const { classifyFailure } = await import(`../../client/sandbox/connection`);

// Records what the view puts on the wire, and plays the daemon's side: opening, answering, closing.
class FakeSocket {
    static readonly OPEN = 1;
    readyState = 0;
    readonly sent: string[] = [];
    binaryType = `blob`;
    private readonly listeners = new Map<string, (event: { data?: string | ArrayBuffer; code?: number }) => void>();
    send(data: string): void {
        this.sent.push(data);
    }
    close(): void {}
    addEventListener(type: string, handler: (event: { data?: string | ArrayBuffer; code?: number }) => void): void {
        this.listeners.set(type, handler);
    }
    open(): void {
        this.readyState = FakeSocket.OPEN;
        this.listeners.get(`open`)?.({});
    }
    deliver(message: object): void {
        this.listeners.get(`message`)?.({ data: JSON.stringify(message) });
    }
    deliverFrame(bytes: readonly number[]): void {
        this.listeners.get(`message`)?.({ data: new Uint8Array(bytes).buffer });
    }
    drop(code: number): void {
        this.readyState = 3;
        this.listeners.get(`close`)?.({ code });
    }
}

// The picture at the desktop's own size, so a click's coordinates are the asserted ones (desktopInput has the letterbox).
const picture = document.createElement(`canvas`);
picture.getBoundingClientRect = () => new DOMRect(0, 0, 1280, 800);
const pointerAt = (clientX: number, clientY: number, button = 0): MouseEvent => new MouseEvent(`pointerdown`, { clientX, clientY, button, detail: 1 });
// Cancelable, so whether the view kept the keystroke from the host reads off `defaultPrevented`.
const press = (key: string): KeyboardEvent => new KeyboardEvent(`keydown`, { key, cancelable: true });

// Every view a case opens is torn down after it, so no socket or retry of one case lands in the next.
const scopes: EffectScope[] = [];
afterEach(() => {
    for (const scope of scopes.splice(0)) {
        scope.stop();
    }
});

const opened = async (
    options: Parameters<typeof useDesktopView>[1] = {},
): Promise<{
    view: ReturnType<typeof useDesktopView>;
    sockets: FakeSocket[];
    wire: () => readonly object[];
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
    const scope = effectScope();
    scopes.push(scope);
    const view = scope.run(() => useDesktopView(ref(`sbx-a`), options))!;
    // connect() awaits the ticket before it constructs anything.
    await waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]!.open();
    sockets[0]!.deliver({ type: `ready`, kind: `video`, width: 1280, height: 800, scale: 1, codec: `avc1.42C028` });
    return { view, sockets, wire: (): readonly object[] => sockets.at(-1)!.sent.map((message) => JSON.parse(message)) };
};

test("dials the desktop's own route and tells it whether anyone is looking", async () => {
    const { wire } = await opened();
    expect(socketUrl).toHaveBeenCalledWith(`/system/desktop-view`);
    expect(wire()).toEqual([{ type: `resume` }]);
});

test("one window's tab dials that window, and ends when the daemon says it has closed", async () => {
    const { view, wire, sockets } = await opened({ window: `0x1a00003` });
    expect(socketUrl).toHaveBeenLastCalledWith(`/system/desktop-view`, { window: `0x1a00003` });

    view.takeOver();
    sockets[0]!.deliver({ type: `gone` });

    expect(view.status.value).toEqual({ kind: `gone` });
    expect(view.driving.value).toBe(false);
    // Nothing more goes to a window that is not there.
    view.onKeyDown(press(`a`));
    expect(wire().at(-1)).toEqual({ type: `control`, driving: true });
});

test("out of sight, the picture pauses and a hold taken here is handed back", async () => {
    const visible = ref(true);
    const { view, wire } = await opened({ visible });
    view.takeOver();

    visible.value = false;
    await waitFor(() => expect(wire().at(-1)).toEqual({ type: `control`, driving: false }));
    expect(wire().slice(-2)).toEqual([{ type: `pause` }, { type: `control`, driving: false }]);
    expect(view.driving.value).toBe(false);

    visible.value = true;
    await waitFor(() => expect(wire().at(-1)).toEqual({ type: `resume` }));
});

test("a watcher's clicks and keys never reach the desktop", async () => {
    const { view, wire } = await opened();
    const key = press(`a`);

    view.onPointer(`down`, pointerAt(10, 10), picture);
    view.onKeyDown(key);

    expect(wire()).toEqual([{ type: `resume` }]);
    // The host keeps a watcher's keystrokes.
    expect(key.defaultPrevented).toBe(false);
});

test("taking over says so to the daemon, then sends the owner's hands in the desktop's pixels", async () => {
    const { view, wire } = await opened();

    view.takeOver();
    view.onPointer(`down`, pointerAt(640, 400), picture);
    view.onPointer(`up`, pointerAt(640, 400), picture);
    view.onKeyDown(press(`h`));
    view.onKeyDown(press(`Enter`));
    view.handBack();
    view.onKeyDown(press(`i`));

    expect(wire()).toEqual([
        { type: `resume` },
        { type: `control`, driving: true },
        { type: `mouse`, action: `down`, x: 640, y: 400, button: 0 },
        { type: `mouse`, action: `up`, x: 640, y: 400, button: 0 },
        { type: `text`, text: `h` },
        { type: `key`, key: `Enter` },
        { type: `control`, driving: false },
    ]);
});

test("a paste while driving types the owner's own clipboard", async () => {
    const { view, wire } = await opened();
    view.takeOver();
    // jsdom has no ClipboardEvent or DataTransfer: a cancelable paste event with the one member the view reads.
    const paste = new Event(`paste`, { cancelable: true });
    Object.defineProperty(paste, `clipboardData`, { value: { getData: (type: string) => (type === `text/plain` ? `ls -la\n` : ``) } });

    // SAFETY: onPaste reads only `clipboardData.getData` and `preventDefault`, both defined on this event above.
    view.onPaste(paste as ClipboardEvent);

    expect(wire().at(-1)).toEqual({ type: `text`, text: `ls -la\n` });
    expect(paste.defaultPrevented).toBe(true);
});

// The daemon announces a hold when it starts and never when it lapses, 20 s after the owner's last input.
test("the hold shows while the daemon keeps it, renews with each input, and lapses on the daemon's clock", async () => {
    const { view, sockets } = await opened();
    view.takeOver();
    jest.useFakeTimers();
    try {
        sockets[0]!.deliver({ type: `held`, owner: true });
        expect(view.held.value).toBe(true);

        jest.advanceTimersByTime(HOLD_MS - 1000);
        view.onKeyDown(press(`x`));
        jest.advanceTimersByTime(HOLD_MS - 1);
        expect(view.held.value).toBe(true);

        jest.advanceTimersByTime(1);
        expect(view.held.value).toBe(false);
    } finally {
        jest.useRealTimers();
    }
    sockets[0]!.deliver({ type: `held`, owner: true });
    sockets[0]!.deliver({ type: `held`, owner: false });
    expect(view.held.value).toBe(false);
});

// A drop hands the desktop back on the daemon's side; an owner still driving would otherwise click into nothing.
test("a reconnect while driving takes the desktop again", async () => {
    const { view, sockets, wire } = await opened();
    view.takeOver();

    sockets[0]!.drop(1006);
    expect(view.status.value).toEqual({ kind: `reconnecting` });
    // The retry waits out the backoff's one-second floor; five is a hang bound, not a latency.
    await waitFor(() => expect(sockets).toHaveLength(2), { timeout: 5_000 });
    sockets[1]!.open();

    expect(view.driving.value).toBe(true);
    expect(wire()).toEqual([{ type: `resume` }, { type: `control`, driving: true }]);
});

test("a desktop that could not start says why and is not dialled again", async () => {
    const { view, sockets } = await opened();

    sockets[0]!.deliver({ type: `error`, message: `The desktop could not start: Xvfb is not installed` });
    sockets[0]!.drop(1011);

    expect(view.status.value).toEqual({ kind: `failed`, detail: `The desktop could not start: Xvfb is not installed` });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(sockets).toHaveLength(1);
});

test("a reader the daemon refuses is told so rather than retried", async () => {
    const { view, sockets } = await opened();

    sockets[0]!.drop(1008);

    expect(view.status.value).toEqual({ kind: `refused` });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(sockets).toHaveLength(1);
});

test("the first keyframe clears the status, and the tag byte never reaches the decoder", async () => {
    const decoded: { key: boolean; bytes: number[] }[] = [];
    stubGlobal(
        `VideoDecoder`,
        class {
            state = `configured`;
            configure(): void {}
            decode(chunk: { type: string; data: Uint8Array }): void {
                decoded.push({ key: chunk.type === `key`, bytes: [...chunk.data] });
            }
            close(): void {}
        },
    );
    stubGlobal(
        `EncodedVideoChunk`,
        class {
            readonly type: string;
            readonly data: Uint8Array;
            constructor(init: { type: string; data: Uint8Array }) {
                this.type = init.type;
                this.data = init.data;
            }
        },
    );
    const { view, sockets } = await opened();
    expect(view.status.value).toEqual({ kind: `waiting` });

    sockets[0]!.deliverFrame([3, 0, 0, 0, 1, 9]);

    expect(view.status.value).toBeUndefined();
    expect(decoded).toEqual([{ key: true, bytes: [0, 0, 0, 1, 9] }]);
});

test("a client that cannot decode video says so instead of showing a black rectangle", async () => {
    stubGlobal(`VideoDecoder`, undefined);
    const { view } = await opened();
    expect(view.status.value).toEqual({ kind: `unsupported` });
});

// The ladder climbs to half a minute; a view still waiting out a rung when the sandbox's event stream answers again
// must not stay dark for the rest of it.
test("a dropped view dials again the moment the sandbox is reachable, not when its rung runs out", async () => {
    const { sockets } = await opened();
    signalConnection({ kind: `failed`, failure: classifyFailure({ message: `tunnel down` }), at: Date.now() });
    sockets[0]!.drop(1006);

    signalConnection({ kind: `frame`, at: Date.now() });

    // The ladder's floor is a second, so a socket inside half of one came from the sandbox coming back.
    await waitFor(() => expect(sockets).toHaveLength(2), { timeout: 500 });
});
