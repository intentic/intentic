import { noticeScript } from "./notice-windows.js";

/* What the helper asks Windows for. Whether Windows honours it is for a person at a Windows screen to see; that the
   script asks for every property the notice's promises rest on, with the values WinUser.h gives them, is pinned here. */

const script = noticeScript("Ctrl+Alt+Shift+P");

// The value each is declared with, as C# spells it.
const declared = (name: string): number | undefined => {
    const value = new RegExp(String.raw`const u?int ${name} = (0x[0-9A-Fa-f]+);`).exec(script)?.[1];
    return value === undefined ? undefined : Number(value);
};

test("the window never takes focus, lets every click through, stays on top and stays out of the taskbar", () => {
    const styles = {
        WS_EX_NOACTIVATE: 0x0800_0000,
        WS_EX_TRANSPARENT: 0x0000_0020,
        WS_EX_LAYERED: 0x0008_0000,
        WS_EX_TOOLWINDOW: 0x0000_0080,
        WS_EX_TOPMOST: 0x0000_0008,
    };
    expect(Object.fromEntries(Object.keys(styles).map((name) => [name, declared(name)]))).toEqual(styles);
    // All five ORed into the extended style the window is created with.
    const applied = /ExStyle \|= ([A-Z_ |]+);/
        .exec(script)?.[1]
        ?.split("|")
        .map((name) => name.trim());
    expect(applied?.toSorted()).toEqual(Object.keys(styles).toSorted());
    // A layered window draws nothing until it is given an alpha.
    expect(script).toContain("SetLayeredWindowAttributes(Handle, 0, 235, LWA_ALPHA)");
});

// Otherwise it would cover part of every screenshot the agent reads, and it would read its own notice.
test("the window is left out of screen captures, and without that it does not stay up", () => {
    expect(declared("WDA_EXCLUDEFROMCAPTURE")).toBe(0x11);
    expect(script).toContain("if (!SetWindowDisplayAffinity(Handle, WDA_EXCLUDEFROMCAPTURE)) {\n        Quit(");
});

// Typing goes to the focused window, so a notice that took focus would take the agent's keystrokes with it.
test("nothing in it activates a window", () => {
    expect(script).not.toMatch(/Activate\(|SetForegroundWindow|\.Focus\(|\.Show\(|ShowDialog|ShowWindow/);
    expect(script).toContain("ShowWithoutActivation { get { return true; } }");
    expect(script).toContain("SWP_NOACTIVATE | SWP_SHOWWINDOW");
});

test("the hotkey is registered as the chord it was given: Ctrl (2) + Alt (1) + Shift (4), and P's key code", () => {
    expect(script).toContain("RegisterHotKey(Handle, HOTKEY_ID, modifiers | MOD_NOREPEAT, key)");
    expect(script.split("\n").at(-1)).toBe("[IntenticNotice.Pill]::Run(7, 80)");
    // One modifier at a time, since a sum of all three cannot tell two of their bits apart.
    expect(["alt+F4", "ctrl+q", "shift+Return", "win+F9"].map((chord) => noticeScript(chord).split("\n").at(-1))).toEqual([
        "[IntenticNotice.Pill]::Run(1, 115)",
        "[IntenticNotice.Pill]::Run(2, 81)",
        "[IntenticNotice.Pill]::Run(4, 13)",
        "[IntenticNotice.Pill]::Run(8, 120)",
    ]);
});

// The script is one command-line argument, and CreateProcess refuses a command line past 32,767 characters.
test("the script fits on a Windows command line with room to spare", () => {
    expect(script.length + (script.match(/"/g)?.length ?? 0)).toBeLessThan(16_000);
});
