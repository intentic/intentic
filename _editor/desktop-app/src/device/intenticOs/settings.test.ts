import "@intentic/testing/dom";
import {
    type IntenticOsDisplayList,
    type IntenticOsKeyboardLayouts,
    type IntenticOsKeyboardStatus,
    type IntenticOsNetworkStatus,
    type IntenticOsSoundOutputs,
    type IntenticOsSoundStatus,
    IntenticOsSoundStatusSchema,
    type IntenticOsWifiList,
} from "@intentic/sandbox-contract/schemas/intentic-os";
import { advanceTimersByTimeAsync, freshImport, waitFor } from "@intentic/testing/bun";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { OsWifiJoin } from "../../osSettings";
import { DISPLAY_TRIAL_MS } from "./displayCard";
import { example, GOLDEN } from "./golden.testing";
import { SOUND_SETTLE_MS } from "./soundCard";

// This computer's settings as a window holds them: read, re-read, hidden where ic says there is nothing to show, and each
// change made the way the card makes it: a Wi-Fi join that asks for its password and again after a wrong one, a slider
// sent once it rests, a screen's new mode on trial until kept, a layout picked. The app is Tauri's own IPC mock, and
// ic's answers are the contract's own examples.

const load = () => freshImport<typeof import("./settings")>("./settings", import.meta.url);

let calls: { command: string; args: Record<string, unknown> }[] = [];

/** What ic answers each read with, as the mock app passes it on. */
interface Answers {
    network: IntenticOsNetworkStatus;
    wifi: IntenticOsWifiList;
    sound: IntenticOsSoundStatus;
    outputs: IntenticOsSoundOutputs;
    displays: IntenticOsDisplayList | null;
    keyboard: IntenticOsKeyboardStatus | null;
    layouts: IntenticOsKeyboardLayouts;
}

const goldenAnswers = (): Answers => ({
    network: example(GOLDEN.networkStatus),
    wifi: example(GOLDEN.wifiList),
    sound: example(GOLDEN.soundStatus),
    outputs: example(GOLDEN.soundOutputs),
    displays: example(GOLDEN.displayList),
    keyboard: example(GOLDEN.keyboardStatus),
    layouts: example(GOLDEN.keyboardLayouts),
});

let answers = goldenAnswers();
let joins: OsWifiJoin[] = [];
/** The commands ic fails, with its words. */
let failing = new Map<string, string>();

const asked = (command: string) => calls.filter((call) => call.command === command);

/** `ic os sound set --json`: the status after the change. */
const soundSet = (sent: Record<string, unknown>): IntenticOsSoundStatus => {
    // What the change names (a null is what it leaves alone) over what was, read back as ic's own answer.
    const named = Object.fromEntries(Object.entries(sent).filter(([, value]) => value !== null));
    answers.sound = IntenticOsSoundStatusSchema.parse({ ...answers.sound, ...named });
    return answers.sound;
};

const answer = (command: string, sent: Record<string, unknown>): object | null => {
    switch (command) {
        case `os_network_status`:
            return answers.network;
        case `os_wifi_list`:
            return answers.wifi;
        case `os_wifi_connect`:
            return joins.shift() ?? { outcome: `joined`, reason: null };
        case `os_sound_status`:
            return answers.sound;
        case `os_sound_set`:
            return soundSet(sent);
        case `os_sound_outputs`:
            return answers.outputs;
        case `os_display_list`:
            return answers.displays;
        case `os_keyboard_status`:
            return answers.keyboard;
        case `os_keyboard_layouts`:
            return answers.layouts;
        default:
            return null;
    }
};

beforeEach(() => {
    calls = [];
    answers = goldenAnswers();
    joins = [];
    failing = new Map();
    mockIPC((command, args) => {
        // SAFETY: every command this store invokes passes a plain object of named arguments, or none.
        const sent = (args ?? {}) as Record<string, unknown>;
        calls.push({ command, args: sent });
        const failure = failing.get(command);
        if (failure !== undefined) {
            throw new Error(failure);
        }
        return answer(command, sent);
    });
});
afterEach(() => {
    clearMocks();
    jest.useRealTimers();
});

