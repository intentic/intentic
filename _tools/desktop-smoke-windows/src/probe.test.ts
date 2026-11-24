import type { WindowInfo } from "@intentic/desktop-automation";
import { answerConfirm, type ConfirmOps } from "./probe.js";

const confirmation: WindowInfo = {
    id: `1234`,
    title: `Set up a sandbox on this device?`,
    app: `intentic-desktop`,
    focused: false,
    bounds: { x: 0, y: 0, width: 10, height: 10 },
    pid: 5678,
};

interface Fake {
    readonly ops: ConfirmOps;
    readonly clicks: WindowInfo[];
}

/** A dialog that closes on the nth click: `Infinity` for one that never does. */
const dialog = (closesOnClick: number, options: { readonly clickFails?: number; readonly present?: boolean } = {}): Fake => {
    const clicks: WindowInfo[] = [];
    let clock = 0;
    let open = options.present ?? true;
    let clickAttempts = 0;
    return {
        clicks,
        ops: {
            showing: async () => (open ? confirmation : undefined),
            click: async (window) => {
                clickAttempts += 1;
                if (clickAttempts <= (options.clickFails ?? 0)) {
                    throw new Error(`Window ${window.id} has no enabled "Set up" button.`);
                }
                clicks.push(window);
                if (clicks.length >= closesOnClick) {
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

test("clicks the dialog itself even when it does not have the keyboard", async () => {
    const fake = dialog(1);
    expect(await answerConfirm(`intentic-desktop`, `Set up a sandbox`, fake.ops)).toBeUndefined();
    expect(fake.clicks).toEqual([confirmation]);
});

test("clicks again if the dialog stays open after the first click", async () => {
    const fake = dialog(2);
    expect(await answerConfirm(`intentic-desktop`, `Set up a sandbox`, fake.ops)).toBeUndefined();
    expect(fake.clicks).toHaveLength(2);
});

test("a dialog that never closes answers with why, naming how many clicks it took to be sure", async () => {
    const title = `Set up a sandbox`;
    const fake = dialog(Number.POSITIVE_INFINITY);
    const refusal = await answerConfirm(`intentic-desktop`, title, fake.ops);
    expect(refusal).toContain(title);
    expect(refusal).toContain(String(fake.clicks.length));
    expect(fake.clicks).toHaveLength(3);
});

test("a machine that always refuses the click is reported in its own words", async () => {
    const fake = dialog(Number.POSITIVE_INFINITY, { clickFails: Number.POSITIVE_INFINITY });
    expect(await answerConfirm(`intentic-desktop`, `Set up a sandbox`, fake.ops)).toBe(`Window 1234 has no enabled "Set up" button.`);
    expect(fake.clicks).toHaveLength(0);
});

test("a transient click failure is retried", async () => {
    const fake = dialog(1, { clickFails: 1 });
    expect(await answerConfirm(`intentic-desktop`, `Set up a sandbox`, fake.ops)).toBeUndefined();
    expect(fake.clicks).toHaveLength(1);
});

test("a dialog that closes before the click is acknowledged can still have answered it", async () => {
    const fake = dialog(1);
    const ops: ConfirmOps = {
        ...fake.ops,
        click: async (window) => {
            await fake.ops.click(window);
            throw new Error(`timed out waiting for PowerShell`);
        },
    };
    expect(await answerConfirm(`intentic-desktop`, `Set up a sandbox`, ops)).toBeUndefined();
    expect(fake.clicks).toHaveLength(1);
});

test("no dialog at all is a refusal, not a silent pass: nothing was answered", async () => {
    const app = `intentic-desktop`;
    const title = `Set up a sandbox`;
    const fake = dialog(1, { present: false });
    expect(await answerConfirm(app, title, fake.ops)).toContain(app);
    expect(fake.clicks).toHaveLength(0);
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
    expect(fake.clicks).toHaveLength(1);
});

test("a desktop that answers nothing for longer than three tries still gets a click", async () => {
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
    expect(fake.clicks).toHaveLength(1);
});

test("a desktop that never answers is reported in its own words", async () => {
    const fake = dialog(1);
    const ops: ConfirmOps = {
        ...fake.ops,
        showing: async () => {
            throw new Error(`"powershell.exe" did not answer within 15s and was stopped.`);
        },
    };
    expect(await answerConfirm(`intentic-desktop`, `Set up a sandbox`, ops)).toBe(
        `"powershell.exe" did not answer within 15s and was stopped.`,
    );
    expect(fake.clicks).toHaveLength(0);
});
