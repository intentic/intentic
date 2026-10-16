import { createSpeechPlayer, type PlayerAudio, type PlayerBuffer, type PlayerSource, type SpeechPlayerDeps } from "./speechPlayer";

// Pins the page's one voice: an utterance asked over the socket, its audio scheduled back to back on the audio clock
// as it arrives, settled once the last of it has played; a new one stops the old; a failure says why.

jest.mock(`../../client/sandbox/streams/wsTicket`, () => ({ socketUrl: async () => undefined }));

type Listener = (event: MessageEvent) => void;

// A socket the test speaks for: `answer` delivers what the daemon would send.
class FakeSocket {
    readyState: number = WebSocket.CONNECTING;
    binaryType: BinaryType = `blob`;
    readonly sent: unknown[] = [];
    private readonly listeners = new Map<string, Listener[]>();
    addEventListener(type: string, listener: Listener): void {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }
    send(data: string): void {
        this.sent.push(JSON.parse(data));
    }
    close(): void {
        this.readyState = WebSocket.CLOSED;
        this.emit(`close`, {});
    }
    open(): void {
        this.readyState = WebSocket.OPEN;
        this.emit(`open`, {});
    }
    answer(message: object | ArrayBuffer): void {
        this.emit(`message`, { data: message instanceof ArrayBuffer ? message : JSON.stringify(message) });
    }
    private emit(type: string, init: MessageEventInit): void {
        const event = new MessageEvent(type, init);
        for (const listener of this.listeners.get(type) ?? []) {
            listener(event);
        }
    }
}

interface Scheduled {
    readonly at: number;
    readonly duration: number;
    stopped: boolean;
}

// An audio clock that stands still unless the test moves it.
const fakeAudio = () => {
    const scheduled: Scheduled[] = [];
    const sourceOf = (): PlayerSource => {
        let entry: Scheduled | undefined;
        const source: PlayerSource = {
            buffer: null,
            connect: () => {},
            addEventListener: () => {},
            start: (at) => {
                entry = { at, duration: source.buffer?.duration ?? 0, stopped: false };
                scheduled.push(entry);
            },
            stop: () => {
                if (entry !== undefined) {
                    entry.stopped = true;
                }
            },
        };
        return source;
    };
    const context: PlayerAudio = {
        currentTime: 0,
        destination: {},
        resume: async () => {},
        createBuffer: (_channels, length, sampleRate): PlayerBuffer => {
            const data = new Float32Array(length);
            return { duration: length / sampleRate, getChannelData: () => data };
        },
        createBufferSource: sourceOf,
    };
    return { context, scheduled };
};

const standing = () => {
    const socket = new FakeSocket();
    const audio = fakeAudio();
    const deps: SpeechPlayerDeps = {
        socketUrl: async () => `ws://sandbox/speech/say`,
        openSocket: () => socket,
        audioContext: () => audio.context,
    };
    return { player: createSpeechPlayer(deps), socket, audio };
};

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

// `count` samples of mono s16le.
const pcm = (count: number): ArrayBuffer => new ArrayBuffer(count * 2);

describe(`saying something`, () => {
    it(`asks for it once the socket is open, and plays its audio back to back as it arrives`, async () => {
        const { player, socket, audio } = standing();
        const spoken: string[] = [];
        const end = player.say(`Done.`, { key: `read:1`, as: `read`, lang: `pl`, onSpoken: (text) => spoken.push(text) });
        expect(player.speaking.value).toBe(`read:1`);
        expect(player.state.value).toBe(`preparing`);
        await settled();
        socket.open();
        await settled();
        expect(socket.sent).toEqual([{ type: `say`, id: 1, text: `Done.`, as: `read`, lang: `pl` }]);
        socket.answer({ type: `spoken`, id: 1, text: `Gotowe.`, lang: `pl`, voice: `piper/pl_PL-gosia-medium` });
        socket.answer({ type: `audio`, id: 1, sampleRate: 24_000, samples: 240 });
        socket.answer(pcm(240));
        socket.answer({ type: `audio`, id: 1, sampleRate: 24_000, samples: 480 });
        socket.answer(pcm(480));
        expect(spoken).toEqual([`Gotowe.`]);
        expect(player.state.value).toBe(`speaking`);
        // The second starts where the first ends, on the audio clock.
        expect(audio.scheduled).toHaveLength(2);
        expect(audio.scheduled[0]?.at).toBeCloseTo(0.06, 9);
        expect(audio.scheduled[1]?.at).toBeCloseTo(0.07, 9);
        socket.answer({ type: `done`, id: 1 });
        expect(await end).toBe(`done`);
        expect(player.speaking.value).toBeUndefined();
        expect(player.state.value).toBe(`idle`);
    });

    it(`says how far a voice's download is while that is what it waits on`, async () => {
        const { player, socket } = standing();
        void player.say(`Hi.`, { key: `k` });
        await settled();
        socket.open();
        await settled();
        socket.answer({ type: `status`, id: 1, status: { voice: `kokoro/af_heart`, model: `downloading`, received: 25, total: 100 } });
        expect(player.state.value).toBe(`downloading`);
        expect(player.progress.value).toBe(0.25);
    });

    it(`stops what it was saying when asked to say something else`, async () => {
        const { player, socket, audio } = standing();
        const first = player.say(`One.`, { key: `a` });
        await settled();
        socket.open();
        await settled();
        socket.answer({ type: `audio`, id: 1, sampleRate: 24_000, samples: 24_000 });
        socket.answer(pcm(24_000));
        const second = player.say(`Two.`, { key: `b` });
        expect(await first).toBe(`stopped`);
        expect(audio.scheduled[0]?.stopped).toBe(true);
        expect(socket.sent).toContainEqual({ type: `stop`, id: 1 });
        expect(player.speaking.value).toBe(`b`);
        // Audio still arriving for the stopped one is not played.
        socket.answer({ type: `audio`, id: 1, sampleRate: 24_000, samples: 100 });
        socket.answer(pcm(100));
        expect(audio.scheduled).toHaveLength(1);
        player.stop();
        expect(await second).toBe(`stopped`);
    });

    it(`fails with the daemon's own words`, async () => {
        const { player, socket } = standing();
        const end = player.say(`Hi.`, { key: `k` });
        await settled();
        socket.open();
        await settled();
        socket.answer({ type: `error`, id: 1, message: `ElevenLabs refused the API key (401)` });
        expect(await end).toBe(`failed`);
        expect(player.notice.value).toBe(`ElevenLabs refused the API key (401)`);
    });

    it(`fails, saying so, when the sandbox cannot be reached`, async () => {
        const player = createSpeechPlayer({
            socketUrl: async () => undefined,
            openSocket: () => {
                throw new Error(`must not dial`);
            },
            audioContext: () => fakeAudio().context,
        });
        expect(await player.say(`Hi.`, { key: `k` })).toBe(`failed`);
        expect(player.notice.value).toBe(`The sandbox could not be reached to speak.`);
    });
});
