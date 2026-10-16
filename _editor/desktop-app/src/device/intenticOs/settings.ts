import type {
    IntenticOsDisplayList,
    IntenticOsDisplayMode,
    IntenticOsKeyboardLayouts,
    IntenticOsKeyboardStatus,
    IntenticOsNetworkStatus,
    IntenticOsSoundOutputs,
    IntenticOsSoundStatus,
    IntenticOsWifiList,
} from "@intentic/sandbox-contract/schemas/intentic-os";
import { ref, type Ref } from "vue";
import { osDisplayList, osDisplaySet, osKeyboardLayouts, osKeyboardSet, osKeyboardStatus, osNetworkStatus, osSoundOutput, osSoundOutputs, osSoundSet, osSoundStatus, osWifiConnect, osWifiForget, osWifiList, osWifiRadio } from "../../osSettings";
import { DISPLAY_TRIAL_MS } from "./displayCard";
import { joinSaidOf } from "./networkCard";
import { mergeChange, SOUND_SETTLE_MS, soundAfter, type SoundChange, volumeChange } from "./soundCard";

// THIS COMPUTER'S SETTINGS (src-tauri/src/os_settings.rs runs the OS's own `ic os network|sound|display|keyboard`): what
// each reads, held for the cards (NetworkCard.vue, SoundCard.vue, DisplayCard.vue, KeyboardCard.vue), and the changes a
// person makes there. Read when This computer opens and every few seconds while it is on screen (ThisComputer.vue), the
// Wi-Fi networks when the card asks (a rescan takes seconds), and each again after a change. Undefined is "nothing to
// show": not Intentic OS, an edition with no screen, or ic not answered yet; the card hides. Kept at module scope, one
// reading per window, like the rest of This device.

export const network = ref<IntenticOsNetworkStatus | undefined>(undefined);
export const wifi = ref<IntenticOsWifiList | undefined>(undefined);
export const wifiScanning = ref(false);
/** A Wi-Fi change under way: the radio, a network forgotten. */
export const wifiChanging = ref(false);
/** The network being joined. */
export const joining = ref<string | undefined>(undefined);
/** The network the password field is up for, and whether the last one typed for it was refused. */
export const asking = ref<{ readonly ssid: string; readonly wrong: boolean } | undefined>(undefined);
/** A Wi-Fi read or change that did not work, in ic's words, and the network it was about. */
export const wifiError = ref<{ readonly ssid: string | undefined; readonly reason: string } | undefined>(undefined);

export const sound = ref<IntenticOsSoundStatus | undefined>(undefined);
export const soundOutputs = ref<IntenticOsSoundOutputs | undefined>(undefined);
export const soundError = ref<string | undefined>(undefined);

export const displays = ref<IntenticOsDisplayList | undefined>(undefined);
/** The screen whose change is being made. */
export const displayChanging = ref<string | undefined>(undefined);
/** A screen's new mode or size on trial: kept at the reader's word, else put back when the time is up. */
export const displayTrial = ref<{ readonly output: string; readonly endsAt: number } | undefined>(undefined);
export const displayError = ref<string | undefined>(undefined);

export const keyboard = ref<IntenticOsKeyboardStatus | undefined>(undefined);
export const keyboardLayouts = ref<IntenticOsKeyboardLayouts | undefined>(undefined);
export const keyboardChanging = ref(false);
export const keyboardError = ref<string | undefined>(undefined);

/* Only the newest read of each writes: an answer from before a change would put the old setting back on screen. */
const reads = new Map<string, number>();

/** Read one setting into `into`. A read that failed keeps what was last known, and says why in `error`. */
const readInto = async <T>(name: string, ask: () => Promise<T | null>, into: Ref<T | undefined>, error?: Ref<string | undefined>): Promise<void> => {
    const read = (reads.get(name) ?? 0) + 1;
    reads.set(name, read);
    try {
        const answer = await ask();
        if (reads.get(name) === read) {
            into.value = answer ?? undefined;
        }
    } catch (failure) {
        console.error(`[device] this computer's ${name} could not be read:`, failure);
        if (error !== undefined && reads.get(name) === read && into.value === undefined) {
            error.value = String(failure);
        }
    }
};

