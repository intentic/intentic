import type { SpeechLink, SpeechLinkEvents } from "./speechLink";
import type { WakeMic } from "./wakeMic";
import type { WakeDeps, WakeRequest } from "./useWakeListener";

// Pins the wake listener over a fake microphone and a fake wire: only a phrase that opens with the name becomes a
// request, the room's talk goes no further than each phrase's first seconds, a long phrase is heard whole once its
// opening named the agent, another device's claim stands this one down, the name alone makes the next phrase the
// request, a deaf listener hears nothing, and a page that has not been clicked waits for a click.

jest.mock(`../../app/analytics`, () => ({ track: jest.fn(), replaySessionId: () => undefined }));
jest.mock(`../../client/sandbox/sandboxRaw`, () => ({ sandboxRaw: () => Promise.reject(new Error(`unmocked`)) }));

const { createWakeListener } = await import(`./useWakeListener`);
const { PROBE_MS } = await import(`./phraseGate`);

const RATE = 16_000;
const FRAME = 1600;
const PROBE = (PROBE_MS / 1000) * RATE;

type Op = { readonly kind: `begin` | `audio` | `end`; readonly id: number; readonly samples: number } | { readonly kind: `drop`; readonly id: number };

const settle = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const harness = (options: { readonly running?: boolean; readonly granted?: boolean; readonly lockHeld?: boolean } = {}) => {
    let frame: ((samples: Float32Array) => void) | undefined;
    let running = options.running ?? true;
    const ops: Op[] = [];
    let events: SpeechLinkEvents | undefined;
    const claims: number[] = [];
    const gestures: (() => void)[] = [];
    let held: (() => void) | undefined;
    const store = new Map<string, string>();
    let opened = 0;
    const mic: WakeMic = {
        label: `Microphone (HyperX QuadCast)`,
        running: () => running,
        resume: () => (running ? Promise.resolve() : new Promise(() => {})),
        onLost: () => {},
        close: () => {},
    };
    const link: SpeechLink = {
        begin: (id, samples) => ops.push({ kind: `begin`, id, samples: samples.length }),
        audio: (id, samples) => ops.push({ kind: `audio`, id, samples: samples.length }),
        end: (id, samples) => ops.push({ kind: `end`, id, samples: samples.length }),
        drop: (id) => ops.push({ kind: `drop`, id }),
        close: () => {},
    };
    const deps: WakeDeps = {
        openMic: async (onFrame) => {
            frame = onFrame;
            opened += 1;
            return mic;
        },
        openLink: (_lang, said) => {
            events = said;
            return link;
        },
        claim: async (_device, holdMs) => {
            claims.push(holdMs);
            return options.granted ?? true;
        },
        lock: (onHeld) => {
            held = onHeld;
            if (options.lockHeld !== false) {
                onHeld();
            }
        },
        storage: { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value), removeItem: (key) => store.delete(key) },
        now: Date.now,
        lang: () => `pl-PL`,
        supported: () => true,
        sound: () => {},
        onGesture: (listener) => {
            gestures.push(listener);
            return () => {};
        },
    };
    const listener = createWakeListener(deps);
    listener.start();
    const requests: WakeRequest[] = [];
    listener.onRequest((request) => requests.push(request));
    // `ms` of speech then enough quiet to close the phrase, 100 ms a frame.
    const speak = (ms: number): void => {
        for (let at = 0; at < ms; at += 100) {
            frame?.(new Float32Array(FRAME).fill(0.1));
        }
    };
    const quiet = (): void => {
        for (let at = 0; at < 1600; at += 100) {
            frame?.(new Float32Array(FRAME));
        }
    };
    const say = (ms: number): void => {
        speak(ms);
        quiet();
    };
    const final = (id: number, text: string): void => events?.final(id, text, 10);
    return {
        listener,
        ops,
        claims,
        requests,
        say,
        speak,
        quiet,
        final,
        store,
        gestures,
        opened: () => opened,
        hold: () => held?.(),
        run: () => {
            running = true;
        },
    };
};

