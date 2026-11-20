/* oxlint-disable unicorn/require-post-message-target-origin -- a MessagePort has no target origin */
import { computed, type ComputedRef, ref, type Ref } from "vue";
import { z } from "zod";
import { settingKey, storedJson, storeJson } from "../../../../app/storage/browserStorage";
import type { AudioReport } from "./audioRing";
import { PROCESSOR_NAME, type ToProcessor, workletSource } from "./audioWorklet";
import type { MediaHello } from "../mediaMessages";

// A WINDOW'S SOUND, ON THE PAGE. castd sends Opus only to a viewer that asked (`audio {on}`); this asks while the
// window has sound, is not muted and can be seen, and once the browser lets the page play: an AudioContext starts only
// after the person has interacted with the page (autoplay rules), so the first press in the stage starts it if nothing
// did before. The decode worker decodes and posts straight to the AudioWorklet over a channel this hands each end of;
// the page carries no sound itself. Muting is remembered per window, as a browser remembers a muted site. A viewer on
// castd's own computer (hello's `local`) plays with a shallower jitter buffer: its loopback has no jitter to absorb.

export interface MediaSound {
    // The window has sound and this browser can play it: what shows the mute control.
    readonly available: ComputedRef<boolean>;
    readonly muted: Ref<boolean>;
    readonly toggleMute: () => void;
    // The buffer's own account, about twice a second while sound plays.
    readonly report: Ref<AudioReport | undefined>;
    // A press or a key in the stage: a gesture the browser lets the page start sound in.
    readonly gesture: () => void;
    // castd's hello: its sound, and whether this viewer reaches it on this computer's loopback.
    readonly hello: (audio: MediaHello[`audio`], local?: boolean) => void;
    // Which window this is, for its remembered mute; and whether its picture is live and seen.
    readonly window: (name: string | undefined) => void;
    readonly shown: (on: boolean) => void;
    readonly close: () => void;
}

export interface SoundSeams {
    // Tells castd whether to send sound.
    readonly ask: (on: boolean) => void;
    // Hands the decode worker its end of the channel, or takes it away.
    readonly feed: (port: MessagePort | undefined) => void;
}

// Which windows the reader muted: the account's setting, never another account's on this browser.
const MUTED_KEY = settingKey(`intentic.browsers.mutedWindows`);
// Windows come and go; the newest this many mutes are remembered.
const MUTED_KEEP = 200;
const MutedSchema = z.array(z.string());

const mutedWindows = (): string[] => storedJson(MUTED_KEY, MutedSchema) ?? [];
const rememberMuted = (name: string, muted: boolean): void => {
    const rest = mutedWindows().filter((other) => other !== name);
    storeJson(MUTED_KEY, (muted ? [...rest, name] : rest).slice(-MUTED_KEEP));
};

// Whether the page may start sound without a gesture now: the person has interacted with it since it loaded.
const activated = (): boolean => navigator.userActivation?.hasBeenActive ?? false;

/** The jitter buffer's floor (AudioRing's minTargetMs): 20 ms on this computer's loopback, 40 over a network. */
export const soundFloorMs = (local: boolean | undefined): number => (local === true ? 20 : 40);

// The sound castd sends, and the floor it is buffered to.
type SoundFormat = NonNullable<MediaHello[`audio`]> & { readonly floorMs: number };

interface Playback {
    readonly context: AudioContext;
    readonly node: AudioWorkletNode;
}

// Builds the context and its worklet; the context is made inside the caller's turn, so a gesture's activation holds.
const startPlayback = async (audio: SoundFormat, report: (value: AudioReport) => void): Promise<Playback | undefined> => {
    const context = new AudioContext({ sampleRate: audio.sampleRate, latencyHint: `interactive` });
    const url = URL.createObjectURL(new Blob([workletSource()], { type: `text/javascript` }));
    try {
        await context.audioWorklet.addModule(url);
    } catch {
        // allow(silent-catch): a browser that refuses the worklet plays the picture without its sound.
        await context.close();
        return undefined;
    } finally {
        URL.revokeObjectURL(url);
    }
    try {
        const node = new AudioWorkletNode(context, PROCESSOR_NAME, {
            numberOfInputs: 0,
            outputChannelCount: [audio.channels],
            processorOptions: { channels: audio.channels, sampleRate: audio.sampleRate, minTargetMs: audio.floorMs },
        });
        node.port.addEventListener(`message`, (event: MessageEvent<AudioReport>) => report(event.data));
        node.port.start();
        node.connect(context.destination);
        await context.resume();
        return { context, node };
    } catch {
        // allow(silent-catch): a node the browser refuses is a worklet refused; its context goes with it.
        await context.close();
        return undefined;
    }
};

