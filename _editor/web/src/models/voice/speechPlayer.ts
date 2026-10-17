import { parseJsonOr } from "@intentic/base/json";
import {
    type SpeakAs,
    type VoiceClientMessage,
    type VoiceId,
    VoiceServerMessageSchema,
    type VoiceStatus,
} from "@intentic/sandbox-contract/schemas/voice";
import { type Ref, shallowRef } from "vue";
import { socketUrl } from "../../client/sandbox/streams/wsTicket";
import { type UtteranceDecoder, utteranceDecoder, voiceOpus } from "./opusVoice";

// The editor's one voice: text goes to the sandbox's speech engine (GET /speech/say, schemas/voice.ts) and its audio
// comes back a sentence at a time, played in order as it arrives. One player for the whole page, since two replies
// spoken at once is noise: saying something new stops whatever was being said. What is speaking is a `key` the caller
// chose (a message id, a preview), so the button that started it can show it as playing and stop it again.

export type SpeechPlayerState = `idle` | `preparing` | `downloading` | `speaking`;

type VoiceClientSay = Extract<VoiceClientMessage, { type: `say` }>;

export type SpeechEnd = `done` | `stopped` | `failed`;

export interface SayOptions {
    /** What the caller calls this utterance; `speaking` holds it while it plays. */
    readonly key: string;
    readonly as?: SpeakAs | undefined;
    readonly lang?: string | undefined;
    readonly voice?: VoiceId | undefined;
    readonly asked?: string | undefined;
    readonly conversationId?: string | undefined;
    /** The words the sandbox chose to say, before they are heard: what a `reply` became. */
    readonly onSpoken?: (text: string) => void;
}

export interface SpeechPlayer {
    readonly state: Ref<SpeechPlayerState>;
    /** The key of what is being said, or undefined when nothing is. */
    readonly speaking: Ref<string | undefined>;
    /** The voice's model download, 0…1, while it is the thing being waited on. */
    readonly progress: Ref<number | undefined>;
    /** The last thing worth saying that did not stop it (a provider failed over), or a failure, until the next say. */
    readonly notice: Ref<string | undefined>;
    /** Says `text`, stopping anything being said; settles when it has been heard, was stopped, or failed. */
    readonly say: (text: string, options: SayOptions) => Promise<SpeechEnd>;
    readonly stop: () => void;
}

/** The slice of a WebSocket the player uses. */
export interface PlayerSocket {
    readonly readyState: number;
    binaryType: BinaryType;
    addEventListener(type: `message` | `open` | `close`, listener: (event: MessageEvent) => void, options?: AddEventListenerOptions): void;
    send(data: string): void;
}

/** What a scheduled sentence's audio is. */
export interface PlayerBuffer {
    readonly duration: number;
    getChannelData(channel: number): Float32Array;
}

/** The slice of an AudioBufferSourceNode the player uses. */
export interface PlayerSource {
    buffer: PlayerBuffer | null;
    // Only ever the context's own destination.
    connect(destination: object): void;
    start(when: number): void;
    stop(): void;
    addEventListener(type: `ended`, listener: () => void, options?: AddEventListenerOptions): void;
}

/** The slice of an AudioContext the player uses: its clock, and buffers scheduled on it. */
export interface PlayerAudio {
    readonly currentTime: number;
    readonly destination: object;
    resume(): Promise<void>;
    createBuffer(channels: number, length: number, sampleRate: number): PlayerBuffer;
    createBufferSource(): PlayerSource;
}

/** The seams a test replaces: the socket, the speaker, and whether and how audio arrives as Opus (opusVoice.ts). */
export interface SpeechPlayerDeps {
    readonly socketUrl: (path: string, extra?: Record<string, string>) => Promise<string | undefined>;
    readonly openSocket: (url: string) => PlayerSocket;
    readonly audioContext: () => PlayerAudio;
    readonly opus: () => Promise<boolean>;
    readonly decoderFor: () => UtteranceDecoder;
}

const DEFAULT_DEPS: SpeechPlayerDeps = {
    socketUrl: (path, extra) => socketUrl(path, extra),
    openSocket: (url) => new WebSocket(url),
    audioContext: () => new AudioContext(),
    opus: voiceOpus,
    decoderFor: utteranceDecoder,
};