const begun = (ops: readonly Op[]): number[] => ops.flatMap((op) => (op.kind === `begin` ? [op.id] : []));
const ended = (ops: readonly Op[], id: number): number | undefined => {
    const op = ops.find((each) => each.kind === `end` && each.id === id);
    return op !== undefined && `samples` in op ? op.samples : undefined;
};

test(`a short phrase that opens with the name is the request, claimed for this device first`, async () => {
    const wake = harness();
    wake.listener.setEnabled(true);
    await settle();
    expect(wake.listener.phase.value).toBe(`listening`);
    wake.say(1200);
    expect(begun(wake.ops)).toEqual([0]);
    expect(ended(wake.ops, 0)).toBeLessThan(PROBE);
    wake.final(0, `Leon, napraw build.`);
    await settle();
    expect(wake.claims).toHaveLength(1);
    expect(wake.requests).toEqual([{ text: `napraw build.`, via: `wake` }]);
});

test(`talk that does not open with the name goes nowhere and claims nothing`, async () => {
    const wake = harness();
    wake.listener.setEnabled(true);
    await settle();
    wake.say(1200);
    wake.final(0, `I told Leon yesterday`);
    await settle();
    expect(wake.claims).toEqual([]);
    expect(wake.requests).toEqual([]);
});

test(`a long phrase sends only its opening, and is heard whole once that opening named the agent`, async () => {
    const wake = harness();
    wake.listener.setEnabled(true);
    await settle();
    wake.say(5000);
    // The probe ended on the wire at its length; nothing past it streamed.
    expect(ended(wake.ops, 0)).toBe(PROBE);
    const streamed = wake.ops.filter((op) => op.kind !== `drop` && op.id === 0 && op.kind !== `end`).reduce((total, op) => total + (op.kind === `drop` ? 0 : op.samples), 0);
    expect(streamed).toBe(PROBE);
    wake.final(0, `Leon, sprawdź czemu testy`);
    await settle();
    // The whole phrase, as a phrase of its own.
    expect(begun(wake.ops)).toEqual([0, 1]);
    expect(ended(wake.ops, 1)).toBeGreaterThan(PROBE);
    wake.final(1, `Leon, sprawdź czemu testy padają na mainie.`);
    expect(wake.requests).toEqual([{ text: `sprawdź czemu testy padają na mainie.`, via: `wake` }]);
});

test(`a long phrase whose opening was talk is never sent past it`, async () => {
    const wake = harness();
    wake.listener.setEnabled(true);
    await settle();
    wake.say(5000);
    wake.final(0, `So anyway the meeting`);
    await settle();
    expect(begun(wake.ops)).toEqual([0]);
    expect(wake.requests).toEqual([]);
});

test(`another device of the same person holding the wake stands this one down`, async () => {
    const wake = harness({ granted: false });
    wake.listener.setEnabled(true);
    await settle();
    wake.say(1200);
    wake.final(0, `Leon, napraw build`);
    await settle();
    expect(wake.requests).toEqual([]);
});

test(`the name alone makes the next phrase the request, streamed whole without a probe`, async () => {
    const wake = harness();
    wake.listener.setEnabled(true);
    await settle();
    wake.say(600);
    wake.final(0, `Leon?`);
    await settle();
    expect(wake.listener.mode.value).toBe(`called`);
    // The "go on" sound plays first, and the listener is deaf through it.
    await settle(400);
    wake.say(5000);
    expect(ended(wake.ops, 1)).toBeGreaterThan(PROBE);
    wake.final(1, `dodaj testy do parsera`);
    expect(wake.requests).toEqual([{ text: `dodaj testy do parsera`, via: `called` }]);
});

test(`a request begun before the name alone was heard back is kept, and heard whole as the request`, async () => {
    const wake = harness();
    wake.listener.setEnabled(true);
    await settle();
    wake.say(600);
    // The next phrase is already under way when "Leon" comes back.
    wake.speak(1000);
    wake.final(0, `Leon.`);
    await settle();
    expect(wake.listener.mode.value).toBe(`called`);
    wake.speak(4000);
    wake.quiet();
    // Not cut at the probe: streamed whole.
    expect(ended(wake.ops, 1)).toBeGreaterThan(PROBE);
    wake.final(1, `napraw build i odpal testy`);
    expect(wake.requests).toEqual([{ text: `napraw build i odpal testy`, via: `called` }]);
});

