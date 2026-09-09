import { expect, test } from "vitest";
import { focusRefusal, looksLikeUrl, parseSessionJson, parseSwayTree, parseWindowsJson, parseWmctrl } from "./parse.js";

/* Reading a platform's window list. Every case here is one somebody has actually been bitten by — a title with
 * spaces truncated at the first one, a single window arriving as an object instead of an array, the same window
 * called 0x0340_0007 by one tool and 54525959 by another. */

const WMCTRL = [
    "0x03400007  0 4242   0    0    1920 1080 code.Code            box  intentic — device.ts — Visual Studio Code",
    "0x02a00003  0 1337   100  50   1280 720  google-chrome.Google-chrome box  Inbox (12) — Gmail",
    "0x01000002  0 999    0    0    400  300  Navigator.Firefox    box  ",
].join("\n");

test("wmctrl rows keep the whole title, spaces, dashes and all", () => {
    const windows = parseWmctrl(WMCTRL);
    expect(windows).toHaveLength(3);
    expect(windows[0]?.title).toBe("intentic — device.ts — Visual Studio Code");
    expect(windows[1]?.title).toBe("Inbox (12) — Gmail");
});

test("the app is the recognisable half of the WM class", () => {
    const windows = parseWmctrl(WMCTRL);
    expect(windows.map((window) => window.app)).toEqual(["Code", "Google-chrome", "Firefox"]);
});

test("geometry comes through as numbers, ready to click the middle of", () => {
    const [, chrome] = parseWmctrl(WMCTRL);
    expect(chrome?.bounds).toEqual({ x: 100, y: 50, width: 1280, height: 720 });
});

// wmctrl prints hex ids, xdotool answers in decimal — the same window, and it must be recognised as focused.
test("the focused window is matched across hex and decimal spellings", () => {
    const windows = parseWmctrl(WMCTRL, String(0x03400007));
    expect(windows.filter((window) => window.focused).map((window) => window.app)).toEqual(["Code"]);
});

test("an untitled window still lists, and junk lines are skipped", () => {
    const windows = parseWmctrl(`${WMCTRL}\ngarbage\n\n`);
    expect(windows).toHaveLength(3);
    expect(windows[2]?.title).toBe("");
});

const SWAY = JSON.stringify({
    id: 1,
    nodes: [
        {
            id: 2,
            nodes: [
                {
                    id: 3,
                    name: "workspace 1",
                    nodes: [
                        { id: 10, name: "Firefox — Gmail", app_id: "firefox", rect: { x: 0, y: 0, width: 1920, height: 1040 }, focused: true },
                        {
                            id: 11,
                            name: "Alacritty",
                            window_properties: { class: "Alacritty" },
                            rect: { x: 0, y: 0, width: 960, height: 520 },
                            focused: false,
                        },
                    ],
                    floating_nodes: [{ id: 12, name: "Calculator", app_id: "gnome-calculator", rect: { x: 40, y: 40, width: 300, height: 400 } }],
                },
            ],
        },
    ],
});

test("sway's tree is flattened to its leaves, tiled and floating alike", () => {
    const windows = parseSwayTree(SWAY);
    expect(windows.map((window) => window.title).toSorted()).toEqual(["Alacritty", "Calculator", "Firefox — Gmail"]);
    // A container that holds other windows is a split, not a window, whatever its name.
    expect(windows.map((window) => window.title)).not.toContain("workspace 1");
});

test("sway windows carry app id or X11 class, whichever they have", () => {
    const windows = parseSwayTree(SWAY);
    expect(windows.find((window) => window.title === "Firefox — Gmail")?.app).toBe("firefox");
    expect(windows.find((window) => window.title === "Alacritty")?.app).toBe("Alacritty");
    expect(windows.find((window) => window.focused)?.title).toBe("Firefox — Gmail");
});

test("unparseable output is an empty list, not a crash", () => {
    expect(parseSwayTree("not json")).toEqual([]);
    expect(parseWindowsJson("not json")).toEqual([]);
});

/* PowerShell's ConvertTo-Json emits a bare object when the pipeline produced exactly one row, and an array
 * otherwise. Accepting both is cheaper than requiring PowerShell 7's -AsArray, which many machines do not have. */
test("PowerShell's single-window output is read as a list", () => {
    const one = parseWindowsJson('{"id":"263248","title":"Untitled - Notepad","app":"notepad","x":0,"y":0,"width":800,"height":600,"focused":true}');
    expect(one).toHaveLength(1);
    expect(one[0]?.app).toBe("notepad");
    expect(one[0]?.focused).toBe(true);
});