// The player's socket: asked for Opus where both ends speak it (opusVoice.ts), again on every dial, since the hello may
// have changed. `adopt` has it the moment it exists, so a close before it opens is still the player's to hear (`lost`).
const dialPlayer = async (
    deps: SpeechPlayerDeps,
    onMessage: (event: MessageEvent) => void,
    adopt: (socket: PlayerSocket) => void,
    lost: (socket: PlayerSocket) => void,
): Promise<PlayerSocket | undefined> => {
    const opus = await deps.opus();
    // allow(silent-catch): no address to dial is the same answer as an unreachable sandbox, which `say` reports in words
    const url = await deps.socketUrl(`/speech/say`, opus ? { codec: `opus` } : {}).catch(() => undefined);
    if (url === undefined) {
        return undefined;
    }
    const opened = deps.openSocket(url);
    opened.binaryType = `arraybuffer`;
    opened.addEventListener(`message`, onMessage);
    opened.addEventListener(`close`, () => lost(opened));
    adopt(opened);
    await new Promise<void>((resolve) => {
        if (opened.readyState === WebSocket.OPEN) {
            resolve();
            return;
        }
        opened.addEventListener(`open`, () => resolve(), { once: true });
        opened.addEventListener(`close`, () => resolve(), { once: true });
    });
    return opened.readyState === WebSocket.OPEN ? opened : undefined;
};

// A frame of mono s16le PCM as samples.
const pcmSamples = (bytes: ArrayBuffer): Float32Array => {
    const view = new DataView(bytes);
    const samples = new Float32Array(Math.floor(bytes.byteLength / 2));
    for (let index = 0; index < samples.length; index += 1) {
        samples[index] = view.getInt16(index * 2, true) / 32_768;
    }
    return samples;
};

// Audio is scheduled this far ahead of now, so the first sentence does not start mid-sample and a late chunk does not
// click against the one before it.
const LEAD_S = 0.06;

interface Current {
    readonly id: number;
    readonly key: string;
    readonly onSpoken?: ((text: string) => void) | undefined;
    readonly settle: (end: SpeechEnd) => void;
    // The audio header waiting for its binary frame.
    header?: { readonly sampleRate: number; readonly samples: number; readonly opus: boolean } | undefined;
    // An Opus utterance's decoder, and the decoding its frames wait on in turn, so chunks play in the order they came.
    decoder?: UtteranceDecoder | undefined;
    decoding?: Promise<void> | undefined;
    // When the last scheduled sample ends, on the audio clock.
    playUntil: number;
    sources: PlayerSource[];
    // The daemon said `done`: settle once the last sample has played.
    finished: boolean;
    endTimer?: ReturnType<typeof setTimeout> | undefined;
}

const statusProgress = (status: VoiceStatus): number | undefined =>
    status.model === `downloading` && status.total !== undefined && status.total > 0 ? (status.received ?? 0) / status.total : undefined;

