import { waitFor } from "@intentic/testing/bun";
import { SandboxHttpError } from "../../../../client/sandbox/sandboxHttpError";

// Pins the two halves of "never a press that can only fail": what the page can never do is found before the mic is
// offered (voiceUnsupported), and what a press did hit stays on screen, counted when it repeats, and reaches analytics.
// And the promise the first press makes: the microphone opens at once, whatever the model is doing, and what is said
// while it downloads is written out when it arrives, in order, never lost.

const sandboxJson = jest.fn((path: string, _init?: RequestInit): Promise<unknown> => Promise.reject(new Error(`unexpected ${path}`)));
jest.mock(`../../../../client/sandbox/sandboxClient`, () => ({ sandboxJson }));
// No socket in a test: the link falls back to the WAV door, which this file's sandboxJson answers.
jest.mock(`../../../sandbox/session/wsTicket`, () => ({ socketUrl: async () => undefined }));
const track = jest.fn();
jest.mock(`../../../../app/analytics`, () => ({ track }));

const { useVoiceInput, voiceUnsupported } = await import(`./useVoiceInput`);

// A current Chromium on https with the header allowing the mic: the page every check is a variation of.
const capable = {
    isSecureContext: true,
    navigator: { mediaDevices: { getUserMedia: () => Promise.reject(new Error(`not this test's`)) } },
    AudioWorkletNode: () => {},
    document: { featurePolicy: { allowsFeature: (feature: string) => feature === `microphone` } },
};

describe(`voiceUnsupported`, () => {
    it(`finds nothing in the way of a secure page with capture, a worklet and the mic allowed`, () => {
        expect(voiceUnsupported(capable)).toBeUndefined();
    });

    it(`counts a browser that keeps no policy at all as allowed, since it asks the person instead`, () => {
        expect(voiceUnsupported({ ...capable, document: {} })).toBeUndefined();
    });

    it(`names the page's Permissions-Policy when it withholds the microphone`, () => {
        const denied = { allowsFeature: () => false };
        expect(voiceUnsupported({ ...capable, document: { featurePolicy: denied } })).toBe(`policy`);
        // The spec's newer name wins where a browser has both.
        expect(voiceUnsupported({ ...capable, document: { permissionsPolicy: denied, featurePolicy: capable.document.featurePolicy } })).toBe(
            `policy`,
        );
    });

    it(`blames an insecure page before the APIs it hides, not the browser`, () => {
        expect(voiceUnsupported({ isSecureContext: false, navigator: {}, document: {} })).toBe(`insecure`);
    });

    it(`names the browser when it has no getUserMedia or no AudioWorklet`, () => {
        expect(voiceUnsupported({ ...capable, navigator: {} })).toBe(`browser`);
        expect(voiceUnsupported({ ...capable, navigator: { mediaDevices: {} } })).toBe(`browser`);
        expect(voiceUnsupported({ ...capable, AudioWorkletNode: undefined })).toBe(`browser`);
    });
});

// A microphone that never answers its permission prompt: the sandbox's answer is the one a test reads.
const promptOpen = (): void => {
    Object.defineProperty(navigator, `mediaDevices`, { value: { getUserMedia: () => new Promise(() => {}) }, configurable: true });
};
const noMic = (): void => {
    delete (navigator as { mediaDevices?: unknown }).mediaDevices;
};

