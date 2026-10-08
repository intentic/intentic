import { waitFor } from "@intentic/testing/bun";
import type { SpeechStatus } from "@intentic/sandbox-contract";
import { SandboxHttpError } from "../../../../client/sandbox/sandboxHttpError";

// Pins the composer's wire to the speech engine: whatever is said before a transport answers is kept and replayed, the
// live stream frames phrases as the contract says and reports back what the daemon says, a daemon without the stream
// gets one WAV per phrase once its model is on disk, and a socket lost mid-phrase costs that phrase, not the session.

jest.mock(`../../../sandbox/session/wsTicket`, () => ({ socketUrl: async () => undefined }));
jest.mock(`../../../../client/sandbox/sandboxClient`, () => ({ sandboxJson: () => Promise.reject(new Error(`unmocked`)) }));

const { openSpeechLink } = await import(`./speechLink`);
type Events = Parameters<typeof openSpeechLink>[1];

const READY: SpeechStatus = { provisioned: true, model: `ready`, engine: `parakeet`, loaded: true };

const recorder = () => {
    const said: unknown[][] = [];
    const events: Events = {
        status: (status) => said.push([`status`, status.model]),
        partial: (id, text) => said.push([`partial`, id, text]),
        final: (id, text) => said.push([`final`, id, text]),
        failed: (id, failure) => said.push([`failed`, id, failure]),
        transport: (chosen) => said.push([`transport`, chosen]),
    };
    return { said, events };
};

// A socket the test drives: it opens (or refuses) when told, records what was sent, and delivers what the test says.
class FakeSocket extends EventTarget {
    readyState: number = WebSocket.CONNECTING;
    binaryType = `blob`;
    readonly sent: unknown[] = [];
    send(data: unknown): void {
        this.sent.push(typeof data === `string` ? JSON.parse(data) : (data as ArrayBuffer).byteLength);
    }
    close(): void {
        this.readyState = WebSocket.CLOSED;
        this.dispatchEvent(new Event(`close`));
    }
    open(): void {
        this.readyState = WebSocket.OPEN;
        this.dispatchEvent(new Event(`open`));
    }
    refuse(): void {
        this.readyState = WebSocket.CLOSED;
        this.dispatchEvent(new Event(`error`));
    }
    say(message: unknown): void {
        this.dispatchEvent(new MessageEvent(`message`, { data: JSON.stringify(message) }));
    }
}

const samples = (count: number): Float32Array => new Float32Array(count).fill(0.1);

describe(`on the live stream`, () => {
    it(`replays what was said before the socket opened, frames phrases as the contract says, and reports the daemon's words`, async () => {
        const sockets: FakeSocket[] = [];
        const { said, events } = recorder();
        const link = openSpeechLink(`pl-PL`, events, {
            socketUrl: async (path, extra) => `ws://daemon${path}?lang=${extra[`lang`]}`,
            openSocket: (url) => {
                expect(url).toBe(`ws://daemon/speech/stream?lang=pl-PL`);
                const socket = new FakeSocket();
                sockets.push(socket);
                return socket as unknown as WebSocket;
            },
        });
        // Spoken while the socket was still dialing.
        link.begin(0, samples(4800));
        link.audio(0, samples(1600));
        link.end(0, samples(5000));
        await waitFor(() => expect(sockets).toHaveLength(1));
        const socket = sockets[0]!;
        socket.open();
        await waitFor(() => expect(said).toContainEqual([`transport`, `stream`]));
        // begin, its opening as s16le (2 bytes a sample), the frame after, then end with what was kept.
        expect(socket.sent).toEqual([{ type: `begin`, id: 0 }, 9600, 3200, { type: `end`, id: 0, keep: 5000 }]);

        link.begin(1, samples(160));
        link.drop(1);
        expect(socket.sent.slice(4)).toEqual([{ type: `begin`, id: 1 }, 320, { type: `drop`, id: 1 }]);

        socket.say({ type: `status`, status: READY });
        socket.say({ type: `partial`, id: 0, text: `dzień` });
        socket.say({ type: `final`, id: 0, text: `Dzień dobry.`, decodeMs: 120 });
        socket.say({ type: `error`, id: 2, message: `boom` });
        socket.say({ type: `not a message` });
        expect(said.slice(1)).toEqual([
            [`status`, `ready`],
            [`partial`, 0, `dzień`],
            [`final`, 0, `Dzień dobry.`],
            [`failed`, 2, `phrase`],
        ]);
        link.close();
    });

    it(`says the sandbox cannot hear when the daemon reports no runtime`, async () => {
        const socket = new FakeSocket();
        const { said, events } = recorder();
        let dialed = false;
        openSpeechLink(`en`, events, {
            socketUrl: async () => `ws://daemon`,
            openSocket: () => {
                dialed = true;
                return socket as unknown as WebSocket;
            },
        });
        await waitFor(() => expect(dialed).toBe(true));
        socket.open();
        await waitFor(() => expect(said).toContainEqual([`transport`, `stream`]));
        socket.say({ type: `status`, status: { provisioned: false, model: `absent` } });
        expect(said).toContainEqual([`failed`, undefined, `unprovisioned`]);
    });

    it(`loses only the phrases in flight when the socket drops, and dials again for the next`, async () => {
        const sockets: FakeSocket[] = [];
        const { said, events } = recorder();
        const link = openSpeechLink(`en`, events, {
            socketUrl: async () => `ws://daemon`,
            openSocket: () => {
                const socket = new FakeSocket();
                sockets.push(socket);
                queueMicrotask(() => socket.open());
                return socket as unknown as WebSocket;
            },
        });
        await waitFor(() => expect(said).toContainEqual([`transport`, `stream`]));
        link.begin(0, samples(10));
        link.end(0, samples(10));
        // A phrase begun on the lost socket cannot be finished on the next one.
        link.begin(1, samples(10));
        sockets[0]!.close();
        expect(said).toContainEqual([`failed`, 0, `phrase`]);
        await waitFor(() => expect(sockets).toHaveLength(2));
        await waitFor(() => expect(said.filter(([kind]) => kind === `transport`)).toHaveLength(2));
        link.end(1, samples(10));
        expect(said).toContainEqual([`failed`, 1, `phrase`]);
        link.begin(2, samples(10));
        link.end(2, samples(10));
        expect(sockets[1]!.sent).toEqual([{ type: `begin`, id: 2 }, 20, { type: `end`, id: 2, keep: 10 }]);
        link.close();
    });
});