/** Every setting the cards show but the Wi-Fi networks and the keyboard layouts, which are read when their card asks. A
 *  read is skipped for a setting whose change is still on its way, which it would undo on screen. */
export const loadSettings = async (): Promise<void> => {
    await Promise.all([
        readInto(`network`, osNetworkStatus, network),
        soundPending() ? undefined : readInto(`sound`, osSoundStatus, sound, soundError),
        readInto(`sound outputs`, osSoundOutputs, soundOutputs),
        displayChanging.value === undefined ? readInto(`screens`, osDisplayList, displays, displayError) : undefined,
        keyboardChanging.value ? undefined : readInto(`keyboard`, osKeyboardStatus, keyboard, keyboardError),
    ]);
};

/* THE NETWORK. */

/** The Wi-Fi networks in reach: a rescan, a few seconds. */
export const scanWifi = async (): Promise<void> => {
    if (wifiScanning.value) {
        return;
    }
    wifiScanning.value = true;
    try {
        wifi.value = (await osWifiList()) ?? undefined;
    } catch (error) {
        wifiError.value = { ssid: undefined, reason: String(error) };
    } finally {
        wifiScanning.value = false;
    }
};

/** Join a network: a known or open one at once; one that wants a password puts the field up, and is joined again with
 *  what the person types. */
export const joinWifi = async (ssid: string, password?: string): Promise<void> => {
    if (joining.value !== undefined) {
        return;
    }
    joining.value = ssid;
    wifiError.value = undefined;
    try {
        const said = joinSaidOf(await osWifiConnect(ssid, password));
        asking.value = said.kind === `ask` ? { ssid, wrong: said.wrong } : undefined;
        if (said.kind === `failed`) {
            wifiError.value = { ssid, reason: said.reason ?? `` };
        }
    } catch (error) {
        wifiError.value = { ssid, reason: String(error) };
    } finally {
        joining.value = undefined;
    }
    await Promise.all([readInto(`network`, osNetworkStatus, network), scanWifi()]);
};

/** Put the password field away. */
export const stopAsking = (): void => {
    asking.value = undefined;
};

const wifiChange = async (ssid: string | undefined, change: () => Promise<void>): Promise<void> => {
    if (wifiChanging.value) {
        return;
    }
    wifiChanging.value = true;
    wifiError.value = undefined;
    try {
        await change();
    } catch (error) {
        wifiError.value = { ssid, reason: String(error) };
    } finally {
        wifiChanging.value = false;
    }
    await Promise.all([readInto(`network`, osNetworkStatus, network), scanWifi()]);
};

/** This computer no longer joins `ssid` by itself, and asks for its password again next time. */
export const forgetWifi = (ssid: string): Promise<void> => wifiChange(ssid, () => osWifiForget(ssid));

export const setWifiRadio = (on: boolean): Promise<void> => wifiChange(undefined, () => osWifiRadio(on));

/* THE SOUND: a slider sends its volume once it rests, and what it shows meanwhile is the change, not the last read. */

let waiting: SoundChange | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let sending = 0;

const soundPending = (): boolean => waiting !== undefined || sending > 0;

const sendSound = async (): Promise<void> => {
    const change = waiting;
    waiting = undefined;
    timer = undefined;
    if (change === undefined) {
        return;
    }
    sending += 1;
    soundError.value = undefined;
    let after: IntenticOsSoundStatus | null = null;
    try {
        after = await osSoundSet(change);
    } catch (error) {
        soundError.value = String(error);
    } finally {
        sending -= 1;
    }
    // A later change is on its way: its own answer says what is true.
    if (soundPending()) {
        return;
    }
    if (after === null) {
        await readInto(`sound`, osSoundStatus, sound, soundError);
    } else {
        sound.value = after;
    }
};

const changeSound = (change: SoundChange, settle: number): void => {
    if (sound.value === undefined) {
        return;
    }
    sound.value = soundAfter(sound.value, change);
    waiting = mergeChange(waiting, change);
    clearTimeout(timer);
    timer = setTimeout(() => void sendSound(), settle);
};

/** The slider moved: sent once it rests. */
export const setVolume = (value: number): void => {
    if (sound.value !== undefined) {
        changeSound(volumeChange(sound.value, value), SOUND_SETTLE_MS);
    }
};

