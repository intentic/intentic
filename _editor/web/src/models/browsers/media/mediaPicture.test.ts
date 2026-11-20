// The media path as the page holds it, on a fake decode worker: where it dials and with which token, when it dials
// again, what it says to castd (the box with the screen's ratio, pause and resume), and what it makes of castd's word
// (the hello, the cursor, a copy).
import "@intentic/testing/dom";
import type { BrowserMediaClientMessage, BrowserMediaServerMessage, ClipboardContent } from "@intentic/sandbox-contract/browser-wire";
import { stubGlobal, unstubAllGlobals, waitFor } from "@intentic/testing/bun";
import { mediaPicture, type MediaPicture } from "./mediaPicture";
import type { ChannelLike, PeerLike } from "./mediaRtc";
import type { MediaWorker } from "./mediaWorker";
import type { FromWorker, ToWorker } from "./worker/workerWire";

const token = (readOnly: boolean): string => `${btoa(JSON.stringify({ s: `cast-1`, exp: 0, ro: readOnly })).replaceAll(`=`, ``)}.mac`;

const fakeWorker = () => {
    const posted: ToWorker[] = [];
    let listener: ((message: FromWorker) => void) | undefined;
    const worker: MediaWorker = {
        post: (message) => posted.push(message),
        listen: (handler) => (listener = handler),
        terminate: () => undefined,
    };
    const dials = (): Extract<ToWorker, { type: `dial` }>[] => posted.flatMap((message) => (message.type === `dial` ? [message] : []));
    const sent = (): BrowserMediaClientMessage[] => posted.flatMap((message) => (message.type === `send` ? [message.message] : []));
    return {
        worker,
        posted,
        dials,
        sent,
        say: (message: FromWorker) => listener?.(message),
        // The socket the page dialled last opens, and castd says `message` on it.
        open: () => listener?.({ type: `open`, socket: dials().at(-1)?.socket ?? 0 }),
        castd: (message: BrowserMediaServerMessage) =>
            listener?.({ type: `text`, socket: dials().at(-1)?.socket ?? 0, data: JSON.stringify(message) }),
    };
};

const pictures: MediaPicture[] = [];
afterEach(() => {
    for (const picture of pictures.splice(0)) {
        picture.dispose();
    }
    unstubAllGlobals();
});

// `hz`: the rate the stage's display refreshes at, as measured; none unless a test says.
const setup = (now = Date.now(), hz?: number) => {
    const fake = fakeWorker();
    const copies: ClipboardContent[] = [];
    const asked: string[] = [];
    const picture = mediaPicture({
        base: () => `https://sandbox.example`,
        askFresh: () => asked.push(`media`),
        worker: () => fake.worker,
        displayRate: async () => hz,
        clipboard: { remote: (content) => copies.push(content), gesture: () => undefined, held: () => undefined, forget: () => undefined },
    });
    pictures.push(picture);
    return {
        fake,
        picture,
        copies,
        asked,
        offer: (readOnly = false, expiresAt = now + 60_000) =>
            picture.offer({ path: `/system/browser-media/cast-1`, token: token(readOnly), expiresAt }),
    };
};

const hello = { type: `hello`, width: 2000, height: 1200, scale: 2, codec: `avc1.42c033`, readOnly: false } as const;

it("dials castd's path with its token on the sandbox's own base, asking for an exact picture, and takes the hello as the picture", async () => {
    const { fake, picture, offer } = setup();
    offer();
    await waitFor(() => expect(fake.dials()).toHaveLength(1));
    expect(fake.dials()[0]?.url).toBe(`wss://sandbox.example/system/browser-media/cast-1?token=${encodeURIComponent(token(false))}&lossless=1`);
    fake.open();
    expect(picture.live.value).toBe(false);
    fake.castd(hello);
    expect(picture.live.value).toBe(true);
    expect(picture.hello.value).toMatchObject({ width: 2000, height: 1200, scale: 2 });
});

it("keeps a renewed token for the next dial, and dials again only for another path or another access", async () => {
    const { fake, offer } = setup();
    offer();
    await waitFor(() => expect(fake.dials()).toHaveLength(1));
    offer();
    await Promise.resolve();
    expect(fake.dials()).toHaveLength(1);
    // The desktop's read-only token swapped for a driving one.
    offer(true);
    await waitFor(() => expect(fake.dials()).toHaveLength(2));
});

it("dials with the latest token whatever this computer's clock says of its expiry", async () => {
    const { fake, asked, offer } = setup();
    // A clock minutes fast reads every token as lapsed; castd checks the token on its own clock.
    offer(false, Date.now() - 300_000);
    await waitFor(() => expect(fake.dials()).toHaveLength(1));
    expect(asked).toEqual([]);
});

