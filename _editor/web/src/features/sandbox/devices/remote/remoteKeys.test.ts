// The keyboard of a remote computer: physical keys pressed and released as the hand does, nothing kept for this page,
// a Mac's Command as the far end's Control, what an input method or a phone keyboard types left to the browser, the paste
// chord waiting for this computer's clipboard, and everything let go when the picture loses the keyboard.
import "@intentic/testing/dom";
import { PASTE_WAIT_MS, remoteKeys, type RemoteKeyMessage, SEND_KEYS } from "./remoteKeys";

const key = (type: `keydown` | `keyup`, init: KeyboardEventInit): KeyboardEvent => new KeyboardEvent(type, { cancelable: true, ...init });

const harness = (isMac = false) => {
    const sent: RemoteKeyMessage[] = [];
    const timers: { run: () => void; ms: number; cancelled: boolean }[] = [];
    const keys = remoteKeys({
        send: (message) => sent.push(message),
        isMac,
        later: (run, ms) => {
            const timer = { run, ms, cancelled: false };
            timers.push(timer);
            return () => (timer.cancelled = true);
        },
    });
    return { keys, sent, timers };
};

it("sends every key as its physical key, down and then up, and keeps none of them for this page", () => {
    const { keys, sent } = harness();
    const meta = key(`keydown`, { key: `Meta`, code: `MetaLeft`, metaKey: true });
    keys.keydown(meta);
    keys.keydown(key(`keydown`, { key: `Tab`, code: `Tab`, metaKey: true }));
    keys.keyup(key(`keyup`, { key: `Tab`, code: `Tab`, metaKey: true }));
    keys.keyup(key(`keyup`, { key: `Meta`, code: `MetaLeft` }));
    expect(meta.defaultPrevented).toBe(true);
    expect(sent).toEqual([
        { type: `key`, key: `Meta`, code: `MetaLeft`, action: `down` },
        { type: `key`, key: `Tab`, code: `Tab`, action: `down` },
        { type: `key`, key: `Tab`, code: `Tab`, action: `up` },
        { type: `key`, key: `Meta`, code: `MetaLeft`, action: `up` },
    ]);
});

it("sends a dead key as the key it is, so the far end's own layout composes the accent", () => {
    const { keys, sent } = harness();
    keys.keydown(key(`keydown`, { key: `Dead`, code: `Quote` }));
    expect(sent).toEqual([{ type: `key`, key: `Dead`, code: `Quote`, action: `down` }]);
});

it("sends a Mac's Command as the far end's Control", () => {
    const { keys, sent } = harness(true);
    keys.keydown(key(`keydown`, { key: `Meta`, code: `MetaRight`, metaKey: true }));
    keys.keyup(key(`keyup`, { key: `Meta`, code: `MetaRight` }));
    expect(sent).toEqual([
        { type: `key`, key: `Control`, code: `ControlRight`, action: `down` },
        { type: `key`, key: `Control`, code: `ControlRight`, action: `up` },
    ]);
});

it("leaves to the browser what it types itself: a composition, and a phone keyboard's keys with no physical key", () => {
    const { keys, sent } = harness();
    const composing = key(`keydown`, { key: `Process`, code: `KeyA` });
    const phone = key(`keydown`, { key: `Unidentified`, code: `` });
    keys.keydown(composing);
    keys.keydown(phone);
    expect(sent).toEqual([]);
    expect([composing.defaultPrevented, phone.defaultPrevented]).toEqual([false, false]);
});

it("lets the paste chord's V wait for the paste that carries this computer's clipboard, and sends it alone if none comes", () => {
    const { keys, sent, timers } = harness();
    keys.keydown(key(`keydown`, { key: `Control`, code: `ControlLeft`, ctrlKey: true }));
    const paste = key(`keydown`, { key: `v`, code: `KeyV`, ctrlKey: true });
    keys.keydown(paste);
    expect(paste.defaultPrevented).toBe(false);
    expect(timers.map((timer) => timer.ms)).toEqual([PASTE_WAIT_MS]);
    // The paste came: it sends the clipboard and its own chord, and the V waiting here is dropped.
    keys.pasted();
    expect(timers[0]!.cancelled).toBe(true);
    // A second V with nothing on the clipboard: it goes once the wait is over.
    keys.keydown(key(`keydown`, { key: `v`, code: `KeyV`, ctrlKey: true }));
    timers.at(-1)!.run();
    expect(sent.slice(1)).toEqual([
        { type: `key`, key: `v`, code: `KeyV`, action: `down` },
        { type: `key`, key: `v`, code: `KeyV`, action: `up` },
    ]);
});

it("lets go of everything held when the picture loses the keyboard, and sends no up for a key it never put down", () => {
    const { keys, sent } = harness();
    keys.keydown(key(`keydown`, { key: `Shift`, code: `ShiftLeft`, shiftKey: true }));
    keys.releaseAll();
    keys.keyup(key(`keyup`, { key: `Shift`, code: `ShiftLeft` }));
    expect(sent).toEqual([{ type: `key`, key: `Shift`, code: `ShiftLeft`, action: `down` }, { type: `releaseAll` }]);
});

it("presses a menu chord down in order and up in reverse", () => {
    const { keys, sent } = harness();
    keys.press(SEND_KEYS.ctrlAltDel);
    expect(sent.map((message) => (message.type === `key` ? `${message.action} ${message.code}` : message.type))).toEqual([
        `down ControlLeft`,
        `down AltLeft`,
        `down Delete`,
        `up Delete`,
        `up AltLeft`,
        `up ControlLeft`,
    ]);
});
