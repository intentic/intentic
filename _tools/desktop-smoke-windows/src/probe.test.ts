import { answerConfirm, type ConfirmOps } from "./probe.js";

// Answers the confirmation against a fake desktop, exercising the race where a window mapping between focus and Return
// steals the keystroke. Clock advances only when the loop sleeps, so a test controls press count without real seconds.

interface Fake {
    readonly ops: ConfirmOps;
    /** One entry per press, the window id that had the keyboard when it went out. */
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
    const title = `Set up a sandbox`;
    const fake = dialog(Number.POSITIVE_INFINITY);
    const refusal = await answerConfirm(`intentic-desktop`, title, fake.ops);
    expect(refusal).toContain(title);
    expect(refusal).toContain(String(fake.presses.length));
    expect(fake.presses).toHaveLength(3);
});

test("a machine that would not hand over the keyboard is reported in its own words", async () => {
    const fake = dialog(Number.POSITIVE_INFINITY, { focusFails: Number.POSITIVE_INFINITY });
    expect(await answerConfirm(`intentic-desktop`, `Set up a sandbox`, fake.ops)).toContain(`0x1234`);
    expect(fake.presses).toHaveLength(0);
});

test("focus refused once is retried, not reported: a foreground held for a moment is not a machine that refuses", async () => {
    const fake = dialog(1, { focusFails: 1 });
    expect(await answerConfirm(`intentic-desktop`, `Set up a sandbox`, fake.ops)).toBeUndefined();
    expect(fake.presses).toHaveLength(1);
});

test("no dialog at all is a refusal, not a silent pass: nothing was answered", async () => {
    const app = `intentic-desktop`;
    const title = `Set up a sandbox`;
    const fake = dialog(1, { present: false });
    expect(await answerConfirm(app, title, fake.ops)).toContain(app);
    expect(fake.presses).toHaveLength(0);
});

test("a window listing that fails mid-answer is retried, not thrown: a slow listing on a loaded runner is not a crash", async () => {
    const fake = dialog(1);
    let listings = 0;
    const showing = fake.ops.showing;
    const ops: ConfirmOps = {
        ...fake.ops,
        showing: async () => {
            listings += 1;
            if (listings === 1) {
                throw new Error(`"powershell.exe" did not answer within 15s and was stopped.`);
            }
            return await showing();
        },
    };
    expect(await answerConfirm(`intentic-desktop`, `Set up a sandbox`, ops)).toBeUndefined();
    expect(fake.presses).toHaveLength(1);
});

test("a desktop that answers nothing for longer than three tries still gets its Return: silence spends time, not presses", async () => {
    const fake = dialog(1);
    let listings = 0;
    const showing = fake.ops.showing;
    const ops: ConfirmOps = {
        ...fake.ops,
        // Run 37292817794: every listing for about two minutes after the cold launch was killed at 15s.
        showing: async () => {
            listings += 1;
            if (listings <= 8) {
                throw new Error(`"powershell.exe" did not answer within 15s and was stopped.`);
            }
            return await showing();
        },
    };
    expect(await answerConfirm(`intentic-desktop`, `Set up a sandbox`, ops)).toBeUndefined();
    expect(fake.presses).toHaveLength(1);
});

test("a desktop that never answers is reported in its own words, saying no Return went out", async () => {
    const fake = dialog(1);
    const ops: ConfirmOps = {
        ...fake.ops,
        showing: async () => {
            throw new Error(`"powershell.exe" did not answer within 15s and was stopped.`);
        },
    };
    expect(await answerConfirm(`intentic-desktop`, `Set up a sandbox`, ops)).toBe(
        `"powershell.exe" did not answer within 15s and was stopped. No Return went out in 150s of trying.`,
    );
    expect(fake.presses).toHaveLength(0);
});