// castd answers a token it will not take with 401 or 403 before the upgrade: the browser sees a close, never an open.
const refuse = (fake: ReturnType<typeof fakeWorker>, code = 1006): void =>
    fake.say({ type: `close`, socket: fake.dials().at(-1)?.socket ?? 0, code, reason: `` });

it("asks for a fresh token when castd refuses the dial, and dials again with it", async () => {
    const { fake, picture, asked, offer } = setup();
    offer();
    await waitFor(() => expect(fake.dials()).toHaveLength(1));
    refuse(fake);
    expect(asked).toEqual([`media`]);
    const fresh = `${token(false)}2`;
    picture.offer({ path: `/system/browser-media/cast-1`, token: fresh, expiresAt: 0 });
    await waitFor(() => expect(fake.dials()).toHaveLength(2), { timeout: 3000 });
    expect(fake.dials()[1]?.url).toContain(`token=${encodeURIComponent(fresh)}`);
});

it("waits for a fresh token before dialling again once castd closes a socket as dropped or expired", async () => {
    const { fake, picture, asked, offer } = setup();
    offer();
    await waitFor(() => expect(fake.dials()).toHaveLength(1));
    fake.open();
    fake.castd(hello);
    // browser-wire's MEDIA_CLOSE_CODES.dropped: every token minted before the drop is refused from now on.
    refuse(fake, 4001);
    expect(asked).toEqual([`media`]);
    await new Promise((resolve) => setTimeout(resolve, 1600));
    expect(fake.dials()).toHaveLength(1);
    const fresh = `${token(false)}2`;
    picture.offer({ path: `/system/browser-media/cast-1`, token: fresh, expiresAt: 0 });
    await waitFor(() => expect(fake.dials()).toHaveLength(2));
    expect(fake.dials()[1]?.url).toContain(`token=${encodeURIComponent(fresh)}`);
});

it("asks for a fresh token at most three times in a row while no socket opens", async () => {
    const { fake, asked, offer } = setup();
    // Another access each time, so each offer dials at once rather than on the ladder.
    for (const readOnly of [false, true, false, true]) {
        offer(readOnly);
        await waitFor(() => expect(fake.dials().at(-1)?.url).toContain(encodeURIComponent(token(readOnly))));
        refuse(fake);
    }
    expect(asked).toEqual([`media`, `media`, `media`]);
    // An open socket starts the count over.
    offer(false);
    await waitFor(() => expect(fake.dials()).toHaveLength(5));
    fake.open();
    refuse(fake, 4002);
    expect(asked).toHaveLength(4);
});

it("asks castd for the stage in whole CSS px at the screen's ratio, only once it may resize", async () => {
    stubGlobal(`devicePixelRatio`, 1.5);
    const { fake, picture, offer } = setup();
    offer();
    await waitFor(() => expect(fake.dials()).toHaveLength(1));
    fake.open();
    picture.requestSize(1001.6, 700.2);
    expect(fake.sent().filter((message) => message.type === `resize`)).toEqual([]);
    fake.castd(hello);
    expect(fake.sent().filter((message) => message.type === `resize`)).toEqual([{ type: `resize`, width: 1001, height: 700, scale: 1.5 }]);
});

it("says the rate the stage's display refreshes at with the box", async () => {
    stubGlobal(`devicePixelRatio`, 2);
    const { fake, picture, offer } = setup(Date.now(), 144);
    offer();
    await waitFor(() => expect(fake.dials()).toHaveLength(1));
    fake.open();
    picture.requestSize(800, 600);
    await Promise.resolve();
    fake.castd(hello);
    expect(fake.sent().filter((message) => message.type === `resize`)).toEqual([{ type: `resize`, width: 800, height: 600, scale: 2, hz: 144 }]);
});

it("asks no box on a read-only socket: castd sizes the screen to whoever drives", async () => {
    const { fake, picture, offer } = setup();
    offer(true);
    await waitFor(() => expect(fake.dials()).toHaveLength(1));
    fake.open();
    fake.castd({ ...hello, readOnly: true });
    picture.requestSize(800, 600);
    expect(fake.sent().filter((message) => message.type === `resize`)).toEqual([]);
});

it("hands a renewed token to the open socket rather than dial again, since castd keeps a socket only so long past its newest", async () => {
    const { fake, offer } = setup();
    offer();
    await waitFor(() => expect(fake.dials()).toHaveLength(1));
    // Renewed before the socket opened: only held for the next dial.
    offer();
    expect(fake.sent().filter((message) => message.type === `token`)).toEqual([]);
    fake.open();
    offer();
    expect(fake.sent().filter((message) => message.type === `token`)).toEqual([{ type: `token`, token: token(false) }]);
    expect(fake.dials()).toHaveLength(1);
});

