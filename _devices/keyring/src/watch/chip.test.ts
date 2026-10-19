import type { KeyringRequest } from "../protocol.js";
import { watchEventOf } from "./apps.js";
import { CHIP_SECONDS, ChipController, FILL_LABEL, type FocusEvent, programOf, SAVE_LABEL } from "./chip.js";
import { showCommand } from "./watch-windows.js";

/* The chip's decisions: shown under a focused password field, "Fill" when an entry is saved for the program and "Save"
   when none is, gone when focus moves or its time is up, and a click asks the keyring to fill the window. The watcher
   programs (UI Automation, AT-SPI) are not run here. */

const field = (password: boolean, path = "C:\\Program Files\\Fortinet\\FortiClient\\FortiClient.exe"): FocusEvent => ({ event: "focus", password, path, x: 100.4, y: 200, width: 300, height: 24 });

const harness = (matches: number) => {
    const asked: KeyringRequest[] = [];
    const shown: string[] = [];
    const timers: (() => void)[] = [];
    const chip = new ChipController({
        ask: (request) => {
            asked.push(request);
            return Promise.resolve(request.op === "candidates" ? { ok: true, matches: Array.from({ length: matches }, () => ({ name: "VPN", title: "VPN" })) } : { ok: true, name: "VPN", program: "FortiClient.exe", saved: false });
        },
        surface: { show: (label, at) => shown.push(`${label}@${String(at.x)},${String(at.y)}`), hide: () => shown.push("hidden") },
        log: () => undefined,
        after: (ms, run) => {
            expect(ms).toBe(CHIP_SECONDS * 1000);
            timers.push(run);
            return () => undefined;
        },
    });
    return { asked, shown, timers, chip };
};

test("a password field with a saved entry gets Fill, under the field, asked by the program's file name", async () => {
    const { asked, shown, chip } = harness(1);
    await chip.onFocus(field(true));
    expect(asked).toEqual([{ op: "candidates", origin: { kind: "program", program: "FortiClient.exe" } }]);
    expect(shown).toEqual([`${FILL_LABEL}@100,226`]);
});

test("one with nothing saved gets Save; a field that is not a password field gets nothing", async () => {
    const saved = harness(0);
    await saved.chip.onFocus(field(true));
    expect(saved.shown).toEqual([`${SAVE_LABEL}@100,226`]);
    const plain = harness(1);
    await plain.chip.onFocus(field(false));
    expect(plain.shown).toEqual([]);
    expect(plain.asked).toEqual([]);
});

test("it goes when focus moves or its time is up, and a click fills the window", async () => {
    const { asked, shown, timers, chip } = harness(1);
    await chip.onFocus(field(true));
    await chip.onFocus(field(false));
    expect(shown.at(-1)).toBe("hidden");
    await chip.onFocus(field(true));
    timers.at(-1)?.();
    expect(chip.shown).toBe(false);
    await chip.onFocus(field(true));
    await chip.onClick();
    expect(asked.at(-1)).toEqual({ op: "fill-window" });
    expect(chip.shown).toBe(false);
});

test("a click with no chip shown does nothing", async () => {
    const { asked, chip } = harness(1);
    await chip.onClick();
    expect(asked).toEqual([]);
});

test("a watcher's lines are read only when marked, and the chip's commands carry no stray tab", () => {
    expect(watchEventOf('intentic-keyring>{"event":"click"}')).toEqual({ event: "click" });
    expect(watchEventOf('noise intentic-keyring>{"event":"focus","password":true,"path":"/usr/bin/x","x":1,"y":2,"width":3,"height":4}')).toMatchObject({ password: true });
    expect(watchEventOf("Add-Type warning")).toBeUndefined();
    expect(watchEventOf("intentic-keyring>{not json")).toBeUndefined();
    expect(showCommand("Fill\twith", { x: 1.6, y: 2 })).toBe("show\t2\t2\tFill");
    expect(programOf("/usr/lib/firefox/firefox")).toBe("firefox");
});