test(`after an answer the next phrase goes on without the name`, async () => {
    const wake = harness();
    wake.listener.setEnabled(true);
    await settle();
    wake.listener.follow(8000);
    wake.say(900);
    wake.final(0, `and the tests too`);
    expect(wake.requests).toEqual([{ text: `and the tests too`, via: `following` }]);
});

test(`a deaf listener hears nothing at all`, async () => {
    const wake = harness();
    wake.listener.setEnabled(true);
    await settle();
    wake.listener.rest(`talk`, true);
    wake.say(1200);
    expect(wake.ops).toEqual([]);
    wake.listener.rest(`talk`, false);
    wake.say(1200);
    expect(begun(wake.ops)).toEqual([0]);
});

test(`a page not clicked since it loaded waits for a click before it hears`, async () => {
    const wake = harness({ running: false });
    wake.listener.setEnabled(true);
    await settle(1700);
    expect(wake.listener.phase.value).toBe(`blocked`);
    wake.run();
    wake.gestures.at(-1)?.();
    await settle();
    expect(wake.listener.phase.value).toBe(`listening`);
});

test(`another window of this browser listening leaves this one waiting its turn`, async () => {
    const wake = harness({ lockHeld: false });
    wake.listener.setEnabled(true);
    await settle();
    expect(wake.listener.phase.value).toBe(`elsewhere`);
    wake.hold();
    await settle();
    expect(wake.listener.phase.value).toBe(`listening`);
});

test(`switched on and paused are this device's to remember`, async () => {
    const wake = harness();
    wake.listener.setEnabled(true);
    expect(wake.store.get(`intentic.wake.on`)).toBe(`1`);
    wake.listener.pause(60);
    await settle();
    expect(wake.listener.phase.value).toBe(`off`);
    expect(Number(wake.store.get(`intentic.wake.pausedUntil`))).toBeGreaterThan(Date.now());
    wake.listener.resume();
    await settle();
    expect(wake.listener.phase.value).toBe(`listening`);
    wake.listener.setEnabled(false);
    expect(wake.store.has(`intentic.wake.on`)).toBe(false);
    expect(wake.listener.phase.value).toBe(`off`);
});

test(`what the model wrote down, and what it came to, is kept for the settings to show until listening stops`, async () => {
    const wake = harness();
    wake.listener.setEnabled(true);
    await settle();
    expect(wake.listener.lastHeard.value).toBeUndefined();
    wake.say(1200);
    wake.final(0, `No.`);
    expect(wake.listener.lastHeard.value).toMatchObject({ text: `No.`, verdict: `talk` });
    wake.say(1200);
    wake.final(1, `Okej, Leon.`);
    expect(wake.listener.lastHeard.value).toMatchObject({ text: `Okej, Leon.`, verdict: `name` });
    // The name alone made the next phrase the request, once the "go on" sound it plays first is over.
    await settle(400);
    wake.say(1200);
    wake.final(2, `napraw build`);
    expect(wake.listener.lastHeard.value).toMatchObject({ text: `napraw build`, verdict: `request` });
    wake.listener.setEnabled(false);
    expect(wake.listener.lastHeard.value).toBeUndefined();
});

test(`the microphone it opened is named, and picking another opens that one instead`, async () => {
    const wake = harness();
    expect(wake.listener.micLabel.value).toBeUndefined();
    wake.listener.setEnabled(true);
    await settle();
    expect(wake.listener.micLabel.value).toBe(`Microphone (HyperX QuadCast)`);
    expect(wake.opened()).toBe(1);
    wake.listener.reopen();
    await settle();
    expect(wake.opened()).toBe(2);
    expect(wake.listener.phase.value).toBe(`listening`);
    wake.listener.setEnabled(false);
    expect(wake.listener.micLabel.value).toBeUndefined();
    // Switched off, a new pick opens nothing until listening is switched on again.
    wake.listener.reopen();
    await settle();
    expect(wake.opened()).toBe(2);
});