it("pauses and resumes castd with the view, and says which on every fresh socket", async () => {
    const { fake, picture, offer } = setup();
    picture.setVisible(false);
    offer();
    await waitFor(() => expect(fake.dials()).toHaveLength(1));
    fake.open();
    expect(fake.sent().at(-1)).toEqual({ type: `pause` });
    picture.setVisible(true);
    expect(fake.sent().at(-1)).toEqual({ type: `resume` });
});

it("turns castd's cursor into the stage's CSS, and hands a copy to the clipboard", async () => {
    const { fake, picture, copies, offer } = setup();
    offer();
    await waitFor(() => expect(fake.dials()).toHaveLength(1));
    fake.open();
    fake.castd(hello);
    fake.castd({ type: `cursor`, cursor: { css: `text` } });
    expect(picture.cursor.value).toBe(`text`);
    fake.castd({ type: `clipboard`, content: { text: `copied` } });
    expect(copies).toEqual([{ text: `copied` }]);
});

it("hands no copy to the clipboard from a read-only socket", async () => {
    const { fake, copies, offer } = setup();
    offer(true);
    await waitFor(() => expect(fake.dials()).toHaveLength(1));
    fake.open();
    fake.castd({ ...hello, readOnly: true });
    fake.castd({ type: `clipboard`, content: { text: `watched` } });
    expect(copies).toEqual([]);
});

it("takes the worker's word on the painted size and the edge, and forgets them when it stops", async () => {
    const { fake, picture, offer } = setup();
    offer();
    await waitFor(() => expect(fake.dials()).toHaveLength(1));
    fake.say({ type: `edge`, colour: `rgb(1 2 3)` });
    fake.say({ type: `painted`, width: 2000, height: 1200 });
    expect(picture.edgeColour()).toBe(`rgb(1 2 3)`);
    expect(picture.painted.value).toEqual({ width: 2000, height: 1200 });
    picture.stop();
    expect(picture.painted.value).toBeUndefined();
    expect(picture.edgeColour()).toBeUndefined();
    expect(fake.posted.at(-1)).toEqual({ type: `reset` });
});

// A DataChannel and a peer connection that do what they are told, for the peer path's test.
class PeerChannel implements ChannelLike {
    binaryType: BinaryType = `blob`;
    readyState = `connecting`;
    readonly sent: unknown[] = [];
    readonly listeners = new Map<string, ((event: { readonly data: unknown }) => void)[]>();
    send(data: string | Uint8Array<ArrayBuffer>): void {
        this.sent.push(data);
    }
    close(): void {
        this.readyState = `closed`;
    }
    addEventListener(type: string, listener: (event: { readonly data: unknown }) => void): void {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }
}

class AnsweringPeer implements PeerLike {
    connectionState = `new`;
    localDescription = { sdp: `v=0 offer` };
    remote: RTCSessionDescriptionInit | undefined;
    constructor(private readonly channels: Map<string, PeerChannel>) {}
    createDataChannel(label: string): PeerChannel {
        const channel = new PeerChannel();
        this.channels.set(label, channel);
        return channel;
    }
    async createOffer(): Promise<RTCSessionDescriptionInit> {
        return { type: `offer`, sdp: `v=0 offer` };
    }
    async setLocalDescription(): Promise<void> {}
    async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
        this.remote = description;
    }
    addEventListener(): void {}
    close(): void {}
}

it("dials on the edge's WebTransport where it was declared, and offers castd a peer it takes, carrying the stream on it", async () => {
    // A peer connection that answers everything at once, as far as this path asks.
    const channels = new Map<string, PeerChannel>();
    const peer = new AnsweringPeer(channels);
    const fake = fakeWorker();
    const picture = mediaPicture({
        base: () => `https://sandbox.example`,
        askFresh: () => undefined,
        worker: () => fake.worker,
        clipboard: { remote: () => undefined, gesture: () => undefined, held: () => undefined, forget: () => undefined },
        webTransport: () => true,
        peerWanted: () => true,
        peer: () => peer,
    });
    pictures.push(picture);
    picture.offer({ path: `/system/browser-media/cast-1`, token: token(false), expiresAt: Date.now() + 60_000 });
    await waitFor(() => expect(fake.dials()).toHaveLength(1));
    expect(fake.dials()[0]?.transport).toBe(true);
    fake.open();
    fake.castd({ ...hello, rtc: true });
    await waitFor(() => expect(fake.sent()).toContainEqual({ type: `rtcOffer`, sdp: `v=0 offer` }));
    fake.castd({ type: `rtcAnswer`, sdp: `v=0 answer` });
    await waitFor(() => expect(peer.remote).toEqual({ type: `answer`, sdp: `v=0 answer` }));
    for (const label of [`media`, `input`]) {
        const channel = channels.get(label)!;
        channel.readyState = `open`;
        for (const listener of channel.listeners.get(`open`) ?? []) {
            listener({ data: undefined });
        }
    }
    expect(fake.posted).toContainEqual({ type: `peer`, open: true });
    // The page can say what carries the picture now (a remote screen's connection badge).
    expect(picture.carrier.value).toBe(`peer`);
    // What castd says on the peer reaches the worker, and the page reads its JSON as it reads the socket's.
    for (const listener of channels.get(`media`)!.listeners.get(`message`) ?? []) {
        listener({ data: JSON.stringify({ type: `cursor`, cursor: { css: `text` } }) });
    }
    expect(picture.cursor.value).toBe(`text`);
    expect(fake.posted).toContainEqual({ type: `peerData`, data: `{"type":"cursor","cursor":{"css":"text"}}` });
    // The viewer's own messages, and the worker's, go on the peer's input channel.
    picture.send({ type: `keyframe` });
    fake.say({ type: `peerSend`, message: { type: `ack`, id: 3 } });
    expect(channels.get(`input`)!.sent).toEqual([`{"type":"keyframe"}`, `{"type":"ack","id":3}`]);
    // castd let go of the peer: the socket carries everything again, the worker's next message included.
    fake.castd({ type: `rtcClosed`, reason: `ICE disconnected` });
    expect(fake.posted.at(-1)).toEqual({ type: `peer`, open: false });
    expect(picture.carrier.value).toBe(`socket`);
    fake.say({ type: `peerSend`, message: { type: `ack`, id: 4 } });
    expect(fake.sent().at(-1)).toEqual({ type: `ack`, id: 4 });
});

