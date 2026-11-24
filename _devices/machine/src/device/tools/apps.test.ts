import { createIndicator, type Indicator } from "../indicator.js";
import { ScopeError } from "../policy.js";
import { fakeDesktop, fakeIndicatorDeps, fakeWindow, grantWith } from "../device-testing.js";
import { describeWindows, focusWindow, listWindows, openTarget, readClipboard, writeClipboard } from "./apps.js";

// Operating applications, at the layer that decides what is allowed and what gets reported. The scope split:
// looking (windows, clipboard read) needs `screen`; changing (focus, clipboard write) needs `control`; opening
// starts a process and needs `shell`.

// Over fakes: the real indicator would read the pause file in this machine's own home directory.
const indicator = (): Indicator => createIndicator(fakeIndicatorDeps().deps);

test("listing windows is looking, so it needs the screen grant", async () => {
    const fake = fakeDesktop();
    fake.windows = [fakeWindow({ id: "7", app: "chrome", title: "Gmail" })];
    await expect(listWindows(fake.desktop, grantWith("agent", { screen: "off" }))).rejects.toThrow(ScopeError);
    expect(await listWindows(fake.desktop, grantWith("agent"))).toContain("Gmail");
});

test("focusing is touching, so it needs the control grant, not the screen one", async () => {
    const fake = fakeDesktop();
    fake.windows = [fakeWindow({ id: "7", app: "chrome", title: "Gmail" })];
    await expect(focusWindow(fake.desktop, "7", grantWith("agent", { control: "off" }), indicator())).rejects.toThrow(/mouse and keyboard/);
    expect(fake.calls).toEqual([]);
    await focusWindow(fake.desktop, "7", grantWith("agent", { screen: "off" }), indicator());
    expect(fake.calls).toEqual(["focus 7"]);
});

// The agent's next action is typing, and typing goes wherever focus went, so the tool says where that was.
test("focus reports the window it actually landed on", async () => {
    const fake = fakeDesktop();
    fake.windows = [fakeWindow({ id: "1", app: "code", title: "editor" }), fakeWindow({ id: "2", app: "chrome", title: "Gmail" })];
    const said = await focusWindow(fake.desktop, "2", grantWith("agent"), indicator());
    expect(said).toContain("chrome, Gmail");
    expect(said).toMatch(/Typing now goes here/);
});

test("opening a target that is a command answers to the switches a command does, a URL or a document does not", async () => {
    const fake = fakeDesktop();
    // On Linux a target with spaces is split into a program and arguments and spawned.
    await expect(openTarget(fake.desktop, "rm -rf /home/me/old", grantWith("agent", { destructive: "off" }))).rejects.toThrow(/Run destructive commands/);
    await expect(openTarget(fake.desktop, "ic sandbox restart work", grantWith("agent", { sandboxes: "off" }))).rejects.toThrow(/Manage sandboxes on this device/);
    expect(fake.calls).toEqual([]);
    await openTarget(fake.desktop, "https://example.com/docs", grantWith("agent", { destructive: "off", sandboxes: "off" }));
    await openTarget(fake.desktop, "/home/me/report.pdf", grantWith("agent", { destructive: "off", sandboxes: "off" }));
    await openTarget(fake.desktop, "ic sandbox restart work", grantWith("agent", { sandboxes: "on" }));
    expect(fake.calls).toEqual(["launch https://example.com/docs", "launch /home/me/report.pdf", "launch ic sandbox restart work"]);
});

test("opening starts a process, so it rides the shell grant", async () => {
    const fake = fakeDesktop();
    await expect(openTarget(fake.desktop, "https://example.com", grantWith("agent", { shell: "off" }))).rejects.toThrow(/Run commands/);
    expect(await openTarget(fake.desktop, "https://example.com", grantWith("agent"))).toContain("https://example.com");
    expect(fake.calls).toEqual(["launch https://example.com"]);
});

