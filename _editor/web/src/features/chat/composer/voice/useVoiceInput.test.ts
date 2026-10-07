import { waitFor } from "@intentic/testing/bun";
import { SandboxHttpError } from "../../../../client/sandbox/sandboxHttpError";

// Pins the two halves of "never a press that can only fail": what the page can never do is found before the mic is
// offered (voiceUnsupported), and what a press did hit stays on screen, counted when it repeats, and reaches analytics.

const sandboxJson = jest.fn((path: string): Promise<unknown> => Promise.reject(new Error(`unexpected ${path}`)));
jest.mock(`../../../../client/sandbox/sandboxClient`, () => ({ sandboxJson }));
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

describe(`a failed press`, () => {
    beforeEach(() => {
        sandboxJson.mockReset();
        track.mockClear();
    });

    it(`keeps its line past the old 8 s auto-clear, until the next press or a dismiss`, async () => {
        sandboxJson.mockImplementation(() => Promise.reject(new SandboxHttpError(404, `Not Found`)));
        const voice = useVoiceInput();
        jest.useFakeTimers();
        try {
            voice.start(() => {});
            await waitFor(() => expect(voice.error.value).toBe(`unavailable`));
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

    it(`reads a refused microphone as blocked, after the sandbox said it can hear`, async () => {
        sandboxJson.mockImplementation(() => Promise.resolve({ provisioned: true, model: `ready` }));
        const refused = new DOMException(`Permission denied`, `NotAllowedError`);
        Object.defineProperty(navigator, `mediaDevices`, { value: { getUserMedia: () => Promise.reject(refused) }, configurable: true });
        try {
            const voice = useVoiceInput();
            voice.start(() => {});
            await waitFor(() => expect(voice.error.value).toBe(`mic-blocked`));
            expect(track).toHaveBeenCalledWith(`voice_failed`, { code: `mic-blocked` });
        } finally {
            delete (navigator as { mediaDevices?: unknown }).mediaDevices;
        }
    });
});
