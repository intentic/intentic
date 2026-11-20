// The decode worker, run here on fakes of everything it touches (decodeSeams.ts): castd's socket, WebCodecs and the
// canvas. What is read is what castd would see (acks, keyframe asks, pings) and what the person would (draws, and what
// the page is told).
import "@intentic/testing/dom";
import type { BrowserMediaServerMessage } from "@intentic/sandbox-contract/browser-wire";
import { decodeCore } from "./decodeCore";
import type {
    ChunkLike,
    Drawable,
    FrameLike,
    Painter,
    SocketLike,
    StillPicture,
    Surface,
    VideoDecoderInitLike,
    VideoDecoderLike,
} from "./decodeSeams";
import { type MediaHeader, writeMediaMessage } from "../mediaHeader";
import type { FromWorker } from "./workerWire";

class FakeSocket implements SocketLike {
    binaryType: BinaryType = `blob`;
    readyState = 0;
    readonly sent: Record<string, unknown>[] = [];
    readonly listeners = new Map<string, (event: { data: string | ArrayBuffer; code: number; reason: string }) => void>();
    send(data: string): void {
        // SAFETY: the worker sends only JSON objects, browser-wire's BrowserMediaClientMessage.
        this.sent.push(JSON.parse(data) as Record<string, unknown>);
    }
    close(): void {
        this.readyState = 3;
    }
    addEventListener(type: string, listener: (event: { data: string | ArrayBuffer; code: number; reason: string }) => void): void {
        this.listeners.set(type, listener);
    }
    open(): void {
        this.readyState = 1;
        this.listeners.get(`open`)?.({ data: ``, code: 0, reason: `` });
    }
    say(message: BrowserMediaServerMessage): void {
        this.listeners.get(`message`)?.({ data: JSON.stringify(message), code: 0, reason: `` });
    }
    picture(header: Partial<MediaHeader>): void {
        const whole = {
            kind: `video`,
            key: false,
            refine: false,
            id: 1,
            captureMs: 0,
            stripeTop: 0,
            stripeIndex: 0,
            stripeCount: 1,
            ...header,
        } as const;
        this.listeners.get(`message`)?.({
            data: writeMediaMessage({ ...whole, kind: `video` }, new Uint8Array([0, 0, 0, 1])).buffer,
            code: 0,
            reason: ``,
        });
    }
    of(type: string): Record<string, unknown>[] {
        return this.sent.filter((message) => message[`type`] === type);
    }
}

class FakeDecoder implements VideoDecoderLike {
    state: CodecState = `unconfigured`;
    readonly chunks: ChunkLike[] = [];
    constructor(readonly init: VideoDecoderInitLike) {}
    configure(): void {
        this.state = `configured`;
    }
    decode(chunk: ChunkLike): void {
        this.chunks.push(chunk);
    }
    close(): void {
        this.state = `closed`;
    }
    // The decoder hands back its oldest chunk as a frame.
    emit(): FrameLike & { closed: boolean } {
        const chunk = this.chunks.shift();
        const frame = { timestamp: chunk?.timestamp ?? -1, closed: false, close: () => (frame.closed = true) };
        this.init.output(frame);
        return frame;
    }
    fail(name = `EncodingError`): void {
        this.state = `closed`;
        this.init.error(new DOMException(`decode failed`, name));
    }
}

interface Draw {
    readonly image: Drawable;
    readonly x: number;
    readonly y: number;
}

const surface = (): Surface & { readonly draws: Draw[] } => {
    const draws: Draw[] = [];
    const painter: Painter = { drawImage: (image: Drawable, x: number, y: number) => draws.push({ image, x, y }) };
    return { width: 300, height: 150, draws, getContext: () => painter };
};