export const createSpeechPlayer = (overrides: Partial<SpeechPlayerDeps> = {}): SpeechPlayer => {
    const deps = { ...DEFAULT_DEPS, ...overrides };
    const state = shallowRef<SpeechPlayerState>(`idle`);
    const speaking = shallowRef<string | undefined>();
    const progress = shallowRef<number | undefined>();
    const notice = shallowRef<string | undefined>();
    let socket: PlayerSocket | undefined;
    let opening: Promise<PlayerSocket | undefined> | undefined;
    let audio: PlayerAudio | undefined;
    let current: Current | undefined;
    let nextId = 1;

    const finish = (end: SpeechEnd): void => {
        const ending = current;
        if (ending === undefined) {
            return;
        }
        current = undefined;
        clearTimeout(ending.endTimer);
        ending.decoder?.close();
        for (const source of ending.sources) {
            try {
                source.stop();
            } catch {
                // allow(silent-catch): a source that never started, or already ended, has nothing to stop
            }
        }
        state.value = `idle`;
        speaking.value = undefined;
        progress.value = undefined;
        ending.settle(end);
    };

    // Settles once the daemon is done and the audio clock has passed the last sample scheduled.
    const settleWhenPlayed = (playing: Current): void => {
        if (!playing.finished || audio === undefined) {
            return;
        }
        clearTimeout(playing.endTimer);
        const left = Math.max(0, playing.playUntil - audio.currentTime);
        playing.endTimer = setTimeout(
            () => {
                if (current === playing) {
                    finish(`done`);
                }
            },
            left * 1000 + 50,
        );
    };

    const play = (playing: Current, samples: Float32Array, sampleRate: number): void => {
        if (audio === undefined || samples.length === 0) {
            return;
        }
        const buffer = audio.createBuffer(1, samples.length, sampleRate);
        buffer.getChannelData(0).set(samples);
        const source = audio.createBufferSource();
        source.buffer = buffer;
        source.connect(audio.destination);
        const at = Math.max(audio.currentTime + LEAD_S, playing.playUntil);
        source.start(at);
        playing.playUntil = at + buffer.duration;
        playing.sources.push(source);
        source.addEventListener(
            `ended`,
            () => {
                playing.sources = playing.sources.filter((held) => held !== source);
            },
            { once: true },
        );
        state.value = `speaking`;
        progress.value = undefined;
        settleWhenPlayed(playing);
    };

    // An Opus chunk, decoded in turn behind the utterance's earlier chunks and played if the utterance is still on.
    const playOpus = (playing: Current, frame: Uint8Array, sampleRate: number): void => {
        const decoder = (playing.decoder ??= deps.decoderFor());
        playing.decoding = (playing.decoding ?? Promise.resolve())
            .then(async () => {
                if (current === playing) {
                    const decoded = await decoder.decode(frame, sampleRate);
                    if (current === playing) {
                        play(playing, decoded.samples, decoded.sampleRate);
                    }
                }
            })
            // allow(silent-catch): a chunk that will not decode is a gap in the speech, not its end; the rest plays on
            .catch(() => undefined);
    };

    const onMessage = (event: MessageEvent): void => {
        const playing = current;
        if (event.data instanceof ArrayBuffer) {
            if (playing?.header !== undefined) {
                const { sampleRate, opus } = playing.header;
                playing.header = undefined;
                if (opus) {
                    playOpus(playing, new Uint8Array(event.data), sampleRate);
                } else {
                    play(playing, pcmSamples(event.data), sampleRate);
                }
            }
            return;
        }
        // A text frame that is not JSON is no message of the daemon's, ignored like one the schema refuses.
        const message = VoiceServerMessageSchema.safeParse(parseJsonOr(String(event.data), undefined));
        if (!message.success || playing === undefined || (message.data.id !== undefined && message.data.id !== playing.id)) {
            return;
        }
        const said = message.data;
        switch (said.type) {
            case `status`:
                progress.value = statusProgress(said.status);
                if (state.value !== `speaking`) {
                    state.value = progress.value === undefined ? `preparing` : `downloading`;
                }
                return;
            case `spoken`:
                playing.onSpoken?.(said.text);
                return;
            case `audio`:
                playing.header = { sampleRate: said.sampleRate, samples: said.samples, opus: said.codec === `opus` };
                return;
            case `notice`:
                notice.value = said.message;
                return;
            case `done`:
                // After whatever is still being decoded: until then, the end of the audio is not known.
                void (playing.decoding ?? Promise.resolve()).then(() => {
                    if (current !== playing) {
                        return;
                    }
                    playing.finished = true;
                    if (playing.playUntil === 0) {
                        finish(`done`);
                    } else {
                        settleWhenPlayed(playing);
                    }
                });
                return;
            case `error`:
                notice.value = said.message;
                finish(`failed`);
                return;
        }
    };

    const connect = (): Promise<PlayerSocket | undefined> => {
        if (socket !== undefined && socket.readyState <= WebSocket.OPEN) {
            return Promise.resolve(socket);
        }
        const adopt = (opened: PlayerSocket): void => {
            socket = opened;
        };
        const lost = (closedSocket: PlayerSocket): void => {
            if (socket === closedSocket) {
                socket = undefined;
                if (current !== undefined) {
                    notice.value = `The sandbox stopped answering.`;
                    finish(`failed`);
                }
            }
        };
        opening ??= dialPlayer(deps, onMessage, adopt, lost).finally(() => {
            opening = undefined;
        });
        return opening;
    };

    const stop = (): void => {
        const stopping = current;
        if (stopping === undefined) {
            return;
        }
        if (socket?.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: `stop`, id: stopping.id }));
        }
        finish(`stopped`);
    };

    const say = (text: string, options: SayOptions): Promise<SpeechEnd> => {
        stop();
        notice.value = undefined;
        // Made inside the press that asked, where the browser lets a page start sound.
        audio ??= deps.audioContext();
        // allow(silent-catch): a context the browser will not resume stays silent, and the reply is still on screen to read
        void audio.resume().catch(() => undefined);
        const id = nextId++;
        return new Promise<SpeechEnd>((settle) => {
            const playing: Current = { id, key: options.key, onSpoken: options.onSpoken, settle, playUntil: 0, sources: [], finished: false };
            current = playing;
            state.value = `preparing`;
            speaking.value = options.key;
            void connect().then((open) => {
                if (current !== playing) {
                    return;
                }
                if (open === undefined) {
                    notice.value = `The sandbox could not be reached to speak.`;
                    finish(`failed`);
                    return;
                }
                // An option left undefined is left out by JSON itself.
                const message = {
                    type: `say` as const,
                    id,
                    text,
                    as: options.as ?? `plain`,
                    lang: options.lang,
                    voice: options.voice,
                    asked: options.asked,
                    conversationId: options.conversationId,
                } satisfies VoiceClientSay;
                open.send(JSON.stringify(message));
            });
        });
    };

    return { state, speaking, progress, notice, say, stop };
};

let shared: SpeechPlayer | undefined;

/** The page's one player. */
export const useSpeechPlayer = (): SpeechPlayer => (shared ??= createSpeechPlayer());
