import { expect, test } from "vitest";
import { answerConfirm, type ConfirmOps } from "./probe.js";

/* Answering the confirmation, asserted against a fake desktop: the one piece of `probe.ts` that decides
 * something rather than asking the machine a question, and the piece a real Windows session can only exercise
 * one outcome of per run. The case that matters is the RACE: `focusWindow` proves the dialog had the keyboard
 * when it returned, and the Return is a separate round trip, so a window that maps in between takes the
 * keystroke with it. The app's own main window does exactly that on a cold start, which is how a dialog that
 * was never answered came back as "the setup screen never appeared".
 *
 * The clock only moves when the loop sleeps, as in `harness.test.ts`, so a test controls how many presses
 * happen rather than waiting out real seconds.
 */

interface Fake {
    readonly ops: ConfirmOps;
    /** One entry per press, saying which window id had the keyboard when it went out. */
    readonly presses: string[];
}

/** A dialog that closes on the nth press: `Infinity` for one that never does. */
const dialog = (closesOnPress: number, options: { readonly focusFails?: number; readonly present?: boolean } = {}): Fake => {
    const presses: string[] = [];
    let clock = 0;
    let open = options.present ?? true;
    let focusAttempts = 0;
    return {
        presses,
        ops: {
            showing: async () => (open ? `0x1234` : undefined),
            focus: async () => {
                focusAttempts += 1;
                if (focusAttempts <= (options.focusFails ?? 0)) {
                    throw new Error(`Windows would not give window 0x1234 the keyboard`);
                }
            },
            press: async () => {
                presses.push(`0x1234`);
                if (presses.length >= closesOnPress) {
                    open = false;
                }
            },
            sleep: async (ms) => {
                clock += ms;
            },
            now: () => clock,
        },
    };
};

test("a dialog that takes the first Return is answered once", async () => {
    const fake = dialog(1);
    expect(await answerConfirm(`intentic-desktop`, `Set up a sandbox`, fake.ops)).toBeUndefined();
    expect(fake.presses).toHaveLength(1);
});

test("a Return the app's own window intercepted is sent again, and the dialog closing is the proof", async () => {
    const fake = dialog(2);
    expect(await answerConfirm(`intentic-desktop`, `Set up a sandbox`, fake.ops)).toBeUndefined();
    expect(fake.presses).toHaveLength(2);
});

test("a dialog that never closes answers with why, naming how many presses it took to be sure", async () => {
    const fake = dialog(Number.POSITIVE_INFINITY);
    const refusal = await answerConfirm(`intentic-desktop`, `Set up a sandbox`, fake.ops);
    expect(refusal).toContain(`Set up a sandbox`);
    expect(refusal).toContain(`3 presses`);
    // It gives up rather than pressing forever: the tier has its own deadlines to spend.
    expect(fake.presses).toHaveLength(3);
});

test("a machine that would not hand over the keyboard is reported in its own words", async () => {
    const fake = dialog(Number.POSITIVE_INFINITY, { focusFails: Number.POSITIVE_INFINITY });
    expect(await answerConfirm(`intentic-desktop`, `Set up a sandbox`, fake.ops)).toContain(`would not give window 0x1234 the keyboard`);
    expect(fake.presses).toHaveLength(0);
});

test("focus refused once is retried, not reported: a foreground held for a moment is not a machine that refuses", async () => {
    const fake = dialog(1, { focusFails: 1 });
    expect(await answerConfirm(`intentic-desktop`, `Set up a sandbox`, fake.ops)).toBeUndefined();
    expect(fake.presses).toHaveLength(1);
});

test("no dialog at all is a refusal, not a silent pass: nothing was answered", async () => {
    const fake = dialog(1, { present: false });
    expect(await answerConfirm(`intentic-desktop`, `Set up a sandbox`, fake.ops)).toContain(`no window of intentic-desktop's is showing`);
    expect(fake.presses).toHaveLength(0);
});
