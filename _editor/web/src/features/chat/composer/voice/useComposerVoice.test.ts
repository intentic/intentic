import type { SpeechStatus } from "@intentic/sandbox-contract";
import { createApp, defineComponent, h, ref, shallowRef } from "vue";
import type { Heard, VoiceError, VoiceInput, VoiceState } from "./useVoiceInput";

// Pins what the composer makes of voice: the words appear in the box while they are spoken and are replaced by what
// was heard, the pause sends only once nothing more is coming, words that land after a stop are written and not sent,
// the model's download is a progress row while the mic already listens, and a failure stays on screen with the one way
// past it, offered only to a reader who may take it.

jest.mock(`../../../../client/sandbox/sandboxClient`, () => ({ sandboxJson: () => Promise.reject(new Error(`unmocked`)) }));
jest.mock(`../../../sandbox/session/wsTicket`, () => ({ socketUrl: async () => undefined }));
jest.mock(`../../../../app/analytics`, () => ({ track: jest.fn() }));

const { useComposerVoice } = await import(`./useComposerVoice`);
type Voice = ReturnType<typeof useComposerVoice>;

const capable = {
    isSecureContext: true,
    navigator: { mediaDevices: { getUserMedia: () => Promise.reject(new Error(`not this test's`)) } },
    AudioWorkletNode: () => {},
    document: {},
};

// The voice input as the composer sees it, driven by the test: `say` delivers a phrase's words, the refs are set directly.
const fakeInput = () => {
    let onTranscript: ((text: string, heard: Heard) => void) | undefined;
    const calls: string[] = [];
    const input: VoiceInput = {
        state: ref<VoiceState>(`idle`),
        level: ref(0),
        pending: ref(0),
        speaking: ref(false),
        interim: ref(``),
        model: shallowRef<SpeechStatus>(),
        bridged: ref(false),
        error: ref<VoiceError>(),
        repeats: ref(0),
        start: (transcript) => {
            onTranscript = transcript;
            input.state.value = `listening`;
            calls.push(`start`);
        },
        stop: () => {
            input.state.value = `idle`;
            calls.push(`stop`);
        },
        abandon: () => {
            input.state.value = `idle`;
            input.interim.value = ``;
            calls.push(`abandon`);
        },
        dismiss: () => {
            input.error.value = undefined;
        },
        retry: () => calls.push(`retry`),
        warm: () => calls.push(`warm`),
    };
    return { input, calls, say: (text: string, live = true) => onTranscript?.(text, { live }) };
};

// Mounted, since the composable lets go of the mic on unmount.
const mounted = (options: { manages?: boolean; page?: Parameters<typeof useComposerVoice>[0][`page`]; draft?: string } = {}) => {
    const fake = fakeInput();
    const draft = ref(options.draft ?? ``);
    const sent: string[] = [];
    let voice!: Voice;
    createApp(
        defineComponent({
            setup() {
                voice = useComposerVoice({
                    draft,
                    reachable: ref(true),
                    manages: ref(options.manages ?? true),
                    grew: () => {},
                    send: () => {
                        sent.push(draft.value);
                        draft.value = ``;
                    },
                    page: options.page ?? capable,
                    input: fake.input,
                });
                return () => h(`div`);
            },
        }),
    ).mount(document.createElement(`div`));
    return { voice, draft, sent, ...fake };
};

afterEach(() => {
    jest.useRealTimers();
});

describe(`a page that can never record`, () => {
    it(`disables the press and says why on the button, never starting the capture`, () => {
        const { voice, calls } = mounted({ page: { ...capable, document: { featurePolicy: { allowsFeature: () => false } } } });
        expect(voice.unsupported).toBe(`policy`);
        expect(voice.buttonHint.value).toEqual({
            title: `Talk hands-free`,
            note: `Unavailable here: this page isn't allowed to use the microphone.`,
        });
        voice.toggle();
        expect(calls).toEqual([]);
    });
});

