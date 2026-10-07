import { waitFor } from "@intentic/testing/bun";
import { createApp, defineComponent, h, ref } from "vue";
import { SandboxHttpError } from "../../../client/sandbox/sandboxHttpError";

// Pins what the composer makes of voice's failures: a page that can never record disables the mic and says why, and a
// failure stays on screen with the one page that fixes it, offered only to a reader who may act there.

const sandboxJson = jest.fn((path: string): Promise<unknown> => Promise.reject(new Error(`unexpected ${path}`)));
jest.mock(`../../../client/sandbox/sandboxClient`, () => ({ sandboxJson }));
jest.mock(`../../../app/analytics`, () => ({ track: jest.fn() }));

const { useComposerVoice } = await import(`./useComposerVoice`);
type Voice = ReturnType<typeof useComposerVoice>;

const capable = {
    isSecureContext: true,
    navigator: { mediaDevices: { getUserMedia: () => Promise.reject(new Error(`not this test's`)) } },
    AudioWorkletNode: () => {},
    document: {},
};

// Mounted, since the composable lets go of the mic on unmount.
const mounted = (options: { manages?: boolean; page?: Parameters<typeof useComposerVoice>[0][`page`] } = {}): Voice => {
    let voice!: Voice;
    createApp(
        defineComponent({
            setup() {
                voice = useComposerVoice({
                    draft: ref(``),
                    reachable: ref(true),
                    manages: ref(options.manages ?? true),
                    grew: () => {},
                    send: () => {},
                    page: options.page ?? capable,
                });
                return () => h(`div`);
            },
        }),
    ).mount(document.createElement(`div`));
    return voice;
};

beforeEach(() => {
    sandboxJson.mockReset();
});

describe(`a page that can never record`, () => {
    it(`disables the press and says why on the button, never asking the sandbox`, () => {
        const voice = mounted({ page: { ...capable, document: { featurePolicy: { allowsFeature: () => false } } } });
        expect(voice.unsupported).toBe(`policy`);
        expect(voice.buttonHint.value).toEqual({
            title: `Talk hands-free`,
            note: `Unavailable here: this page isn't allowed to use the microphone.`,
        });
        voice.toggle();
        expect([voice.state.value, sandboxJson.mock.calls.length]).toEqual([`idle`, 0]);
    });
});

describe(`a failed press`, () => {
    it(`offers the Environment page for a missing rebuild, as a warning`, async () => {
        sandboxJson.mockImplementation(() => Promise.resolve({ provisioned: false, model: `absent` }));
        const voice = mounted();
        voice.toggle();
        await waitFor(() => expect(voice.failure.value?.code).toBe(`needs-rebuild`));
        expect(voice.failure.value).toMatchObject({ tone: `warning`, action: { to: `/sandbox/environment` }, repeats: 0 });
    });

    it(`offers the update card's own button for a daemon without voice`, async () => {
        sandboxJson.mockImplementation(() => Promise.reject(new SandboxHttpError(404, `Not Found`)));
        const voice = mounted();
        voice.toggle();
        await waitFor(() => expect(voice.failure.value?.action?.to).toBe(`/sandbox#sandbox-update-action`));
    });

    it(`offers no page to a reader who could not act on it`, async () => {
        sandboxJson.mockImplementation(() => Promise.resolve({ provisioned: false, model: `absent` }));
        const voice = mounted({ manages: false });
        voice.toggle();
        await waitFor(() => expect(voice.failure.value?.code).toBe(`needs-rebuild`));
        expect(voice.failure.value?.action).toBeUndefined();
    });

    it(`goes when typing starts or the line is dismissed`, async () => {
        sandboxJson.mockImplementation(() => Promise.resolve({ provisioned: false, model: `absent` }));
        const voice = mounted();
        voice.toggle();
        await waitFor(() => expect(voice.failure.value).toMatchObject({ code: `needs-rebuild` }));
        // composerKeys' input handler calls quit on every keystroke.
        voice.quit();
        expect(voice.failure.value).toBeUndefined();

        voice.toggle();
        await waitFor(() => expect(voice.failure.value?.repeats).toBe(1));
        voice.dismiss();
        expect(voice.failure.value).toBeUndefined();
    });
});
