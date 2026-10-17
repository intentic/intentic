import "@intentic/testing/dom";
import { waitFor } from "@intentic/testing/bun";
import type { SpeechStatus } from "@intentic/sandbox-contract/schemas/speech";
import { SandboxHttpError } from "../../client/sandbox/sandboxHttpError";

// Pins the composer's wire to the speech engine: whatever is said before a transport answers is kept and replayed, the
// live stream frames phrases as the contract says and reports back what the daemon says, a daemon without the stream
// gets one WAV per phrase once its model is on disk, and a socket lost mid-phrase costs that phrase, not the session. The
// stream is a live socket, so it is pinged and dialled again after a drop; the clock below runs it in milliseconds.

jest.mock(`../../client/sandbox/streams/wsTicket`, () => ({ socketUrl: async () => undefined }));
jest.mock(`../../client/sandbox/sandboxClient`, () => ({ sandboxJson: () => Promise.reject(new Error(`unmocked`)) }));

const { openSpeechLink } = await import(`./speechLink`);
type Events = Parameters<typeof openSpeechLink>[1];
type SpeechLinkDeps = NonNullable<Parameters<typeof openSpeechLink>[2]>;

// Short enough that a redial happens inside a test, long enough that nothing fires between two lines of one. The ping is
// slow, so a frame list a test compares is the message's own on a busy machine too; the ping test below runs its own.
const FAST = { pingMs: 60_000, retryMs: 10, maxRetryMs: 20, stableMs: 10_000, staleMs: 10_000 };

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
    // Closing a socket that is already closed says nothing more, as in a browser.
    close(): void {
        if (this.readyState === WebSocket.CLOSED) {
            return;
        }
        this.readyState = WebSocket.CLOSED;
        this.dispatchEvent(new Event(`close`));
    }
    open(): void {
        this.readyState = WebSocket.OPEN;
        this.dispatchEvent(new Event(`open`));
    }
    // An upgrade the daemon refused: the browser reports the error and then the close.
    refuse(): void {
        this.readyState = WebSocket.CLOSED;
        this.dispatchEvent(new Event(`error`));
        this.dispatchEvent(new Event(`close`));
    }
    say(message: unknown): void {
        this.dispatchEvent(new MessageEvent(`message`, { data: JSON.stringify(message) }));
    }
}

// SAFETY: FakeSocket carries every member of WebSocket the link touches: send, close, readyState, binaryType and the events.
const asSocket = (socket: FakeSocket): WebSocket => socket as unknown as WebSocket;
// SAFETY: a test's stand-in for the raw door answers only the routes its test asks it, each as that route's schema would parse it.
const asRaw = (seam: object): SpeechLinkDeps[`raw`] => seam as SpeechLinkDeps[`raw`];

const samples = (count: number): Float32Array => new Float32Array(count).fill(0.1);

