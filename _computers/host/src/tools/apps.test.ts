import type { HostScopes } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { ScopeError } from "../policy.js";
import { fakeDesktop, fakeWindow } from "../testing.js";
import { describeWindows, focusWindow, listWindows, openTarget, readClipboard, writeClipboard } from "./apps.js";

/* Operating applications, at the layer that decides what is allowed and what gets reported.
 *
 * The scope split is the thing worth pinning: seeing what is open and reading the clipboard are ways of LOOKING
 * (screen), focusing a window and setting the clipboard CHANGE what the machine is doing (control), and opening
 * an application starts a process (shell). Somebody will eventually be tempted to collapse these; these tests are
 * why they should not. */

const scopes = (overrides: Partial<HostScopes> = {}): HostScopes => ({
    shell: "on",
    write: "on",
    screen: "on",
    control: "on",
    sandboxes: "on",
    sandboxRemove: "on",
    ...overrides,
});

test("listing windows is looking, so it needs the screen grant", async () => {
    const fake = fakeDesktop();
    fake.windows = [fakeWindow({ id: "7", app: "chrome", title: "Gmail" })];
    await expect(listWindows(fake.desktop, scopes({ screen: "off" }))).rejects.toThrow(ScopeError);
    expect(await listWindows(fake.desktop, scopes())).toContain("Gmail");
});

test("focusing is touching, so it needs the control grant — not the screen one", async () => {
    const fake = fakeDesktop();
    fake.windows = [fakeWindow({ id: "7", app: "chrome", title: "Gmail" })];
    await expect(focusWindow(fake.desktop, "7", scopes({ control: "off" }))).rejects.toThrow(/mouse and keyboard/);
    expect(fake.calls).toEqual([]);
    await focusWindow(fake.desktop, "7", scopes({ screen: "off" }));
    expect(fake.calls).toEqual(["focus 7"]);
});

// The agent's next action is typing, and typing goes wherever focus went — so the tool says where that was.
test("focus reports the window it actually landed on", async () => {
    const fake = fakeDesktop();
    fake.windows = [fakeWindow({ id: "1", app: "code", title: "editor" }), fakeWindow({ id: "2", app: "chrome", title: "Gmail" })];
    const said = await focusWindow(fake.desktop, "2", scopes());
    expect(said).toContain("chrome — Gmail");
    expect(said).toMatch(/Typing now goes here/);
});

test("opening starts a process, so it rides the shell grant", async () => {
    const fake = fakeDesktop();
    await expect(openTarget(fake.desktop, "https://example.com", scopes({ shell: "off" }))).rejects.toThrow(/Run commands/);
    expect(await openTarget(fake.desktop, "https://example.com", scopes())).toContain("https://example.com");
    expect(fake.calls).toEqual(["launch https://example.com"]);
});

test("the clipboard splits the same way: reading looks, writing changes", async () => {
    const fake = fakeDesktop();
    fake.clipboard = "copied earlier";
    await expect(readClipboard(fake.desktop, scopes({ screen: "off" }))).rejects.toThrow(ScopeError);
    expect(await readClipboard(fake.desktop, scopes())).toBe("copied earlier");

    await expect(writeClipboard(fake.desktop, "new", scopes({ control: "off" }))).rejects.toThrow(ScopeError);
    await writeClipboard(fake.desktop, "new", scopes());
    expect(fake.clipboard).toBe("new");
});

// What was PUT on the clipboard is as likely to be a password as anything typed, so it is counted, not echoed.
test("writing the clipboard reports a length, never the text", async () => {
    const fake = fakeDesktop();
    const said = await writeClipboard(fake.desktop, "hunter2", scopes());
    expect(said).toContain("7 characters");
    expect(said).not.toContain("hunter2");
});

test("an empty clipboard says so rather than answering with nothing", async () => {
    const fake = fakeDesktop();
    expect(await readClipboard(fake.desktop, scopes())).toMatch(/empty/);
});

test("focus refuses an empty id with the sentence that says where ids come from", async () => {
    const fake = fakeDesktop();
    await expect(focusWindow(fake.desktop, "", scopes())).rejects.toThrow(/window list/);
});

/* The rendering is what the model reads to choose a window, so it carries the id it must pass back, the app and
 * title a person would recognise, and the geometry that makes "click the middle of it" arithmetic. */
test("the window list reads as something to choose from", () => {
    const rendered = describeWindows([
        fakeWindow({ id: "1", app: "code", title: "editor", focused: true }),
        fakeWindow({ id: "2", app: "chrome", title: "Gmail", bounds: { x: 10, y: 20, width: 800, height: 600 } }),
    ]);
    expect(rendered).toContain("[1] code — editor");
    expect(rendered).toContain("[2] chrome — Gmail");
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
