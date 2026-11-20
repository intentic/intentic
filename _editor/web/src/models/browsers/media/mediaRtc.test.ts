// The peer connection beside the media socket, on a fake RTCPeerConnection: when it is offered and when not, the
// channels it opens and with what reliability, what it hands on as castd's stream, what it takes of the viewer's
// messages, and how it gives the stream back to the socket (a deadline, a connection that sat disconnected, castd's
// own word), each time without the picture waiting on it.
import type { BrowserMediaClientMessage } from "@intentic/sandbox-contract/browser-wire";
import { MEDIA_HEADER_LEN, RTC_MESSAGE_MAX } from "@intentic/sandbox-contract/browser-wire";
import { type ChannelLike, DISCONNECTED_MS, GATHER_WITHIN_MS, mediaRtc, OPEN_WITHIN_MS, type PeerLike } from "./mediaRtc";

class FakeChannel implements ChannelLike {
    binaryType: BinaryType = `blob`;
    readyState = `connecting`;
    readonly sent: (string | Uint8Array)[] = [];
    readonly listeners = new Map<string, ((event: { readonly data: unknown }) => void)[]>();
    constructor(
        readonly label: string,
        readonly init: RTCDataChannelInit,
    ) {}
    send(data: string | Uint8Array<ArrayBuffer>): void {
        this.sent.push(data);
    }
    close(): void {
        this.readyState = `closed`;
    }
    addEventListener(type: string, listener: (event: { readonly data: unknown }) => void): void {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }
    fire(type: string, data?: unknown): void {
        for (const listener of this.listeners.get(type) ?? []) {
            listener({ data });
        }
    }
    open(): void {
        this.readyState = `open`;
        this.fire(`open`);
    }
}

class FakePeer implements PeerLike {
    connectionState = `new`;
    localDescription: { readonly sdp: string } | null = null;
    remote: RTCSessionDescriptionInit | undefined;
    closed = false;
    readonly channels: FakeChannel[] = [];
    private readonly changes: (() => void)[] = [];
    createDataChannel(label: string, init: RTCDataChannelInit): FakeChannel {
        const channel = new FakeChannel(label, init);
        this.channels.push(channel);
        return channel;
    }
    async createOffer(): Promise<RTCSessionDescriptionInit> {
        return { type: `offer`, sdp: `v=0 offer` };
    }
    async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
        this.localDescription = { sdp: description.sdp ?? `` };
    }
    async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
        this.remote = description;
    }
    addEventListener(_type: `connectionstatechange`, listener: () => void): void {
        this.changes.push(listener);
    }
    close(): void {
        this.closed = true;
    }
    channel(label: string): FakeChannel {
        const found = this.channels.find((channel) => channel.label === label);
        if (found === undefined) {
            throw new Error(`no ${label} channel`);
        }
        return found;
    }
    become(state: string): void {
        this.connectionState = state;
        for (const change of this.changes) {
            change();
        }
    }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const harness = (wanted = true) => {
    const peers: FakePeer[] = [];
    const signalled: BrowserMediaClientMessage[] = [];
    const arrived: (string | ArrayBuffer)[] = [];
    const carrying: boolean[] = [];
    const timers: { run: () => void; ms: number; cancelled: boolean }[] = [];
    const rtc = mediaRtc({
        signal: (message) => signalled.push(message),
        arrived: (data) => arrived.push(data),
        carrying: (on) => carrying.push(on),
        wanted: () => wanted,
        peer: () => {
            const peer = new FakePeer();
            peers.push(peer);
            return peer;
        },
        later: (run, ms) => {
            const timer = { run, ms, cancelled: false };
            timers.push(timer);
            return () => (timer.cancelled = true);
        },
    });
    const fire = (ms: number): void => {
        for (const timer of timers.filter((each) => each.ms === ms && !each.cancelled)) {
            timer.cancelled = true;
            timer.run();
        }
    };
    // castd offered a peer, the offer went out, castd answered, and both channels the stream needs opened.
    const open = async (): Promise<FakePeer> => {
        rtc.hello(true);
        await settle();
        const peer = peers.at(-1)!;
        rtc.answer(`v=0 answer`);
        await settle();
        peer.channel(`media`).open();
        peer.channel(`input`).open();
        return peer;
    };
    return { rtc, peers, signalled, arrived, carrying, timers, fire, open };
};

