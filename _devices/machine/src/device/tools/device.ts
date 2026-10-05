import {
    DesktopError,
    describeInput,
    type Desktop,
    desktopPointing,
    type InputAction,
    type InputCall,
    keyboardText,
    MAX_WAIT_MS,
    parseChord,
    perform,
    type Pointing,
    SETTLE_MS,
} from "@intentic/desktop-automation";
import { sleep } from "@intentic/base/async";
import { COMMAND_CLASS_LABELS, type DeviceScopes } from "@intentic/sandbox-contract";
import { calling, type Indicator, machineIndicator } from "../indicator.js";
import { assertScope, ScopeError } from "../policy.js";
import { destructiveClasses } from "./shell.js";

// GUI work for what has no command-line way in. The mechanics live in @intentic/desktop-automation (`perform`
// carries an action out, view.ts reads its coordinates); this file decides whether an action is allowed: `screenshot`
// needs `screen`, every action here needs `control`, and neither implies the other. Coordinates are pixels of the
// screenshot they were read off; out-of-frame ones are refused rather than clamped.

export type DeviceAction = InputAction;
export type DeviceInput = InputCall;

export const describeAction = describeInput;
/* What no agent may press, whatever its switches: each leaves the desktop for one nothing here can reach again until
   a person signs back in (the lock screen, the secure attention screen, a text console), so the agent that pressed
   it can neither see nor undo what it did. Matched on the parsed chord, so "win+l", "super+L" and "cmd+l" are one. */
const LOCKOUT_CHORDS: readonly { readonly modifiers: readonly string[]; readonly key: RegExp; readonly why: string }[] = [
    { modifiers: ["super"], key: /^l$/i, why: "locks the screen" },
    { modifiers: ["ctrl", "alt"], key: /^(Delete|End)$/, why: "opens the secure sign-in screen" },
    { modifiers: ["ctrl", "alt"], key: /^BackSpace$/, why: "ends the graphical session" },
    { modifiers: ["ctrl", "alt"], key: /^F([1-9]|1[0-2])$/, why: "switches to a text console" },
];

export const assertNotLockout = (combo: string): void => {
    const chord = parseChord(combo);
    const held = [...chord.modifiers].sort().join("+");
    const blocked = LOCKOUT_CHORDS.find((rule) => [...rule.modifiers].sort().join("+") === held && rule.key.test(chord.key));
    if (blocked !== undefined) {
        throw new DesktopError(
            `Refused: ${combo} ${blocked.why}, and nothing driving this device can get back from there until a person signs in. Ask the user to do it themselves.`,
        );
    }
};

/* Text that would delete if a terminal ran it. Typing into a shell IS running a command, so text the command
   classifier reads as destructive needs the same "Run destructive commands" switch run_command does: without this,
   `device type "rm -rf ~\n"` is the spelling that gets past it. Ordinary prose matches nothing and costs nothing. */
export const assertTypable = (text: string, scopes: DeviceScopes): void => {
    if (scopes.destructive === "on") {
        return;
    }
    const classes = destructiveClasses(text);
    if (classes.length > 0) {
        throw new ScopeError(
            `Refused: typed into a terminal, this would ${classes.map((commandClass) => COMMAND_CLASS_LABELS[commandClass]).join(" and ")} on this device, ` +
                `and "Run destructive commands" is switched off for it. Typing a command is running it, so the same switch decides. ` +
                `Turn it on in its capability card to allow this, or type something that does not delete.`,
        );
    }
};
// Perform one action. Returns nothing; the caller reports describeAction plus, when it may look, a fresh
// screenshot. Every action but `wait` is judged, then put on the machine's own screen, and refused while its person
// pauses. `pointing` reads the agent's coordinates; without one they are desktop pixels, which is what a test means.
export const act = async (
    screen: Desktop,
    input: DeviceInput,
    scopes: DeviceScopes,
    indicator: Indicator = machineIndicator(),
    pointing: Pointing = desktopPointing(screen),
): Promise<void> => {
    assertScope(scopes, "control");
    if (input.action === "wait") {
        await sleep(Math.min(Math.max(0, input.ms ?? SETTLE_MS), MAX_WAIT_MS));
        return;
    }
    if (input.action === "key") {
        assertNotLockout(keyboardText("key", input.text));
    }
    if (input.action === "type") {
        assertTypable(keyboardText("type", input.text), scopes);
    }
    await indicator.control(calling.getStore());
    await perform(screen, input, pointing);
};

// The settle the confirming screenshot needs. Separate from `act` so a caller that does not want the frame (a
// test, a batch of moves) does not pay for it.
export { settle } from "@intentic/desktop-automation";