export const setMuted = (muted: boolean): void => changeSound({ muted }, 0);

/** Play through another speaker from now on. */
export const pickSoundOutput = async (id: number): Promise<void> => {
    soundError.value = undefined;
    try {
        await osSoundOutput(id);
    } catch (error) {
        soundError.value = String(error);
    }
    await Promise.all([readInto(`sound outputs`, osSoundOutputs, soundOutputs), readInto(`sound`, osSoundStatus, sound, soundError)]);
};

/* THE SCREENS: a new mode or size is on trial until the reader keeps it, and goes back by itself when they cannot. */

/** A change of a screen, as `ic os display set` takes it: a mode it offers, a size, or both. */
export interface DisplayChange {
    mode?: IntenticOsDisplayMode;
    scale?: number;
}

interface Trial {
    readonly output: string;
    readonly mode: IntenticOsDisplayMode | undefined;
    readonly scale: number | undefined;
    readonly timer: ReturnType<typeof setTimeout>;
}

let trial: Trial | undefined;

const applyDisplay = async (output: string, change: Readonly<DisplayChange>): Promise<boolean> => {
    displayChanging.value = output;
    displayError.value = undefined;
    try {
        await osDisplaySet(output, change);
        return true;
    } catch (error) {
        displayError.value = String(error);
        return false;
    } finally {
        displayChanging.value = undefined;
        await readInto(`screens`, osDisplayList, displays, displayError);
    }
};

/** Put the screen back the way it was before the change on trial. */
export const undoDisplay = async (): Promise<void> => {
    const undoing = trial;
    if (undoing === undefined) {
        return;
    }
    clearTimeout(undoing.timer);
    trial = undefined;
    displayTrial.value = undefined;
    const change: DisplayChange = {};
    if (undoing.mode !== undefined) {
        change.mode = undoing.mode;
    }
    if (undoing.scale !== undefined) {
        change.scale = undoing.scale;
    }
    await applyDisplay(undoing.output, change);
};

/** Keep the change on trial. */
export const keepDisplay = (): void => {
    if (trial !== undefined) {
        clearTimeout(trial.timer);
    }
    trial = undefined;
    displayTrial.value = undefined;
};

/** Show a screen at another mode, or draw everything bigger or smaller on it: on trial until kept. */
export const setDisplay = async (output: string, change: Readonly<DisplayChange>): Promise<void> => {
    const screen = displays.value?.outputs.find((each) => each.name === output);
    if (screen === undefined || displayChanging.value !== undefined) {
        return;
    }
    // A change made over one still on trial keeps the first one's "before", which is what the reader last said yes to.
    const before = trial?.output === output ? trial : undefined;
    keepDisplay();
    const changed = await applyDisplay(output, change);
    if (!changed) {
        return;
    }
    const mode = before?.mode ?? (change.mode === undefined ? undefined : (screen.current ?? undefined));
    const scale = before?.scale ?? (change.scale === undefined ? undefined : (screen.scale ?? undefined));
    if (mode === undefined && scale === undefined) {
        return;
    }
    trial = { output, mode, scale, timer: setTimeout(() => void undoDisplay(), DISPLAY_TRIAL_MS) };
    displayTrial.value = { output, endsAt: Date.now() + DISPLAY_TRIAL_MS };
};

/* THE KEYBOARD. */

/** Every layout the system knows, once per window: it does not change while the system runs. */
export const loadKeyboardLayouts = async (): Promise<void> => {
    if (keyboardLayouts.value === undefined) {
        await readInto(`keyboard layouts`, osKeyboardLayouts, keyboardLayouts, keyboardError);
    }
};

export const setKeyboard = async (layout: string, variant?: string): Promise<void> => {
    if (keyboardChanging.value) {
        return;
    }
    keyboardChanging.value = true;
    keyboardError.value = undefined;
    try {
        await osKeyboardSet(layout, variant);
    } catch (error) {
        keyboardError.value = String(error);
    } finally {
        keyboardChanging.value = false;
    }
    await readInto(`keyboard`, osKeyboardStatus, keyboard, keyboardError);
};