it("offers a peer only where castd takes one and the socket is not already on the loopback shortcut", async () => {
    const loopback = harness(false);
    loopback.rtc.hello(true);
    const declined = harness();
    declined.rtc.hello(false);
    await settle();
    expect([loopback.peers, declined.peers]).toEqual([[], []]);
    expect(loopback.signalled).toEqual([]);
});

it("opens the three channels with browser-wire's reliability and sends its offer on the socket", async () => {
    const { rtc, peers, signalled } = harness();
    rtc.hello(true);
    // A second hello while it connects (castd's own, a resize) makes no second peer.
    rtc.hello(true);
    await settle();
    expect(peers).toHaveLength(1);
    expect(peers[0]!.channels.map((channel) => [channel.label, channel.init, channel.binaryType])).toEqual([
        [`media`, { ordered: true }, `arraybuffer`],
        [`audio`, { ordered: false, maxRetransmits: 0 }, `arraybuffer`],
        [`input`, { ordered: true }, `arraybuffer`],
    ]);
    expect(signalled).toEqual([{ type: `rtcOffer`, sdp: `v=0 offer` }]);
    rtc.answer(`v=0 answer`);
    await settle();
    expect(peers[0]!.remote).toEqual({ type: `answer`, sdp: `v=0 answer` });
});

it("carries the viewer's messages once media and input are open, a long one cut to fit, signalling never", async () => {
    const { rtc, carrying, open, timers } = harness();
    expect(rtc.send({ type: `keyframe` })).toBe(false);
    const peer = await open();
    expect(rtc.state()).toBe(`open`);
    expect(carrying).toEqual([true]);
    // The deadline for opening is off once open.
    expect(timers.find((timer) => timer.ms === OPEN_WITHIN_MS)?.cancelled).toBe(true);
    expect(rtc.send({ type: `key`, key: `a` })).toBe(true);
    expect(rtc.send({ type: `text`, text: `x`.repeat(RTC_MESSAGE_MAX) })).toBe(true);
    expect(rtc.send({ type: `rtcClose` })).toBe(false);
    const sent = peer.channel(`input`).sent;
    expect(sent[0]).toBe(`{"type":"key","key":"a"}`);
    expect(sent.slice(1).map((chunk) => (chunk instanceof Uint8Array ? [chunk[0], chunk[1]] : chunk))).toEqual([
        [0, 2],
        [1, 2],
    ]);
});

it("hands on castd's JSON and its video whole, and its sound as it comes", async () => {
    const { arrived, open } = harness();
    const peer = await open();
    peer.channel(`media`).fire(`message`, `{"type":"hello"}`);
    const slice = RTC_MESSAGE_MAX - MEDIA_HEADER_LEN;
    const chunk = (index: number): ArrayBuffer => {
        const bytes = new Uint8Array(MEDIA_HEADER_LEN + slice);
        bytes[0] = 1;
        bytes[5] = 7;
        bytes[14] = index;
        bytes[15] = 2;
        bytes.fill(index + 1, MEDIA_HEADER_LEN);
        return bytes.buffer;
    };
    peer.channel(`media`).fire(`message`, chunk(0));
    expect(arrived).toHaveLength(1);
    peer.channel(`media`).fire(`message`, chunk(1));
    const sound = new Uint8Array([2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 9]).buffer;
    peer.channel(`audio`).fire(`message`, sound);
    // Text on the sound channel is nobody's.
    peer.channel(`audio`).fire(`message`, `stray`);
    expect(arrived[0]).toBe(`{"type":"hello"}`);
    const joined = arrived[1];
    const whole = new Uint8Array(joined instanceof ArrayBuffer ? joined : new ArrayBuffer(0));
    expect([whole.byteLength, whole[14], whole[15], whole[MEDIA_HEADER_LEN], whole.at(-1)]).toEqual([MEDIA_HEADER_LEN + 2 * slice, 0, 0, 1, 2]);
    expect(arrived[2]).toBe(sound);
    expect(arrived).toHaveLength(3);
});