it(`reads what each card shows, keeps it through a read that failed, and has nothing where ic says there is none`, async () => {
    const settings = await load();
    await settings.loadSettings();
    expect(settings.network.value?.name).toBe(`Home Fiber`);
    expect(settings.sound.value?.volume).toBe(40);
    expect(settings.soundOutputs.value?.outputs).toHaveLength(2);
    expect(settings.displays.value?.outputs).toHaveLength(3);
    expect(settings.keyboard.value?.layout).toBe(`de`);
    // The Wi-Fi networks and the layouts are read when their card asks, never on the timer.
    expect(asked(`os_wifi_list`)).toHaveLength(0);
    expect(asked(`os_keyboard_layouts`)).toHaveLength(0);

    failing.set(`os_network_status`, `ic os network status did not answer within 20s`);
    await settings.loadSettings();
    expect(settings.network.value?.name).toBe(`Home Fiber`);

    // The server edition: no screen, no keyboard; their cards hide.
    failing.clear();
    answers = { ...goldenAnswers(), displays: null, keyboard: null };
    await settings.loadSettings();
    expect(settings.displays.value).toBeUndefined();
    expect(settings.keyboard.value).toBeUndefined();
    expect(settings.network.value).toMatchObject({ kind: `wifi` });
});

it(`joins a network, asking for its password when it wants one and again after a wrong one`, async () => {
    const settings = await load();
    joins = [
        { outcome: `needsPassword`, reason: null },
        { outcome: `wrongPassword`, reason: null },
        { outcome: `joined`, reason: null },
    ];
    await settings.joinWifi(`Office`);
    expect(asked(`os_wifi_connect`).at(-1)?.args).toEqual({ ssid: `Office`, password: null });
    expect(settings.asking.value).toEqual({ ssid: `Office`, wrong: false });

    await settings.joinWifi(`Office`, `hunter2`);
    expect(asked(`os_wifi_connect`).at(-1)?.args).toEqual({ ssid: `Office`, password: `hunter2` });
    expect(settings.asking.value).toEqual({ ssid: `Office`, wrong: true });

    await settings.joinWifi(`Office`, `hunter22`);
    expect(settings.asking.value).toBeUndefined();
    expect(settings.joining.value).toBeUndefined();
    // Then the network and the networks in reach again, which say which is in use now.
    expect(asked(`os_network_status`)).toHaveLength(3);
    expect(asked(`os_wifi_list`)).toHaveLength(3);
});

it(`says why a network could not be joined, forgotten, or Wi-Fi turned off`, async () => {
    const settings = await load();
    joins = [{ outcome: `failed`, reason: `no network called Office in reach` }];
    await settings.joinWifi(`Office`);
    expect(settings.wifiError.value).toEqual({ ssid: `Office`, reason: `no network called Office in reach` });

    await settings.forgetWifi(`Office`);
    expect(asked(`os_wifi_forget`)[0]?.args).toEqual({ ssid: `Office` });
    expect(settings.wifiError.value).toBeUndefined();

    failing.set(`os_wifi_radio`, `NetworkManager refused`);
    await settings.setWifiRadio(false);
    expect(asked(`os_wifi_radio`)[0]?.args).toEqual({ on: false });
    expect(settings.wifiError.value?.ssid).toBeUndefined();
    expect(settings.wifiError.value?.reason).toContain(`NetworkManager refused`);
    expect(settings.wifiChanging.value).toBe(false);
});

it(`sends a slider's volume once it rests, turns the sound back on with it, and shows it meanwhile`, async () => {
    jest.useFakeTimers();
    const settings = await load();
    answers.sound = { ...example(GOLDEN.soundStatus), muted: true };
    await settings.loadSettings();
    expect(settings.sound.value?.muted).toBe(true);

    settings.setVolume(52);
    settings.setVolume(61.4);
    expect(settings.sound.value).toEqual({ volume: 61, muted: false, output: `Built-in Audio Analog Stereo` });
    // A read on the timer while the change is on its way does not put the old volume back.
    await settings.loadSettings();
    expect(settings.sound.value?.volume).toBe(61);
    expect(asked(`os_sound_set`)).toHaveLength(0);
    const reads = asked(`os_sound_status`).length;

    await advanceTimersByTimeAsync(SOUND_SETTLE_MS);
    await waitFor(() => expect(asked(`os_sound_set`)).toHaveLength(1));
    expect(asked(`os_sound_set`)[0]?.args).toEqual({ volume: 61, muted: false });
    await waitFor(() => expect(settings.sound.value).toEqual({ volume: 61, muted: false, output: `Built-in Audio Analog Stereo` }));
    // ic's answer to the change is the status after it: nothing is read again.
    expect(asked(`os_sound_status`)).toHaveLength(reads);

    // Muting waits for nothing.
    settings.setMuted(true);
    await advanceTimersByTimeAsync(1);
    await waitFor(() => expect(asked(`os_sound_set`)).toHaveLength(2));
    expect(asked(`os_sound_set`)[1]?.args).toEqual({ volume: null, muted: true });
});