test("the clipboard splits the same way: reading looks, writing changes", async () => {
    const fake = fakeDesktop();
    fake.clipboard = "copied earlier";
    await expect(readClipboard(fake.desktop, grantWith("agent", { screen: "off" }))).rejects.toThrow(ScopeError);
    expect(await readClipboard(fake.desktop, grantWith("agent"))).toBe("The clipboard holds 14 characters. Its content is never read back.");

    await expect(writeClipboard(fake.desktop, "new", grantWith("agent", { control: "off" }), indicator())).rejects.toThrow(ScopeError);
    await writeClipboard(fake.desktop, "new", grantWith("agent"), indicator());
    expect(fake.clipboard).toBe("new");
});

// What was PUT on the clipboard is as likely to be a password as anything typed, so it is counted, not echoed.
test("writing the clipboard reports a length, never the text", async () => {
    const fake = fakeDesktop();
    const said = await writeClipboard(fake.desktop, "hunter2", grantWith("agent"), indicator());
    expect(said).toContain("7 characters");
    expect(said).not.toContain("hunter2");
});

// What the owner copied is as likely to be a password as what an agent puts there, and a read lands in a transcript.
test("reading the clipboard reports a length, never the text", async () => {
    const fake = fakeDesktop();
    fake.clipboard = "hunter2";
    const said = await readClipboard(fake.desktop, grantWith("agent"));
    expect(said).toBe("The clipboard holds 7 characters. Its content is never read back.");
    expect(said).not.toContain("hunter2");
});

test("an empty clipboard says so rather than answering with nothing", async () => {
    const fake = fakeDesktop();
    expect(await readClipboard(fake.desktop, grantWith("agent"))).toMatch(/empty/);
});

test("focus refuses an empty id with the sentence that says where ids come from", async () => {
    const fake = fakeDesktop();
    await expect(focusWindow(fake.desktop, "", grantWith("agent"), indicator())).rejects.toThrow(/window list/);
});

// Windows put the id into a PowerShell string where `$(…)` runs, and sway reads `;` as a second command: only the
// spellings the window lists hand out reach a backend.
test("focus refuses an id no window list hands out before the desktop sees it", async () => {
    const fake = fakeDesktop();
    for (const id of [`1$(Start-Process calc)`, `"; calc; "`, `5] exec xterm; [con_id=5`, `0x1 windowkill`, `1:2:3`, `--help`]) {
        await expect(focusWindow(fake.desktop, id, grantWith("agent"), indicator())).rejects.toThrow(`"${id}" is not a window id`);
    }
    expect(fake.calls).toEqual([]);
    // Every spelling a lister hands out: an HWND or a sway container, wmctrl's hex, cua-driver's pid and window.
    for (const id of [`132456`, `0x04600007`, `4242:17`]) {
        await focusWindow(fake.desktop, id, grantWith("agent"), indicator());
    }
    expect(fake.calls).toEqual([`focus 132456`, `focus 0x04600007`, `focus 4242:17`]);
});

// The rendering is what the model reads to choose a window, so it carries the id it must pass back, the app
// and title a person would recognise, and the geometry that makes "click the middle of it" arithmetic.
test("the window list reads as something to choose from", () => {
    const rendered = describeWindows([
        fakeWindow({ id: "1", app: "code", title: "editor", focused: true }),
        fakeWindow({ id: "2", app: "chrome", title: "Gmail", bounds: { x: 10, y: 20, width: 800, height: 600 } }),
    ]);
    expect(rendered).toContain("[1] code, editor");
    expect(rendered).toContain("[2] chrome, Gmail");
    expect(rendered).toContain("800×600 at 10,20");
    // The focused one is marked, because it is where typing would land right now.
    expect(
        rendered
            .split("\n")
            .find((line) => line.includes("[1]"))
            ?.startsWith("*"),
    ).toBe(true);
});

test("no windows is a sentence, not an empty string", () => {
    expect(describeWindows([])).toMatch(/No windows/);
});

test("a local pause holds focus and clipboard writes like any other input, before anything reaches the desktop", async () => {
    const fake = fakeDesktop();
    fake.windows = [fakeWindow({ id: "7" })];
    const paused = createIndicator(fakeIndicatorDeps({ paused: true }).deps);
    await expect(focusWindow(fake.desktop, "7", grantWith("agent"), paused)).rejects.toThrow(/paused by the person at this computer/);
    await expect(writeClipboard(fake.desktop, "new", grantWith("agent"), paused)).rejects.toThrow(ScopeError);
    expect(fake.calls).toEqual([]);
});