const harness = () => {
    let now = 1000;
    const posted: FromWorker[] = [];
    const sockets: FakeSocket[] = [];
    const decoders: FakeDecoder[] = [];
    const timers: { ms: number; run: () => void }[] = [];
    const stills: StillPicture[] = [];
    const core = decodeCore({
        post: (message) => posted.push(message),
        dial: () => {
            const socket = new FakeSocket();
            sockets.push(socket);
            return socket;
        },
        videoDecoder: (init) => {
            const decoder = new FakeDecoder(init);
            decoders.push(decoder);
            return decoder;
        },
        audioDecoder: () => undefined,
        videoChunk: (init) => ({ type: init.type, timestamp: init.timestamp }),
        audioChunk: () => {
            throw new Error(`no sound in this suite`);
        },
        surface: () => surface(),
        snapshot: async (canvas) => {
            const still = document.createElement(`canvas`);
            [still.width, still.height] = [canvas.width, canvas.height];
            const picture: StillPicture = Object.assign(still, { close: () => undefined });
            stills.push(picture);
            return picture;
        },
        edge: () => `rgb(255 255 255)`,
        now: () => now,
        every: (ms, run) => {
            const timer = { ms, run };
            timers.push(timer);
            return () => timers.splice(timers.indexOf(timer), 1);
        },
    });
    const canvas = surface();
    core.receive({ type: `canvas`, canvas });
    core.receive({ type: `dial`, socket: 1, url: `wss://sandbox/system/browser-media/cast-1?token=t`, transport: false });
    const socket = sockets[0]!;
    socket.open();
    return {
        core,
        canvas,
        socket,
        decoders,
        posted,
        stills,
        advance: (ms: number) => (now += ms),
        // The worker's own clock: every timer due at `ms`'s period runs once.
        tick: (ms: number) => timers.filter((timer) => timer.ms === ms).forEach((timer) => timer.run()),
        hello: (width = 2560, height = 1600) => socket.say({ type: `hello`, width, height, scale: 2, codec: `avc1.42c033`, readOnly: false }),
    };
};

it("tells the page the socket opened, and measures the round trip off its own pings", () => {
    const { socket, posted, advance, core } = harness();
    expect(posted).toContainEqual({ type: `open`, socket: 1 });
    const [ping] = socket.of(`ping`);
    advance(12);
    socket.say({ type: `pong`, t: Number(ping?.[`t`]) });
    // A pong for a ping this side never sent changes nothing.
    socket.say({ type: `pong`, t: 5 });
    core.receive({ type: `stats`, on: true });
    expect(posted.at(-1)).toMatchObject({ type: `stats`, stats: { rttMs: 12 } });
});

it("draws a whole frame at the picture's own pixels, and acks it once with its decode time", () => {
    const { socket, canvas, decoders, posted, advance, hello } = harness();
    hello();
    socket.picture({ key: true, id: 1 });
    advance(3);
    const frame = decoders[0]!.emit();
    expect([canvas.width, canvas.height]).toEqual([2560, 1600]);
    expect(canvas.draws).toEqual([{ image: frame, x: 0, y: 0 }]);
    expect(frame.closed).toBe(true);
    expect(socket.of(`ack`)).toEqual([{ type: `ack`, id: 1, decodeMs: 3 }]);
    expect(posted).toContainEqual({ type: `painted`, width: 2560, height: 1600 });
    expect(posted).toContainEqual({ type: `picture` });
    // The edge is said before the size, so the page samples it as the new size lands.
    const said = posted.map((message) => message.type);
    expect(said.indexOf(`edge`)).toBeLessThan(said.indexOf(`painted`));
});

it("decodes each stripe on its own decoder, draws it at its top row, and acks the frame after its last stripe", () => {
    const { socket, canvas, decoders, hello } = harness();
    hello();
    socket.picture({ key: true, id: 4, stripeIndex: 0, stripeTop: 0, stripeCount: 2 });
    socket.picture({ key: true, id: 4, stripeIndex: 1, stripeTop: 800, stripeCount: 2 });
    expect(decoders).toHaveLength(2);
    decoders[1]!.emit();
    expect(socket.of(`ack`)).toEqual([]);
    decoders[0]!.emit();
    expect(canvas.draws.map((draw) => draw.y)).toEqual([800, 0]);
    expect(socket.of(`ack`)).toEqual([{ type: `ack`, id: 4, decodeMs: 0 }]);
});