// One start of playback at a time, for the sound playing now. A start that lands after its sound went (closed, or a
// stream of another shape) is closed rather than kept: kept, it played on beside the one started after it, or played
// one stream's sound at another's rate. A browser that refuses the worklet is asked again only for the next stream,
// not in a loop of contexts built and refused.
const playbackStarts = (report: (value: AudioReport) => void) => {
    let starting = false;
    let generation = 0;
    let refused = false;
    return {
        busy: () => starting,
        refused: () => refused,
        start: (audio: SoundFormat, made: (playback: Playback | undefined) => void): void => {
            const mine = generation;
            starting = true;
            void startPlayback(audio, report)
                // allow(silent-catch): a context the browser refuses to make (a rate it cannot run) is a worklet refused.
                .catch(() => undefined)
                .then((playback) => {
                    if (mine !== generation) {
                        playback?.node.disconnect();
                        void playback?.context.close();
                        return;
                    }
                    starting = false;
                    refused = playback === undefined;
                    made(playback);
                });
        },
        // The sound went: a start under way is for nothing now.
        forget: (): void => {
            generation += 1;
            [starting, refused] = [false, false];
        },
    };
};

export const mediaSound = (seams: SoundSeams): MediaSound => {
    const audio = ref<SoundFormat>();
    const muted = ref(false);
    const report = ref<AudioReport | undefined>();
    let name: string | undefined;
    let shown = false;
    let playback: Playback | undefined;
    const starts = playbackStarts((value) => (report.value = value));
    // Whether castd was last told to send sound, so a repeat is not said.
    let asked = false;

    const wanted = (): boolean => audio.value !== undefined && !muted.value && shown && !starts.refused();

    // Opens a fresh channel between the worker and the worklet; the old one's packets go nowhere.
    const connect = (at: Playback): void => {
        const channel = new MessageChannel();
        at.node.port.postMessage({ port: channel.port2 } satisfies ToProcessor, [channel.port2]);
        seams.feed(channel.port1);
    };

    const sync = (): void => {
        const want = wanted() && (playback !== undefined || activated());
        if (want && playback === undefined && !starts.busy() && audio.value !== undefined) {
            starts.start(audio.value, (made) => {
                playback = made;
                sync();
            });
            return;
        }
        const on = want && playback !== undefined;
        if (on === asked) {
            return;
        }
        asked = on;
        if (playback !== undefined) {
            if (on) {
                connect(playback);
                void playback.context.resume();
            } else {
                seams.feed(undefined);
                playback.node.port.postMessage({ flush: true } satisfies ToProcessor);
                void playback.context.suspend();
            }
        }
        seams.ask(on);
    };

    const stopPlayback = (): void => {
        const done = playback;
        playback = undefined;
        starts.forget();
        asked = false;
        report.value = undefined;
        seams.feed(undefined);
        done?.node.disconnect();
        void done?.context.close();
    };

    return {
        available: computed(() => audio.value !== undefined && `AudioWorkletNode` in globalThis),
        muted,
        toggleMute: () => {
            muted.value = !muted.value;
            if (name !== undefined) {
                rememberMuted(name, muted.value);
            }
            sync();
        },
        report,
        gesture: sync,
        hello: (next, local) => {
            const format = next === undefined ? undefined : { ...next, floorMs: soundFloorMs(local) };
            const was = audio.value;
            const changed = format?.sampleRate !== was?.sampleRate || format?.channels !== was?.channels || format?.floorMs !== was?.floorMs;
            audio.value = format;
            if (changed) {
                stopPlayback();
            }
            sync();
        },
        window: (next) => {
            name = next;
            muted.value = next !== undefined && mutedWindows().includes(next);
            sync();
        },
        shown: (on) => {
            shown = on;
            sync();
        },
        close: () => {
            audio.value = undefined;
            stopPlayback();
        },
    };
};
