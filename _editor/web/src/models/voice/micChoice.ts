import { removeStoredValue, storedValue, storeValue } from "@intentic/ui/storage";
import { ref } from "vue";
import { z } from "zod";

// THE MICROPHONE THIS BROWSER HEARS WITH, picked in Settings ▸ Voice and used by everything that opens one: the wake
// listener (wakeMic.ts) and dictation (useVoiceInput.ts). Unpicked, the browser chooses, which on a desk with a
// headset, a webcam and a studio mic is not always the one the person talks into, and nothing said which it took.
// Kept per browser like the wake switch: the ids a browser hands out are its own, salted per site.

/** Where the pick is kept, so another window of this browser can take it up (WakeListener.vue's storage listener). */
export const MIC_KEY = `intentic.voice.mic`;

/** The browser's own cleanup, which the speech model hears best through, asked of every microphone opened. */
const CLEANUP = { echoCancellation: true, noiseSuppression: true, autoGainControl: true } as const;

/** One microphone the browser offers: its id (stable for this site) and its name (empty until the site may use one). */
export interface MicOption {
    readonly id: string;
    readonly label: string;
}

export interface MicList {
    readonly mics: readonly MicOption[];
    /** Whether the browser said the microphones' names: it does only once this site has been allowed one. */
    readonly named: boolean;
}

/** How a microphone is asked for: the browser's getUserMedia, or a test's. */
export type OpenMic<Stream> = (constraints: MediaStreamConstraints) => Promise<Stream>;
/** The fields of the browser's device list this reads. */
export type ListedDevice = Pick<MediaDeviceInfo, `deviceId` | `label` | `kind`>;

/** The picked microphone's id; undefined leaves the choice to the browser. */
export const chosenMic = ref<string | undefined>(storedValue(MIC_KEY));

export const chooseMic = (id: string | undefined): void => {
    if (id === undefined) {
        removeStoredValue(MIC_KEY);
    } else {
        storeValue(MIC_KEY, id);
    }
    chosenMic.value = id;
};

/** Takes up a pick another window of this browser made. */
export const rereadMic = (): void => {
    chosenMic.value = storedValue(MIC_KEY);
};

// What a refused getUserMedia threw, by its name: Chromium's OverconstrainedError is a class of its own in older versions
// rather than a DOMException, so the name is what both share.
const NamedErrorSchema = z.object({ name: z.string() });
const named = (cause: unknown): string | undefined => NamedErrorSchema.safeParse(cause).data?.name;

/**
 * The microphone, opened through `open`: the picked one, or the browser's when none is picked or the picked one is not
 * here (unplugged, or the browser forgot this site's ids). The pick is kept either way, so it is used again once it is
 * back.
 */
export const openMicWith = async <Stream>(open: OpenMic<Stream>, chosen: string | undefined): Promise<Stream> => {
    if (chosen === undefined) {
        return open({ audio: CLEANUP });
    }
    try {
        return await open({ audio: { ...CLEANUP, deviceId: { exact: chosen } } });
    } catch (cause) {
        const name = named(cause);
        if (name === `OverconstrainedError` || name === `NotFoundError`) {
            return open({ audio: CLEANUP });
        }
        throw cause;
    }
};

/** The picked microphone (or the browser's), opened. */
export const openMicStream = (): Promise<MediaStream> => openMicWith((constraints) => navigator.mediaDevices.getUserMedia(constraints), chosenMic.value);

// Chromium lists the system's default and communications inputs a second time under these ids: the first is what the
// browser's own choice stands for, the second only a duplicate.
const ALIASES: ReadonlySet<string> = new Set([`default`, `communications`, ``]);

/** The microphones the browser offers, without its aliases for one of them. */
export const listMics = async (
    enumerate: () => Promise<readonly ListedDevice[]> = () => navigator.mediaDevices.enumerateDevices(),
): Promise<MicList> => {
    const inputs = (await enumerate()).filter((device) => device.kind === `audioinput` && !ALIASES.has(device.deviceId));
    return {
        mics: inputs.map((device) => ({ id: device.deviceId, label: device.label })),
        named: inputs.some((device) => device.label !== ``),
    };
};

/** Calls `changed` when a microphone is plugged in or out; returns the way to stop. */
export const onMicsChanged = (changed: () => void, media: Pick<EventTarget, `addEventListener` | `removeEventListener`> = navigator.mediaDevices): (() => void) => {
    media.addEventListener(`devicechange`, changed);
    return () => media.removeEventListener(`devicechange`, changed);
};
