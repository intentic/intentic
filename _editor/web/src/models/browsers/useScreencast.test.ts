// The part every live picture shares (the agent's browser, the sandbox's desktop, a sign-in window): it pauses the
// stream while nobody can see it, throttles pointer moves to one display frame, asks a size at once for a one-step
// change and once a drag holds still, only when it changes, asks a fresh stream when its decoder loses this one, and
// says so when the browser cannot decode video. Each case reads what went on the wire.
import "@intentic/testing/dom";
import { stubGlobal, unstubAllGlobals, waitFor } from "@intentic/testing/bun";
import { effectScope, type EffectScope, ref } from "vue";
import { pointerFrame } from "./pointerFrame";

const { MOVE_THROTTLE_MS, RESIZE_DEBOUNCE_MS, useScreencast } = await import(`./useScreencast`);
const { receiveDesktopShown } = await import(`../../workbench/window/onScreen`);

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
    binary(data: ArrayBuffer): void {
        this.listeners.get(`message`)?.({ data });
    }
}

const picture = document.createElement(`canvas`);
picture.getBoundingClientRect = () => new DOMRect(0, 0, 1280, 800);
const at = (clientX: number): MouseEvent => new MouseEvent(`mousemove`, { clientX, clientY: 10 });

const scopes: EffectScope[] = [];
afterEach(() => {
    for (const scope of scopes.splice(0)) {
        scope.stop();
    }
    receiveDesktopShown(true);
    unstubAllGlobals();
});

// A decoder that takes whatever it is given: this suite is about what goes on the wire, not what paints.
const decodes = (): void =>
    stubGlobal(
        `VideoDecoder`,
        class {
            state = `configured`;
            configure(): void {}
            decode(): void {}
            close(): void {}
        },
    );

const opened = async (visible = ref(true), said: { unsupported: number } = { unsupported: 0 }) => {
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
    const cast = scope.run(() => {
        const made = useScreencast({
            mint: async () => `wss://sandbox.test/system/screencast`,
            pointer: pointerFrame,
            visible,
            onUnsupported: () => {
                said.unsupported += 1;
            },
            onVideoError: () => undefined,
            socket: { onOpen: (): void => made.syncVisibility() },
        });
        made.live.connect();
        return made;
    })!;
    await waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]!.open();
    return { cast, socket: sockets[0]!, wire: (): readonly object[] => sockets[0]!.sent.map((message) => JSON.parse(message)) };
};

test("a picture nobody can see is paused, whether its tab is behind or its window is in the tray", async () => {
    const visible = ref(true);
    const { wire } = await opened(visible);
    expect(wire().at(-1)).toEqual({ type: `resume` });
    visible.value = false;
    await waitFor(() => expect(wire().at(-1)).toEqual({ type: `pause` }));
    visible.value = true;
    await waitFor(() => expect(wire().at(-1)).toEqual({ type: `resume` }));
    // The desktop app says the window is hidden, though its document still reads visible.
    receiveDesktopShown(false);
    await waitFor(() => expect(wire().at(-1)).toEqual({ type: `pause` }));
});

test("pointer moves inside one display frame are dropped, presses never are", async () => {
    const now = jest.spyOn(Date, `now`).mockReturnValue(10_000);
    const { cast } = await opened();
    expect(cast.pointerAt(`move`, at(10), picture)).toMatchObject({ type: `mouse`, action: `move`, x: 10 });
    now.mockReturnValue(10_000 + MOVE_THROTTLE_MS - 1);
    expect(cast.pointerAt(`move`, at(20), picture)).toBeUndefined();
    expect(cast.pointerAt(`down`, at(20), picture)).toMatchObject({ type: `mouse`, action: `down`, x: 20 });
    now.mockReturnValue(10_000 + MOVE_THROTTLE_MS);
    expect(cast.pointerAt(`move`, at(30), picture)).toMatchObject({ type: `mouse`, action: `move`, x: 30 });
    now.mockRestore();
});