describe(`on a daemon without the stream`, () => {
    it(`polls the model while it downloads, then posts each phrase spoken meanwhile as a WAV, in order`, async () => {
        const statuses: SpeechStatus[] = [
            { provisioned: true, model: `downloading`, engine: `parakeet`, received: 1, total: 10 },
            { provisioned: true, model: `downloading`, engine: `parakeet`, received: 5, total: 10 },
            READY,
        ];
        const posted: number[] = [];
        const sandboxJson = jest.fn(async (path: string, init?: RequestInit): Promise<unknown> => {
            if (path.startsWith(`/speech/status?lang=pl`)) {
                return statuses.shift() ?? READY;
            }
            if (path.startsWith(`/speech/transcribe?lang=pl`) && init?.method === `POST`) {
                const wav = init.body as ArrayBuffer;
                posted.push((wav.byteLength - 44) / 2);
                return { text: `phrase of ${(wav.byteLength - 44) / 2}` };
            }
            throw new Error(`unexpected ${path}`);
        });
        const { said, events } = recorder();
        // A refused upgrade is a daemon with no stream route.
        const socket = new FakeSocket();
        const link = openSpeechLink(`pl`, events, {
            socketUrl: async () => `ws://daemon`,
            openSocket: () => {
                queueMicrotask(() => socket.refuse());
                return socket as unknown as WebSocket;
            },
            sandboxJson: sandboxJson as never,
            pollMs: 5,
        });
        link.begin(0, samples(100));
        link.end(0, samples(100));
        link.begin(1, samples(200));
        link.audio(1, samples(50));
        link.end(1, samples(250));
        await waitFor(() => expect(said.filter(([kind]) => kind === `final`)).toHaveLength(2));
        expect(posted).toEqual([100, 250]);
        expect(said).toEqual([
            [`transport`, `http`],
            [`status`, `downloading`],
            [`status`, `downloading`],
            [`status`, `ready`],
            [`final`, 0, `phrase of 100`],
            [`final`, 1, `phrase of 250`],
        ]);
        link.close();
    });

    it(`keeps a phrase the daemon says is early (409) and posts it once the model is back`, async () => {
        let transcribes = 0;
        const sandboxJson = jest.fn(async (path: string): Promise<unknown> => {
            if (path.startsWith(`/speech/status`)) {
                return READY;
            }
            transcribes += 1;
            if (transcribes === 1) {
                throw new SandboxHttpError(409, `Conflict`);
            }
            return { text: `kept` };
        });
        const { said, events } = recorder();
        const link = openSpeechLink(`en`, events, { sandboxJson: sandboxJson as never, pollMs: 5 });
        link.begin(0, samples(10));
        link.end(0, samples(10));
        await waitFor(() => expect(said).toContainEqual([`final`, 0, `kept`]));
        expect(transcribes).toBe(2);
        link.close();
    });

    it(`reads a daemon without speech routes as unavailable, and one without a runtime as unprovisioned`, async () => {
        const missing = recorder();
        openSpeechLink(`en`, missing.events, { sandboxJson: (() => Promise.reject(new SandboxHttpError(404, `Not Found`))) as never });
        await waitFor(() => expect(missing.said).toContainEqual([`failed`, undefined, `unavailable`]));

        const bare = recorder();
        openSpeechLink(`en`, bare.events, { sandboxJson: (async () => ({ provisioned: false, model: `absent` })) as never });
        await waitFor(() => expect(bare.said).toContainEqual([`failed`, undefined, `unprovisioned`]));
    });
});