it("never feeds a delta to a stripe before its keyframe, and acks it as dropped", () => {
    const { socket, decoders, hello } = harness();
    hello();
    socket.picture({ key: false, id: 1 });
    expect(decoders).toHaveLength(0);
    expect(socket.of(`ack`)).toEqual([{ type: `ack`, id: 1 }]);
    socket.picture({ key: true, id: 2 });
    socket.picture({ key: false, id: 3 });
    expect(decoders[0]!.chunks.map((chunk) => chunk.type)).toEqual([`key`, `delta`]);
});

it("asks for a keyframe when a decoder fails, not again within half a second, and starts the stripe over at one", () => {
    const { socket, decoders, advance, hello } = harness();
    hello();
    socket.picture({ key: true, id: 1 });
    decoders[0]!.fail();
    expect(socket.of(`keyframe`)).toHaveLength(1);
    // The frame lost with the decoder is still acked, so castd's queue drains.
    expect(socket.of(`ack`)).toEqual([{ type: `ack`, id: 1 }]);
    socket.picture({ key: false, id: 2 });
    expect(decoders).toHaveLength(1);
    socket.picture({ key: true, id: 3 });
    decoders[1]!.fail();
    expect(socket.of(`keyframe`)).toHaveLength(1);
    advance(500);
    socket.picture({ key: true, id: 4 });
    decoders[2]!.fail();
    expect(socket.of(`keyframe`)).toHaveLength(2);
});

it("forwards castd's text to the page and keeps pictures to itself", () => {
    const { socket, posted, hello } = harness();
    hello();
    socket.picture({ key: true, id: 1 });
    const texts = posted.filter((message) => message.type === `text`);
    expect(texts).toHaveLength(1);
    expect(JSON.parse(texts[0]?.type === `text` ? texts[0].data : `{}`)).toMatchObject({ type: `hello`, width: 2560 });
});