describe(`words as they are spoken`, () => {
    it(`show in the box while spoken, are replaced by what was heard, and go after the glance window`, () => {
        jest.useFakeTimers();
        const { voice, input, draft, sent, say } = mounted({ draft: `Note:` });
        voice.toggle();
        input.speaking.value = true;
        input.interim.value = `dodaj test`;
        expect(draft.value).toBe(`Note: dodaj test`);
        input.interim.value = `dodaj test dla segmentera`;
        expect(draft.value).toBe(`Note: dodaj test dla segmentera`);
        input.speaking.value = false;
        // The final lands, then its guess is let go (useVoiceInput's order): the words replace the guess in place.
        say(`Dodaj test dla segmentera.`);
        input.interim.value = ``;
        expect(draft.value).toBe(`Note: Dodaj test dla segmentera.`);
        expect(voice.armed.value).toBe(true);
        expect(voice.slotHint.value).toBe(`Sending: Esc to edit`);
        jest.advanceTimersByTime(1200);
        expect(sent).toEqual([`Note: Dodaj test dla segmentera.`]);
    });

    it(`hold the send while more is being said or heard, then give the glance window again`, () => {
        jest.useFakeTimers();
        const { voice, input, sent, say } = mounted();
        voice.toggle();
        say(`First part.`);
        input.speaking.value = true;
        jest.advanceTimersByTime(5000);
        expect(sent).toEqual([]);
        input.speaking.value = false;
        input.pending.value = 1;
        jest.advanceTimersByTime(5000);
        expect(sent).toEqual([]);
        input.pending.value = 0;
        say(`Second part.`);
        jest.advanceTimersByTime(1199);
        expect(sent).toEqual([]);
        jest.advanceTimersByTime(1);
        expect(sent).toEqual([`First part. Second part.`]);
    });

    it(`go into the box but are not sent when they land after the mic was stopped`, () => {
        jest.useFakeTimers();
        const { voice, draft, sent, say } = mounted();
        voice.toggle();
        voice.toggle();
        say(`late words`, false);
        jest.advanceTimersByTime(5000);
        expect([draft.value, sent]).toEqual([`late words`, []]);
    });

    it(`stay as written text when typing takes over mid-guess`, () => {
        const { voice, input, draft, calls } = mounted();
        voice.toggle();
        input.interim.value = `half a sent`;
        // composerKeys' input handler calls quit on every keystroke.
        voice.quit();
        expect(calls).toContain(`abandon`);
        expect(draft.value).toBe(`half a sent`);
    });
});

describe(`the model on its way`, () => {
    it(`is a progress row while the mic listens: how far, then how long, and that speech waits`, () => {
        jest.useFakeTimers();
        const { voice, input } = mounted();
        voice.toggle();
        input.model.value = { provisioned: true, model: `downloading`, engine: `parakeet`, received: 0, total: 640 * 1_048_576 };
        expect(voice.setup.value).toEqual({
            fraction: 0,
            line: `Setting up voice: 0 B of 640 MB · speak now, nothing is lost`,
            valuetext: `Setting up voice: 0 B of 640 MB`,
        });
        expect(voice.slotHint.value).toBe(`Listening: keep talking, your words appear as soon as voice is ready`);
        // Two seconds later, a fifth of it: the pace says how long the rest takes.
        jest.advanceTimersByTime(2000);
        input.pending.value = 2;
        input.model.value = { provisioned: true, model: `downloading`, engine: `parakeet`, received: 128 * 1_048_576, total: 640 * 1_048_576 };
        expect(voice.setup.value?.line).toBe(`Setting up voice: 128 MB of 640 MB · about 8 seconds left · 2 phrases waiting`);
        expect(voice.setup.value?.fraction).toBeCloseTo(0.2);

        input.bridged.value = true;
        expect(voice.setup.value?.line).toContain(`your browser is writing meanwhile`);
        expect(voice.slotHint.value).toBe(`Listening: your browser writes, on this device, until voice is ready`);

        input.model.value = { provisioned: true, model: `ready`, engine: `parakeet` };
        expect(voice.setup.value).toBeUndefined();
    });

    it(`is no row when the mic is off and nothing is waiting`, () => {
        const { voice, input } = mounted();
        input.model.value = { provisioned: true, model: `downloading`, engine: `parakeet`, received: 1, total: 10 };
        expect(voice.setup.value).toBeUndefined();
    });

    it(`is loaded ahead when the pointer reaches the mic`, () => {
        const { voice, calls } = mounted();
        voice.warm();
        expect(calls).toEqual([`warm`]);
    });
});

describe(`a failed press`, () => {
    it(`offers the update card's own button when the sandbox cannot hear, as a warning`, () => {
        const { voice, input } = mounted();
        input.error.value = `needs-rebuild`;
        expect(voice.failure.value).toMatchObject({
            code: `needs-rebuild`,
            message: `Voice isn't available on this version of the sandbox. Updating it adds it.`,
            tone: `warning`,
            action: { to: `/sandbox#sandbox-update-action` },
            repeats: 0,
        });
        input.error.value = `unavailable`;
        expect(voice.failure.value?.action?.to).toBe(`/sandbox#sandbox-update-action`);
    });

    it(`offers no page to a reader who could not act on it`, () => {
        const { voice, input } = mounted({ manages: false });
        input.error.value = `needs-rebuild`;
        expect(voice.failure.value?.action).toBeUndefined();
    });

    it(`offers a retry for a failed download to anyone, since retrying is no change to the sandbox`, () => {
        const { voice, input, calls } = mounted({ manages: false });
        input.error.value = `fetch-failed`;
        expect(voice.failure.value).toMatchObject({ code: `fetch-failed`, tone: `warning`, action: { label: `Retry` } });
        voice.failure.value?.action?.run?.();
        expect(calls).toEqual([`retry`]);
    });

    it(`goes when typing starts or the line is dismissed`, () => {
        const { voice, input } = mounted();
        input.error.value = `failed`;
        voice.quit();
        expect(voice.failure.value).toBeUndefined();
        input.error.value = `failed`;
        voice.dismiss();
        expect(voice.failure.value).toBeUndefined();
    });
});