it("gives up on a peer that never opens, tells castd, and does not offer again on this socket", async () => {
    const { rtc, peers, signalled, carrying, fire } = harness();
    rtc.hello(true);
    await settle();
    fire(OPEN_WITHIN_MS);
    expect(peers[0]!.closed).toBe(true);
    expect(signalled.at(-1)).toEqual({ type: `rtcClose` });
    expect(carrying).toEqual([]);
    rtc.hello(true);
    expect(peers).toHaveLength(1);
    // A new socket may try again.
    rtc.stop();
    rtc.hello(true);
    expect(peers).toHaveLength(2);
});

it("hands the stream back when the connection sits disconnected, but not when it recovers in time", async () => {
    const { rtc, signalled, carrying, open, fire } = harness();
    const peer = await open();
    peer.become(`disconnected`);
    peer.become(`connected`);
    fire(DISCONNECTED_MS);
    expect(rtc.state()).toBe(`open`);
    peer.become(`disconnected`);
    fire(DISCONNECTED_MS);
    expect(rtc.state()).toBe(`off`);
    expect(carrying).toEqual([true, false]);
    expect(signalled.at(-1)).toEqual({ type: `rtcClose` });
});

it("lets go without telling castd what castd said itself, and when a channel the stream needs closes", async () => {
    const first = harness();
    const peer = await first.open();
    first.rtc.closed(`ICE disconnected`);
    expect([peer.closed, first.carrying, first.signalled.map((message) => message.type)]).toEqual([true, [true, false], [`rtcOffer`]]);
    const second = harness();
    const other = await second.open();
    other.channel(`audio`).fire(`close`);
    expect(second.rtc.state()).toBe(`open`);
    other.channel(`input`).fire(`close`);
    expect(second.rtc.state()).toBe(`off`);
    expect(second.signalled.at(-1)).toEqual({ type: `rtcClose` });
});

// A peer that gathers its candidates as a browser's does: the SDP grows a candidate line once STUN has answered.
class GatheringPeer extends FakePeer {
    iceGatheringState = `gathering`;
    onicegatheringstatechange: (() => void) | null = null;
    complete(): void {
        this.iceGatheringState = `complete`;
        this.localDescription = { sdp: `v=0 offer\na=candidate:srflx` };
        this.onicegatheringstatechange?.();
    }
}

const gatheringHarness = (iceServers: readonly RTCIceServer[]) => {
    const peers: GatheringPeer[] = [];
    const signalled: BrowserMediaClientMessage[] = [];
    const timers: { run: () => void; ms: number; cancelled: boolean }[] = [];
    const rtc = mediaRtc({
        signal: (message) => signalled.push(message),
        arrived: () => undefined,
        carrying: () => undefined,
        wanted: () => true,
        iceServers: () => iceServers,
        peer: () => {
            const peer = new GatheringPeer();
            peers.push(peer);
            return peer;
        },
        later: (run, ms) => {
            const timer = { run, ms, cancelled: false };
            timers.push(timer);
            return () => (timer.cancelled = true);
        },
    });
    return { rtc, peers, signalled, timers };
};

it("with ICE servers, offers only once its candidates are gathered, so a computer behind a NAT can answer", async () => {
    const { rtc, peers, signalled, timers } = gatheringHarness([{ urls: [`stun:stun.example:3478`] }]);
    rtc.hello(true);
    await settle();
    expect(signalled).toEqual([]);
    peers[0]!.complete();
    await settle();
    expect(signalled).toEqual([{ type: `rtcOffer`, sdp: `v=0 offer\na=candidate:srflx` }]);
    expect(timers.find((timer) => timer.ms === GATHER_WITHIN_MS)?.cancelled).toBe(true);
});

it("with ICE servers that never answer, offers what it has at the gathering deadline", async () => {
    const { rtc, signalled, timers } = gatheringHarness([{ urls: [`stun:silent.example:3478`] }]);
    rtc.hello(true);
    await settle();
    timers.find((timer) => timer.ms === GATHER_WITHIN_MS)!.run();
    await settle();
    expect(signalled).toEqual([{ type: `rtcOffer`, sdp: `v=0 offer` }]);
});

it("without ICE servers, offers at once as it always has on castd's own network", async () => {
    const { rtc, signalled } = gatheringHarness([]);
    rtc.hello(true);
    await settle();
    expect(signalled).toEqual([{ type: `rtcOffer`, sdp: `v=0 offer` }]);
});