it(`plays through another speaker, and says when it could not`, async () => {
    const settings = await load();
    await settings.pickSoundOutput(58);
    expect(asked(`os_sound_output`)[0]?.args).toEqual({ id: 58 });
    expect(settings.soundOutputs.value?.outputs).toHaveLength(2);
    failing.set(`os_sound_output`, `no output 99`);
    await settings.pickSoundOutput(99);
    expect(settings.soundError.value).toContain(`no output 99`);
});

it(`keeps a screen's new mode only at the reader's word, and puts it back by itself when nobody says so`, async () => {
    jest.useFakeTimers();
    const settings = await load();
    await settings.loadSettings();
    const fullHd = { width: 1920, height: 1080, refresh: 60 };
    const native = { width: 3840, height: 2160, refresh: 60 };

    await settings.setDisplay(`DP-2`, { mode: fullHd });
    expect(asked(`os_display_set`)[0]?.args).toEqual({ output: `DP-2`, mode: fullHd, scale: null });
    expect(settings.displayTrial.value?.output).toBe(`DP-2`);
    settings.keepDisplay();
    expect(settings.displayTrial.value).toBeUndefined();
    await advanceTimersByTimeAsync(DISPLAY_TRIAL_MS);
    expect(asked(`os_display_set`)).toHaveLength(1);

    // Bigger text, on trial, put back by a press.
    await settings.setDisplay(`eDP-1`, { scale: 2 });
    await settings.undoDisplay();
    expect(asked(`os_display_set`).at(-1)?.args).toEqual({ output: `eDP-1`, mode: null, scale: 1.5 });
    expect(settings.displayTrial.value).toBeUndefined();

    // Nobody answers: it goes back by itself, to what the reader last said yes to.
    await settings.setDisplay(`DP-2`, { mode: fullHd });
    await settings.setDisplay(`DP-2`, { mode: { width: 2560, height: 1440, refresh: 59.951 } });
    await advanceTimersByTimeAsync(DISPLAY_TRIAL_MS);
    await waitFor(() => expect(asked(`os_display_set`).at(-1)?.args).toEqual({ output: `DP-2`, mode: native, scale: null }));
    expect(settings.displayTrial.value).toBeUndefined();

    // A change ic refused is nothing to keep.
    failing.set(`os_display_set`, `the screen does not offer that mode`);
    await settings.setDisplay(`DP-2`, { mode: fullHd });
    expect(settings.displayTrial.value).toBeUndefined();
    expect(settings.displayError.value).toContain(`does not offer that mode`);
});

it(`reads the layouts once, and sets a layout with or without its variant`, async () => {
    const settings = await load();
    await settings.loadKeyboardLayouts();
    await settings.loadKeyboardLayouts();
    expect(asked(`os_keyboard_layouts`)).toHaveLength(1);
    expect(settings.keyboardLayouts.value?.layouts).toHaveLength(3);

    await settings.setKeyboard(`us`, `dvorak`);
    await settings.setKeyboard(`pl`);
    expect(asked(`os_keyboard_set`).map((call) => call.args)).toEqual([
        { layout: `us`, variant: `dvorak` },
        { layout: `pl`, variant: null },
    ]);
    expect(asked(`os_keyboard_status`)).toHaveLength(2);
    failing.set(`os_keyboard_set`, `there is no layout zz`);
    await settings.setKeyboard(`zz`);
    expect(settings.keyboardError.value).toContain(`no layout zz`);
    expect(settings.keyboardChanging.value).toBe(false);
});
