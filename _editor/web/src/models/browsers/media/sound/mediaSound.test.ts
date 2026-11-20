// A window's sound on the page, on a fake Web Audio: an AudioContext and its worklet are built once the page may play,
// and every context built is closed again, including one still starting when the sound goes.
import "@intentic/testing/dom";
import { stubGlobal, unstubAllGlobals, waitFor } from "@intentic/testing/bun";
import { mediaSound } from "./mediaSound";

const contexts: FakeContext[] = [];
let releaseModule: (() => void) | undefined;
let refuseModule: (() => void) | undefined;
// Each read through a call, not narrowed by what a test last assigned: the fake context sets them meanwhile.
const release = (): void => releaseModule?.();
const refuse = (): void => refuseModule?.();

class FakeContext {
    state: AudioContextState = `suspended`;
    readonly destination = {};
    readonly audioWorklet = {
        // Held until the test lets it go, as a real module load takes a moment.
        addModule: (): Promise<void> =>
            new Promise((resolve, reject) => {
                releaseModule = resolve;
                refuseModule = () => reject(new Error(`refused`));
            }),
    };
    constructor(readonly options: AudioContextOptions) {
        contexts.push(this);
    }
    async resume(): Promise<void> {
        this.state = this.state === `closed` ? `closed` : `running`;
    }
    async suspend(): Promise<void> {
        this.state = this.state === `closed` ? `closed` : `suspended`;
    }
    async close(): Promise<void> {
        this.state = `closed`;
    }
}

class FakeNode {
    readonly port = { postMessage: () => undefined, addEventListener: () => undefined, start: () => undefined };
    connect(): void {}
    disconnect(): void {}
}

beforeEach(() => {
    contexts.length = 0;
    releaseModule = undefined;
    refuseModule = undefined;
    stubGlobal(`AudioContext`, FakeContext);
    stubGlobal(`AudioWorkletNode`, FakeNode);
    Object.defineProperty(navigator, `userActivation`, { value: { hasBeenActive: true }, configurable: true });
    // The worklet's source travels as a Blob URL, which this suite has no use for.
    jest.spyOn(URL, `createObjectURL`).mockReturnValue(`blob:worklet`);
    jest.spyOn(URL, `revokeObjectURL`).mockReturnValue(undefined);
});
afterEach(() => {
    jest.restoreAllMocks();
    unstubAllGlobals();
    Reflect.deleteProperty(navigator, `userActivation`);
});

const opus = { codec: `opus`, sampleRate: 48_000, channels: 2 };

it("starts a context once the window has sound and is seen, and closes it when the sound goes", async () => {
    const asked: boolean[] = [];
    const sound = mediaSound({ ask: (on) => asked.push(on), feed: () => undefined });
    sound.hello(opus);
    sound.shown(true);
    await waitFor(() => expect(releaseModule).toEqual(expect.any(Function)));
    release();
    await waitFor(() => expect(asked).toEqual([true]));
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.options.sampleRate).toBe(48_000);
    sound.close();
    expect(contexts[0]?.state).toBe(`closed`);
});

it("closes a context still starting when the sound goes, and never asks castd for sound it cannot play", async () => {
    const asked: boolean[] = [];
    const sound = mediaSound({ ask: (on) => asked.push(on), feed: () => undefined });
    sound.hello(opus);
    sound.shown(true);
    await waitFor(() => expect(releaseModule).toEqual(expect.any(Function)));
    // The view goes (another window, the pane closed) while the worklet's module is still loading.
    sound.close();
    release();
    await waitFor(() => expect(contexts[0]?.state).toBe(`closed`));
    expect(asked).toEqual([]);
});

it("does not play a stream of another shape on a context started for the one before it", async () => {
    const sound = mediaSound({ ask: () => undefined, feed: () => undefined });
    sound.hello(opus);
    sound.shown(true);
    await waitFor(() => expect(releaseModule).toEqual(expect.any(Function)));
    const first = releaseModule;
    releaseModule = undefined;
    // castd's next hello carries sound at another rate while the first context is still starting.
    sound.hello({ codec: `opus`, sampleRate: 24_000, channels: 1 });
    first?.();
    await waitFor(() => expect(contexts[0]?.state).toBe(`closed`));
    await waitFor(() => expect(releaseModule).toEqual(expect.any(Function)));
    release();
    await waitFor(() => expect(contexts[1]?.state).toBe(`running`));
    expect(contexts[1]?.options.sampleRate).toBe(24_000);
    sound.close();
});

it("gives up on sound in a browser that refuses its worklet, rather than building context after context", async () => {
    const sound = mediaSound({ ask: () => undefined, feed: () => undefined });
    sound.hello(opus);
    sound.shown(true);
    await waitFor(() => expect(releaseModule).toEqual(expect.any(Function)));
    refuse();
    await waitFor(() => expect(contexts[0]?.state).toBe(`closed`));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(contexts).toHaveLength(1);
    sound.close();
});