const resizesOn = (wire: () => readonly object[]) => (): readonly object[] =>
    wire().filter((message) => `type` in message && message.type === `resize`);

test("a box is asked once the picture is video, and the same box is not asked twice", async () => {
    decodes();
    jest.useFakeTimers();
    try {
        const { cast, socket, wire } = await opened();
        const resizes = resizesOn(wire);
        cast.requestSize(900, 600);
        jest.advanceTimersByTime(RESIZE_DEBOUNCE_MS);
        // No `ready` yet: nothing to size.
        expect(resizes()).toEqual([]);
        socket.deliver({ type: `ready`, width: 900, height: 600, codec: `avc1.42C028` });
        expect(resizes()).toEqual([{ type: `resize`, width: 900, height: 600 }]);
        cast.requestSize(900, 600);
        cast.requestSize(900.2, 600);
        jest.advanceTimersByTime(RESIZE_DEBOUNCE_MS);
        expect(resizes()).toHaveLength(1);
    } finally {
        jest.useRealTimers();
    }
});

// A panel opened or closed is one step, and every ms it waits the picture stands at the old size; a drag is many, and
// each one asked would restart the encoder.
test("a box that held still is asked at once, one that keeps changing once it holds still", async () => {
    decodes();
    jest.useFakeTimers();
    const now = jest.spyOn(Date, `now`).mockReturnValue(10_000);
    try {
        const { cast, socket, wire } = await opened();
        const resizes = resizesOn(wire);
        cast.requestSize(900, 600);
        socket.deliver({ type: `ready`, width: 900, height: 600, codec: `avc1.42C028` });
        expect(resizes()).toHaveLength(1);

        now.mockReturnValue(20_000);
        cast.requestSize(1400, 600);
        expect(resizes().at(-1)).toEqual({ type: `resize`, width: 1400, height: 600 });

        // The same box moving again straight after: a drag, asked only once it holds still.
        now.mockReturnValue(20_050);
        cast.requestSize(1300, 600);
        now.mockReturnValue(20_100);
        cast.requestSize(1200, 600);
        expect(resizes()).toHaveLength(2);
        jest.advanceTimersByTime(RESIZE_DEBOUNCE_MS);
        expect(resizes()).toHaveLength(3);
        expect(resizes().at(-1)).toEqual({ type: `resize`, width: 1200, height: 600 });
    } finally {
        now.mockRestore();
        jest.useRealTimers();
    }
});

// A decode error closes the decoder for good; waiting for the next keyframe left the picture frozen, since only a fresh
// stream's `ready` builds a new one.
test("a decoder that refuses a frame asks for a fresh stream", async () => {
    stubGlobal(
        `VideoDecoder`,
        class {
            state = `configured`;
            configure(): void {}
            decode(): void {
                throw new Error(`refused`);
            }
            close(): void {}
        },
    );
    stubGlobal(
        `EncodedVideoChunk`,
        class {
            constructor(readonly init: object) {}
        },
    );
    const { socket, wire } = await opened();
    socket.deliver({ type: `ready`, width: 900, height: 600, codec: `avc1.42C028` });
    // A keyframe, tag 3, as the daemon sends it.
    socket.binary(new Uint8Array([3, 0, 0, 0, 1, 9]).buffer);
    expect(wire().filter((message) => `type` in message && message.type === `keyframe`)).toHaveLength(1);
});

test("a browser that cannot decode video says so rather than showing an empty box", async () => {
    const said = { unsupported: 0 };
    const { socket, cast } = await opened(ref(true), said);
    stubGlobal(`VideoDecoder`, undefined);
    socket.deliver({ type: `ready`, width: 1280, height: 800, codec: `avc1.42C028` });
    expect(said.unsupported).toBe(1);
    expect(cast.kind.value).toBe(`video`);
});