it("asks the worker for the edge colour at most four times a second, however often the stage resizes in a drag", async () => {
    const { fake, picture, offer } = setup();
    offer();
    await waitFor(() => expect(fake.dials()).toHaveLength(1));
    for (let step = 0; step < 10; step += 1) {
        picture.sampleEdge();
    }
    expect(fake.posted.filter((message) => message.type === `edge`)).toHaveLength(1);
});

it("tells its owner when this browser cannot decode castd's stream", async () => {
    const fake = fakeWorker();
    const failures: string[] = [];
    const picture = mediaPicture({
        base: () => `https://sandbox.example`,
        askFresh: () => undefined,
        worker: () => fake.worker,
        onFailed: (message) => failures.push(message),
    });
    pictures.push(picture);
    picture.offer({ path: `/system/browser-media/cast-1`, token: token(false), expiresAt: Date.now() + 60_000 });
    fake.say({ type: `failed`, message: `Unsupported configuration` });
    expect(failures).toEqual([`Unsupported configuration`]);
    expect(picture.failed.value).toBe(`Unsupported configuration`);
});

it("says resume only when the view comes back into sight, not again while it stays there", async () => {
    const { fake, picture, offer } = setup();
    offer();
    await waitFor(() => expect(fake.dials()).toHaveLength(1));
    fake.open();
    // Every resume restarts castd's video for this viewer with a keyframe, a burst for every viewer of the window.
    picture.setVisible(true);
    picture.setVisible(true);
    expect(fake.sent().filter((message) => message.type === `resume`)).toHaveLength(1);
    picture.setVisible(false);
    picture.setVisible(true);
    expect(fake.sent().filter((message) => message.type === `resume`)).toHaveLength(2);
});

it("asks castd for a box once per socket, whatever size its hellos answer with", async () => {
    const { fake, picture, offer } = setup();
    offer();
    await waitFor(() => expect(fake.dials()).toHaveLength(1));
    fake.open();
    picture.requestSize(1000, 700);
    fake.castd(hello);
    const resizes = () => fake.sent().filter((message) => message.type === `resize`);
    expect(resizes()).toHaveLength(1);
    // castd's answer to the box, and one it fitted to its screen's limits instead: neither is asked again.
    fake.castd({ ...hello, width: 1000, height: 700, scale: 1 });
    fake.castd({ ...hello, width: 998, height: 700, scale: 1 });
    expect(resizes()).toHaveLength(1);
    // A fresh socket is a viewer castd has no box from.
    fake.say({ type: `close`, socket: fake.dials().at(-1)?.socket ?? 0, code: 1001, reason: `` });
    await waitFor(() => expect(fake.dials()).toHaveLength(2), { timeout: 3000 });
    fake.open();
    fake.castd(hello);
    expect(resizes()).toHaveLength(2);
});

it("falls back at once in a browser that cannot run the decode worker", async () => {
    const failures: string[] = [];
    const picture = mediaPicture({
        base: () => `https://sandbox.example`,
        askFresh: () => undefined,
        worker: () => undefined,
        onFailed: (message) => failures.push(message),
    });
    pictures.push(picture);
    picture.offer({ path: `/system/browser-media/cast-1`, token: token(false), expiresAt: 0 });
    await waitFor(() => expect(failures).toHaveLength(1));
    expect(picture.failed.value).toBe(failures[0]);
});