describe(`a failed press`, () => {
    beforeEach(() => {
        sandboxJson.mockReset();
        track.mockClear();
        promptOpen();
    });
    afterEach(noMic);

    it(`keeps its line past the old 8 s auto-clear, until the next press or a dismiss`, async () => {
        sandboxJson.mockImplementation(() => Promise.reject(new SandboxHttpError(404, `Not Found`)));
        const voice = useVoiceInput();
        voice.start(() => {});
        await waitFor(() => expect(voice.error.value).toBe(`unavailable`));
        jest.useFakeTimers();
        try {
            jest.advanceTimersByTime(60_000);
            expect([voice.error.value, voice.state.value]).toEqual([`unavailable`, `idle`]);
        } finally {
            jest.useRealTimers();
        }
        voice.dismiss();
        expect(voice.error.value).toBeUndefined();
    });

    it(`counts the same failure coming back, so a re-press can look different from nothing`, async () => {
        sandboxJson.mockImplementation(() => Promise.resolve({ provisioned: false, model: `absent` }));
        const voice = useVoiceInput();
        voice.start(() => {});
        await waitFor(() => expect(voice.error.value).toBe(`needs-rebuild`));
        expect(voice.repeats.value).toBe(0);

        // The press itself clears the line, then the same wall puts it back, counted.
        voice.start(() => {});
        expect(voice.error.value).toBeUndefined();
        await waitFor(() => expect([voice.error.value, voice.repeats.value]).toEqual([`needs-rebuild`, 1]));
        voice.start(() => {});
        await waitFor(() => expect(voice.repeats.value).toBe(2));

        // A different failure is news, not a repeat.
        sandboxJson.mockImplementation(() => Promise.reject(new SandboxHttpError(404, `Not Found`)));
        voice.start(() => {});
        await waitFor(() => expect([voice.error.value, voice.repeats.value]).toEqual([`unavailable`, 0]));
    });

    it(`reports each failure to analytics with its code`, async () => {
        sandboxJson.mockImplementation(() => Promise.resolve({ provisioned: false, model: `absent` }));
        const voice = useVoiceInput();
        voice.start(() => {});
        await waitFor(() => expect(track).toHaveBeenCalledWith(`voice_failed`, { code: `needs-rebuild` }));
        voice.start(() => {});
        await waitFor(() => expect(track).toHaveBeenCalledTimes(2));
    });

    it(`reads a refused microphone as blocked`, async () => {
        sandboxJson.mockImplementation(() => Promise.resolve({ provisioned: true, model: `ready` }));
        const refused = new DOMException(`Permission denied`, `NotAllowedError`);
        Object.defineProperty(navigator, `mediaDevices`, { value: { getUserMedia: () => Promise.reject(refused) }, configurable: true });
        const voice = useVoiceInput();
        voice.start(() => {});
        await waitFor(() => expect(voice.error.value).toBe(`mic-blocked`));
        expect(track).toHaveBeenCalledWith(`voice_failed`, { code: `mic-blocked` });
    });

    it(`says a failed download with its own line, not as a lost phrase`, async () => {
        sandboxJson.mockImplementation(() => Promise.resolve({ provisioned: true, model: `failed`, error: `Hugging Face answered 503` }));
        const voice = useVoiceInput();
        voice.start(() => {});
        await waitFor(() => expect(voice.error.value).toBe(`fetch-failed`));
        expect(voice.model.value?.error).toBe(`Hugging Face answered 503`);
    });
});

// The browser's audio graph, as far as the capture reads it: a context, its worklet module, and the node whose port the
// worklet posts frames on. The test posts the frames itself.
const audioGraph = () => {
    const ports: EventTarget[] = [];
    const globals = globalThis as Record<string, unknown>;
    const saved = { AudioContext: globals[`AudioContext`], AudioWorkletNode: globals[`AudioWorkletNode`], createObjectURL: URL.createObjectURL };
    globals[`AudioContext`] = class {
        sampleRate = 16_000;
        audioWorklet = { addModule: async () => {} };
        resume = async () => {};
        close = async () => {};
        createMediaStreamSource = () => ({ connect: () => {} });
    };
    globals[`AudioWorkletNode`] = class {
        port = Object.assign(new EventTarget(), { start: () => {} });
        constructor() {
            ports.push(this.port);
        }
    };
    URL.createObjectURL = () => `blob:worklet`;
    const stopped: string[] = [];
    Object.defineProperty(navigator, `mediaDevices`, {
        value: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => stopped.push(`track`) }] }) },
        configurable: true,
    });
    const speak = (ms: number, amplitude: number): void => {
        for (let at = 0; at < ms; at += 100) {
            ports.at(-1)?.dispatchEvent(new MessageEvent(`message`, { data: new Float32Array(1600).fill(amplitude) }));
        }
    };
    return {
        speak,
        stopped,
        restore: () => {
            globals[`AudioContext`] = saved.AudioContext;
            globals[`AudioWorkletNode`] = saved.AudioWorkletNode;
            URL.createObjectURL = saved.createObjectURL;
            noMic();
        },
    };
};