describe(`on the live stream`, () => {
    it(`replays what was said before the socket opened, frames phrases as the contract says, and reports the daemon's words`, async () => {
        const sockets: FakeSocket[] = [];
        const { said, events } = recorder();
        const link = openSpeechLink(`pl-PL`, events, {
            timing: FAST,
            socketUrl: async (path, extra) => `ws://daemon${path}?lang=${extra[`lang`]}`,
            openSocket: (url) => {
                expect(url).toBe(`ws://daemon/speech/stream?lang=pl-PL`);
                const socket = new FakeSocket();
                sockets.push(socket);
                return asSocket(socket);
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

    // Both ends speak Opus: the socket asks for it, and each phrase's packets (which an encoder hands back later, as
    // WebCodecs does) leave after its begin and before its end, and never interleave with the next phrase's.
    it(`asks for Opus where both ends speak it, and keeps each phrase's packets between its begin and its end`, async () => {
        const sockets: FakeSocket[] = [];
        const { said, events } = recorder();
        // An encoder that turns each push into one packet of a tenth of its PCM size, a tick later.
        const encoderFor: SpeechLinkDeps[`encoderFor`] = (send) => {
            const held: ArrayBuffer[] = [];
            let started = false;
            let pending = Promise.resolve();
            return {
                push: (pushed) => {
                    pending = pending.then(async () => {
                        await new Promise((resolve) => setTimeout(resolve, 1));
                        const packet = new ArrayBuffer(pushed.length / 5);
                        if (started) {
                            send(packet);
                        } else {
                            held.push(packet);
                        }
                    });
                },
                start: () => {
                    started = true;
                    for (const packet of held.splice(0)) {
                        send(packet);
                    }
                },
                finish: async () => pending,
                close: () => undefined,
            };
        };
        const link = openSpeechLink(`en`, events, {
            timing: FAST,
            opus: async () => true,
            encoderFor,
            socketUrl: async (path, extra) => `ws://daemon${path}?${new URLSearchParams(extra).toString()}`,
            openSocket: (url) => {
                expect(url).toBe(`ws://daemon/speech/stream?lang=en&codec=opus`);
                const socket = new FakeSocket();
                sockets.push(socket);
                return asSocket(socket);
            },
        });
        await waitFor(() => expect(sockets).toHaveLength(1));
        const socket = sockets[0]!;
        socket.open();
        await waitFor(() => expect(said).toContainEqual([`transport`, `stream`]));
        link.begin(0, samples(4800));
        link.audio(0, samples(1600));
        link.end(0, samples(5000));
        link.begin(1, samples(800));
        link.end(1, samples(800));
        await waitFor(() => expect(socket.sent).toHaveLength(7));
        // Packets are a fifth of the samples' count in bytes: a tenth of the PCM's.
        expect(socket.sent).toEqual([
            { type: `begin`, id: 0 },
            960,
            320,
            { type: `end`, id: 0, keep: 5000 },
            { type: `begin`, id: 1 },
            160,
            { type: `end`, id: 1, keep: 800 },
        ]);
        link.close();
    });

    it(`says the sandbox cannot hear when the daemon reports no runtime`, async () => {
        const socket = new FakeSocket();
        const { said, events } = recorder();
        let dialed = false;
        openSpeechLink(`en`, events, {
            timing: FAST,
            socketUrl: async () => `ws://daemon`,
            openSocket: () => {
                dialed = true;
                return asSocket(socket);
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
            timing: FAST,
            socketUrl: async () => `ws://daemon`,
            openSocket: () => {
                const socket = new FakeSocket();
                sockets.push(socket);
                queueMicrotask(() => socket.open());
                return asSocket(socket);
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

describe(`as a live socket`, () => {
    it(`pings the open stream, which the daemon ignores, so an idle tunnel is not left to drop it`, async () => {
        const socket = new FakeSocket();
        const { said, events } = recorder();
        const link = openSpeechLink(`en`, events, {
            timing: { ...FAST, pingMs: 40 },
            socketUrl: async () => `ws://daemon`,
            openSocket: () => {
                queueMicrotask(() => socket.open());
                return asSocket(socket);
            },
        });
        await waitFor(() => expect(said).toContainEqual([`transport`, `stream`]));
        await waitFor(() => expect(socket.sent).toContainEqual({ type: `ping` }));
        link.close();
    });

    it(`dials again after a drop on its own, with nobody speaking, and holds what is said meanwhile`, async () => {
        const sockets: FakeSocket[] = [];
        const { said, events } = recorder();
        const link = openSpeechLink(`en`, events, {
            timing: FAST,
            socketUrl: async () => `ws://daemon`,
            openSocket: () => {
                const socket = new FakeSocket();
                sockets.push(socket);
                // The first connection is a daemon restarting: the second one is not ready until a moment later.
                setTimeout(() => socket.open(), sockets.length === 1 ? 0 : 30);
                return asSocket(socket);
            },
        });
        await waitFor(() => expect(said.filter(([kind]) => kind === `transport`)).toHaveLength(1));
        sockets[0]!.close();
        // Said while no socket is open: kept for the one being dialled.
        link.begin(5, samples(10));
        link.end(5, samples(10));
        await waitFor(() => expect(said.filter(([kind]) => kind === `transport`)).toHaveLength(2));
        expect(sockets).toHaveLength(2);
        expect(sockets[1]!.sent).toEqual([{ type: `begin`, id: 5 }, 20, { type: `end`, id: 5, keep: 10 }]);
        link.close();
    });

    it(`lets the socket go with the link, so one still being dialled never opens afterwards`, async () => {
        const sockets: FakeSocket[] = [];
        const { said, events } = recorder();
        const link = openSpeechLink(`en`, events, {
            timing: FAST,
            socketUrl: async () => `ws://daemon`,
            openSocket: () => {
                const socket = new FakeSocket();
                sockets.push(socket);
                return asSocket(socket);
            },
        });
        await waitFor(() => expect(sockets).toHaveLength(1));
        link.close();
        sockets[0]!.open();
        await new Promise((resolve) => setTimeout(resolve, 60));
        expect(said).not.toContainEqual([`transport`, `stream`]);
        expect(sockets).toHaveLength(1);
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
        const raw = jest.fn(async (key: string, call?: { readonly query?: { readonly lang?: string }; readonly input?: unknown }): Promise<unknown> => {
            if (key === `GET /speech/status` && call?.query?.lang === `pl`) {
                return statuses.shift() ?? READY;
            }
            if (key === `POST /speech/transcribe` && call?.query?.lang === `pl`) {
                const wav = call.input as ArrayBuffer;
                posted.push((wav.byteLength - 44) / 2);
                return { text: `phrase of ${(wav.byteLength - 44) / 2}` };
            }
            throw new Error(`unexpected ${key}`);
        });
        const { said, events } = recorder();
        // A refused upgrade is a daemon with no stream route.
        const socket = new FakeSocket();
        const link = openSpeechLink(`pl`, events, {
            timing: FAST,
            socketUrl: async () => `ws://daemon`,
            openSocket: () => {
                queueMicrotask(() => socket.refuse());
                return asSocket(socket);
            },
            raw: asRaw(raw),
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
        const raw = jest.fn(async (key: string): Promise<unknown> => {
            if (key === `GET /speech/status`) {
                return READY;
            }
            transcribes += 1;
            if (transcribes === 1) {
                throw new SandboxHttpError(409, `Conflict`);
            }
            return { text: `kept` };
        });
        const { said, events } = recorder();
        const link = openSpeechLink(`en`, events, { raw: asRaw(raw), pollMs: 5 });
        link.begin(0, samples(10));
        link.end(0, samples(10));
        await waitFor(() => expect(said).toContainEqual([`final`, 0, `kept`]));
        expect(transcribes).toBe(2);
        link.close();
    });

    it(`reads a daemon without speech routes as unavailable, and one without a runtime as unprovisioned`, async () => {
        const missing = recorder();
        openSpeechLink(`en`, missing.events, { raw: asRaw(() => Promise.reject(new SandboxHttpError(404, `Not Found`))) });
        await waitFor(() => expect(missing.said).toContainEqual([`failed`, undefined, `unavailable`]));

        const bare = recorder();
        openSpeechLink(`en`, bare.events, { raw: asRaw(async () => ({ provisioned: false, model: `absent` })) });
        await waitFor(() => expect(bare.said).toContainEqual([`failed`, undefined, `unprovisioned`]));
    });
});