it("shows a picked tab's last picture at once, and the live one once the window has it in front", async () => {
    const { core, socket, canvas, decoders, stills, advance, hello } = harness();
    hello(300, 150);
    core.receive({ type: `page`, key: `w\na`, switching: false });
    socket.picture({ key: true, id: 1, captureMs: 0 });
    decoders[0]!.emit();
    // Leaving tab a keeps its picture.
    core.receive({ type: `page`, key: `w\nb`, switching: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stills).toHaveLength(1);
    // Back to a: its picture is drawn over the canvas at once, and live frames go behind it.
    core.receive({ type: `page`, key: `w\na`, switching: true });
    expect(canvas.draws.at(-1)?.image).toBe(stills[0]);
    socket.picture({ key: false, id: 2, captureMs: 20 });
    decoders[0]!.emit();
    expect(canvas.draws.at(-1)?.image).toBe(stills[0]);
    // The window says a is in front at castd's t=100 (+50 ms for its first paint): a frame captured before then stays
    // behind the still, one captured after puts the live picture back.
    advance(100);
    core.receive({ type: `fronted`, key: `w\na` });
    socket.picture({ key: false, id: 3, captureMs: 120 });
    decoders[0]!.emit();
    expect(canvas.draws.at(-1)?.image).toBe(stills[0]);
    socket.picture({ key: false, id: 4, captureMs: 160 });
    decoders[0]!.emit();
    expect(canvas.draws.at(-1)?.image).not.toBe(stills[0]);
    expect(canvas.draws.at(-1)).toMatchObject({ x: 0, y: 0 });
});

// A video message as castd writes it, to hand the worker as the page hands it what arrived on the peer.
const peerPicture = (id: number, key: boolean): ArrayBuffer =>
    writeMediaMessage(
        { kind: `video`, key, refine: false, id, captureMs: 0, stripeTop: 0, stripeIndex: 0, stripeCount: 1 },
        new Uint8Array([0, 0, 0, 1]),
    ).buffer;

it("draws pictures only from the carrier castd said its latest hello on, the peer's and then the socket's again", () => {
    const { socket, core, decoders, hello } = harness();
    hello();
    socket.picture({ key: true, id: 1 });
    expect(decoders[0]!.chunks).toHaveLength(1);
    // castd moved the stream onto the peer: its hello there starts a fresh stream, and a frame still in flight on the
    // socket is not decoded after it.
    const helloOnPeer = { type: `hello`, width: 2560, height: 1600, scale: 2, codec: `avc1.42c033`, readOnly: false };
    core.receive({ type: `peerData`, data: JSON.stringify(helloOnPeer) });
    socket.picture({ key: false, id: 2 });
    core.receive({ type: `peerData`, data: peerPicture(1, true) });
    const decoder = decoders.at(-1)!;
    expect(decoder.chunks.map((chunk) => chunk.type)).toEqual([`key`]);
    // Back on the socket: the peer's pictures stop counting.
    hello();
    core.receive({ type: `peerData`, data: peerPicture(2, false) });
    socket.picture({ key: true, id: 1 });
    expect(decoders.at(-1)!.chunks.map((chunk) => chunk.type)).toEqual([`key`]);
});

it("hands the page what it would send while the peer carries the viewer's messages, signalling apart", () => {
    const { socket, core, posted, decoders, hello } = harness();
    hello();
    core.receive({ type: `peer`, open: true });
    socket.picture({ key: true, id: 1 });
    decoders[0]!.emit();
    core.receive({ type: `send`, message: { type: `keyframe` } });
    core.receive({ type: `send`, message: { type: `rtcClose` } });
    expect(posted.filter((message) => message.type === `peerSend`)).toEqual([
        { type: `peerSend`, message: { type: `ack`, id: 1, decodeMs: 0 } },
        { type: `peerSend`, message: { type: `keyframe` } },
    ]);
    expect(socket.of(`ack`)).toEqual([]);
    expect(socket.of(`rtcClose`)).toEqual([{ type: `rtcClose` }]);
    // The peer let go: the socket carries them again.
    core.receive({ type: `peer`, open: false });
    core.receive({ type: `send`, message: { type: `keyframe` } });
    expect(socket.of(`keyframe`)).toEqual([{ type: `keyframe` }]);
});

it("asks again for a keyframe it held back, once half a second has passed, so a stripe is never left waiting", () => {
    const { socket, decoders, advance, tick, hello } = harness();
    hello();
    socket.picture({ key: true, id: 1 });
    decoders[0]!.fail();
    expect(socket.of(`keyframe`)).toHaveLength(1);
    // castd's keyframe came and started the stripe again; then its decoder fails too, inside the half second.
    advance(100);
    socket.picture({ key: true, id: 2 });
    decoders[1]!.emit();
    decoders[1]!.fail();
    expect(socket.of(`keyframe`)).toHaveLength(1);
    // castd never sends a keyframe unasked (its GOP is infinite): the ask held back goes once the half second is up.
    advance(400);
    tick(250);
    expect(socket.of(`keyframe`)).toHaveLength(2);
    tick(250);
    expect(socket.of(`keyframe`)).toHaveLength(2);
});

it("says a codec this browser cannot decode once, rather than asking castd for keyframe after keyframe", () => {
    const { socket, decoders, posted, advance, tick, hello } = harness();
    hello();
    socket.picture({ key: true, id: 1 });
    decoders[0]!.fail(`NotSupportedError`);
    expect(posted.filter((message) => message.type === `failed`)).toHaveLength(1);
    expect(socket.of(`ack`)).toEqual([{ type: `ack`, id: 1 }]);
    for (let id = 2; id < 6; id += 1) {
        advance(600);
        socket.picture({ key: true, id });
        tick(250);
    }
    expect(socket.of(`keyframe`)).toHaveLength(0);
    expect(decoders).toHaveLength(1);
    // Every frame is still acked, so castd's queue drains.
    expect(socket.of(`ack`).map((ack) => ack[`id`])).toEqual([1, 2, 3, 4, 5]);
    expect(posted.filter((message) => message.type === `failed`)).toHaveLength(1);
});

it("asks for a keyframe when a canvas comes after the stream started, since stripes that never change are never sent again", () => {
    const { core, socket, decoders, hello } = harness();
    core.receive({ type: `canvas`, canvas: undefined });
    hello();
    socket.picture({ key: true, id: 1 });
    // Decoded with no canvas to draw on: the keyframe is gone.
    decoders[0]!.emit();
    expect(socket.of(`keyframe`)).toHaveLength(0);
    const fresh = surface();
    core.receive({ type: `canvas`, canvas: fresh });
    expect(socket.of(`keyframe`)).toHaveLength(1);
});

it("does not ask for a keyframe for a canvas that came before any picture", () => {
    const { core, socket, hello } = harness();
    core.receive({ type: `canvas`, canvas: undefined });
    hello();
    core.receive({ type: `canvas`, canvas: surface() });
    expect(socket.of(`keyframe`)).toHaveLength(0);
});

it("counts frames, not stripes, in the frames a second", () => {
    const { core, socket, decoders, posted, hello } = harness();
    hello();
    socket.picture({ key: true, id: 1, stripeIndex: 0, stripeTop: 0, stripeCount: 2 });
    socket.picture({ key: true, id: 1, stripeIndex: 1, stripeTop: 800, stripeCount: 2 });
    decoders[0]!.emit();
    decoders[1]!.emit();
    core.receive({ type: `stats`, on: true });
    expect(posted.at(-1)).toMatchObject({ type: `stats`, stats: { fps: 1 } });
});

it("puts the live picture back by the first word that the tab is in front, not pushed later by every state after it", async () => {
    const { core, socket, canvas, decoders, stills, advance, hello } = harness();
    hello(300, 150);
    core.receive({ type: `page`, key: `w\na`, switching: false });
    socket.picture({ key: true, id: 1, captureMs: 0 });
    decoders[0]!.emit();
    core.receive({ type: `page`, key: `w\nb`, switching: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    core.receive({ type: `page`, key: `w\na`, switching: true });
    expect(canvas.draws.at(-1)?.image).toBe(stills[0]);
    // The window says a is in front at castd's t=100, and says so again in its next state at t=300.
    advance(100);
    core.receive({ type: `fronted`, key: `w\na` });
    advance(200);
    core.receive({ type: `fronted`, key: `w\na` });
    socket.picture({ key: false, id: 2, captureMs: 160 });
    decoders[0]!.emit();
    expect(canvas.draws.at(-1)?.image).not.toBe(stills[0]);
});

it("files no tab's last picture under another tab named by a state that lagged the person's pick", async () => {
    const { core, socket, canvas, decoders, stills, hello } = harness();
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    hello(300, 150);
    core.receive({ type: `page`, key: `w\na`, switching: false });
    socket.picture({ key: true, id: 1, captureMs: 0 });
    decoders[0]!.emit();
    core.receive({ type: `page`, key: `w\nb`, switching: true });
    await settle();
    socket.picture({ key: false, id: 2, captureMs: 10 });
    decoders[0]!.emit();
    // Back to a: b's picture is kept, a's is held over the canvas.
    core.receive({ type: `page`, key: `w\na`, switching: true });
    await settle();
    const ofB = stills[1];
    // The window's state, sent before it heard the pick, still says b is in front.
    core.receive({ type: `page`, key: `w\nb`, switching: false });
    // On to c: what is kept now is a's, not filed under b.
    core.receive({ type: `page`, key: `w\nc`, switching: true });
    await settle();
    core.receive({ type: `page`, key: `w\nb`, switching: true });
    expect(canvas.draws.at(-1)?.image).toBe(ofB);
});