describe(`the first press`, () => {
    beforeEach(() => {
        sandboxJson.mockReset();
        track.mockClear();
    });

    it(`listens at once while the model downloads, and writes what was said meanwhile when it arrives, in order`, async () => {
        const graph = audioGraph();
        try {
            let ready = false;
            const posted: number[] = [];
            sandboxJson.mockImplementation(async (path: string, init?: RequestInit) => {
                if (path.startsWith(`/speech/status`)) {
                    return ready
                        ? { provisioned: true, model: `ready`, engine: `parakeet` }
                        : { provisioned: true, model: `downloading`, engine: `parakeet`, received: 100, total: 1000 };
                }
                if (path.startsWith(`/speech/transcribe`)) {
                    const wav = init?.body as ArrayBuffer;
                    posted.push((wav.byteLength - 44) / 2);
                    return { text: `phrase ${posted.length}` };
                }
                throw new Error(`unexpected ${path}`);
            });
            const heard: [string, boolean][] = [];
            const voice = useVoiceInput({ lang: () => `pl-PL` });
            voice.start((text, { live }) => heard.push([text, live]));
            // Listening while the model is still on its way: the press waited for nothing but the microphone.
            await waitFor(() => expect(voice.state.value).toBe(`listening`));
            await waitFor(() => expect(voice.model.value?.model).toBe(`downloading`));
            expect(track).toHaveBeenCalledWith(`voice_started`, expect.objectContaining({ pressToListeningMs: expect.any(Number) }));

            graph.speak(500, 0.1);
            expect(voice.speaking.value).toBe(true);
            graph.speak(1600, 0.001);
            graph.speak(400, 0.1);
            graph.speak(1600, 0.001);
            expect([voice.speaking.value, voice.pending.value]).toEqual([false, 2]);
            expect(posted).toEqual([]);

            ready = true;
            await waitFor(
                () =>
                    expect(heard).toEqual([
                        [`phrase 1`, true],
                        [`phrase 2`, true],
                    ]),
                { timeout: 8000 },
            );
            expect(voice.pending.value).toBe(0);
            expect(track).toHaveBeenCalledWith(
                `voice_phrase`,
                expect.objectContaining({ transport: `http`, endToTextMs: expect.any(Number), heard: true }),
            );
            voice.stop();
            expect(graph.stopped).toEqual([`track`]);
            expect(voice.state.value).toBe(`idle`);
        } finally {
            graph.restore();
        }
    }, 15_000);

    it(`writes a phrase that lands after the mic was stopped, without saying it may be sent`, async () => {
        const graph = audioGraph();
        try {
            let release: () => void = () => {};
            const held = new Promise<void>((resolve) => (release = resolve));
            sandboxJson.mockImplementation(async (path: string) => {
                if (path.startsWith(`/speech/status`)) {
                    return { provisioned: true, model: `ready`, engine: `parakeet` };
                }
                await held;
                return { text: `late words` };
            });
            const heard: [string, boolean][] = [];
            const voice = useVoiceInput({ lang: () => `en` });
            voice.start((text, { live }) => heard.push([text, live]));
            await waitFor(() => expect(voice.state.value).toBe(`listening`));
            graph.speak(500, 0.1);
            graph.speak(1600, 0.001);
            await waitFor(() => expect(sandboxJson).toHaveBeenCalledWith(expect.stringMatching(/^\/speech\/transcribe/u), expect.anything()));
            voice.stop();
            release();
            await waitFor(() => expect(heard).toEqual([[`late words`, false]]));
        } finally {
            graph.restore();
        }
    });
});
