import "@intentic/testing/dom";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { type EffectScope, effectScope, nextTick } from "vue";
import { controlCode, useTouchKeys } from "./useTouchKeys";

// Pins the touch keys: an armed Ctrl turns the next printable key into its control code and disarms, a key that is not
// printable leaves it armed, nothing is caught once disarmed or gone, and the row's keys send what a keyboard would.

const scopes: EffectScope[] = [];

const stage = () => {
    const sendInput = mock((_data: string) => undefined);
    const scope = effectScope();
    scopes.push(scope);
    const keys = scope.run(() => useTouchKeys(sendInput))!;
    return { sendInput, scope, keys };
};

const press = (key: string): KeyboardEvent => {
    const event = new KeyboardEvent(`keydown`, { key, cancelable: true });
    window.dispatchEvent(event);
    return event;
};

afterEach(() => {
    for (const scope of scopes.splice(0)) {
        scope.stop();
    }
});

describe(`the touch keys`, () => {
    it(`turns a letter into its control code and passes anything else through`, () => {
        expect([controlCode(`c`), controlCode(`D`), controlCode(`[`), controlCode(`1`)]).toEqual([`\x03`, `\x04`, `\x1b`, `1`]);
    });

    it(`sends the next printable key as a control code, once`, async () => {
        const { sendInput, keys } = stage();
        keys.ctrlArmed.value = true;
        await nextTick();
        const shifted = press(`Shift`);
        const letter = press(`c`);
        await nextTick();
        press(`c`);
        expect({ sent: sendInput.mock.calls, armed: keys.ctrlArmed.value }).toEqual({ sent: [[`\x03`]], armed: false });
        expect([shifted.defaultPrevented, letter.defaultPrevented]).toEqual([false, true]);
    });

    it(`catches nothing once the panel is gone`, async () => {
        const { sendInput, scope, keys } = stage();
        keys.ctrlArmed.value = true;
        await nextTick();
        scope.stop();
        press(`c`);
        expect(sendInput).not.toHaveBeenCalled();
    });

    it(`offers the keys a soft keyboard lacks`, () => {
        const { keys } = stage();
        expect(keys.EXTRA_KEYS.value.map((key) => key.data)).toEqual([`\x1b`, `\t`, `/`, `-`, `|`, `~`, `\x1b[A`, `\x1b[B`, `\x1b[D`, `\x1b[C`]);
    });
});