test("PowerShell's many-window output is read the same way", () => {
    const many = parseWindowsJson(
        '[{"id":"1","title":"A","app":"a","x":0,"y":0,"width":10,"height":10,"focused":false},{"id":"2","title":"B","app":"b","x":1,"y":2,"width":3,"height":4,"focused":true}]',
    );
    expect(many.map((window) => window.id)).toEqual(["1", "2"]);
    expect(many[1]?.bounds).toEqual({ x: 1, y: 2, width: 3, height: 4 });
});

test("two top-level windows owned by one process remain two windows", () => {
    const windows = parseWindowsJson(
        '[{"id":"21","title":"Intentic","app":"intentic","x":0,"y":0,"width":800,"height":600,"focused":false},{"id":"22","title":"Set up a sandbox?","app":"intentic","x":100,"y":100,"width":400,"height":220,"focused":true}]',
    );
    expect(windows.map((window) => window.id)).toEqual(["21", "22"]);
    expect(windows.map((window) => window.app)).toEqual(["intentic", "intentic"]);
});

// A handle of 0 is a process without a real window; listing it would offer the agent something unfocusable.
test("windows without a usable handle are dropped", () => {
    expect(parseWindowsJson('{"id":"0","title":"ghost","app":"svchost"}')).toEqual([]);
});

test("what counts as something to OPEN rather than a program to run", () => {
    expect(looksLikeUrl("https://example.com")).toBe(true);
    expect(looksLikeUrl("www.example.com")).toBe(true);
    expect(looksLikeUrl("mailto:someone@example.com")).toBe(true);
    expect(looksLikeUrl("code")).toBe(false);
    expect(looksLikeUrl("/usr/bin/firefox")).toBe(false);
});

/* Reading the session, which is the read `windows()` cannot make: on the machine this was written for, the
 * Windows smoke tier's doctor printed "9 window(s) currently open, none holding the foreground" while the
 * keyboard was held by the lock screen — a window EnumWindows does not return — and every focus after it was
 * refused. Searching a window list for the foreground answers "nobody" in exactly the case that matters. */

test("the foreground holder comes back even when it is the lock screen's own window", () => {
    const state = parseSessionJson('{"locked":true,"id":"66048","title":"Windows Default Lock Screen","app":"LockApp"}');
    expect(state?.locked).toBe(true);
    expect(state?.foreground).toEqual({ id: "66048", title: "Windows Default Lock Screen", app: "LockApp" });
});

test("a zero handle is Windows saying nobody, not a window to go looking for", () => {
    expect(parseSessionJson('{"locked":false,"id":"0","title":"","app":""}')).toEqual({ locked: false, foreground: undefined });
});

// The distinction the old doctor line could not draw: a machine nobody could read reported as an idle one.
test("output that is not the shape asked for is undefined, not an unlocked desktop", () => {
    expect(parseSessionJson("")).toBeUndefined();
    expect(parseSessionJson("Get-Process : Access is denied.")).toBeUndefined();
    expect(parseSessionJson('{"id":"12","title":"A","app":"a"}')).toBeUndefined();
});

test("a refusal on a locked session says that, rather than listing what it might have been", () => {
    const said = focusRefusal("1900772", 3, { locked: true, foreground: { id: "66048", title: "", app: "LockApp" } });
    expect(said).toContain("sign-in screen");
    expect(said).toContain("sign in on that machine");
    expect(said).not.toContain("full-screen app");
});

test("a refusal with the desktop unlocked names the window that kept the keyboard", () => {
    const said = focusRefusal("4242", 3, { locked: false, foreground: { id: "99", title: "Save changes?", app: "notepad" } });
    expect(said).toContain(`"Save changes?" [notepad]`);
});

test("an untitled holder is still named by its program", () => {
    expect(focusRefusal("4242", 3, { locked: false, foreground: { id: "99", title: "", app: "ApplicationFrameHost" } })).toContain(
        "an untitled window [ApplicationFrameHost]",
    );
});

test("nothing in the foreground reads as a window that is gone, not as a machine that refused", () => {
    expect(focusRefusal("4242", 3, { locked: false, foreground: undefined })).toContain("the window is gone");
});

// The only branch allowed to be vague, and it says so instead of dressing a failed read as a diagnosis.
test("a session that could not be read admits it", () => {
    expect(focusRefusal("4242", 3, undefined)).toContain("nothing here could read which window has it");
});
