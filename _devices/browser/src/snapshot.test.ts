import { join } from "node:path";
import { expect, test } from "vitest";
import {
    browserCandidates,
    executableFromCommand,
    executableFromDesktopEntry,
    isChromiumFamily,
    pickBrowser,
    profileDir,
    registryValue,
} from "./launch.js";
import { refIndex, renderPage, toPageState } from "./page.js";
import { SNAPSHOT_SCRIPT } from "./snapshot.js";

// Tests the parts of browser control that don't need a browser: rendering, ref lookup, and binary discovery; the
// CDP calls themselves need a real Chrome, not a test.

test("a page renders as its identity and then things to act on", () => {
    const rendered = renderPage({
        url: "https://mail.example.com/inbox",
        title: "Inbox (3)",
        elements: [
            { ref: "e0", role: "link", name: "Compose" },
            { ref: "e1", role: "textbox", name: "Search mail", value: "invoice" },
            { ref: "e2", role: "button", name: "Send" },
        ],
    });
    expect(rendered).toContain("Page: Inbox (3)");
    expect(rendered).toContain("https://mail.example.com/inbox");
    expect(rendered).toContain(`[e0] link "Compose"`);
    // A field's value matters as much as its name; it's how the agent knows a form is already filled.
    expect(rendered).toContain(`[e1] textbox "Search mail" = "invoice"`);
});

test("a page with nothing to act on says so instead of listing nothing", () => {
    const rendered = renderPage({ url: "https://example.com/report.pdf", title: "Report", elements: [] });
    expect(rendered).toMatch(/Nothing on this page can be clicked/);
    expect(rendered).toContain("read");
});

test("an untitled page still names itself", () => {
    expect(renderPage({ url: "about:blank", title: "", elements: [] })).toContain("(untitled)");
});

// Truncation must be visible: a list that silently stops at 150 reads as "that is everything on the page".
test("a truncated list says it was truncated", () => {
    const many = Array.from({ length: 3 }, (_unused, index) => ({ ref: `e${index}`, role: "link", name: `link ${index}` }));
    expect(renderPage({ url: "u", title: "t", elements: many }, true)).toMatch(/only the first \d+ are listed/);
    expect(renderPage({ url: "u", title: "t", elements: many }, false)).not.toMatch(/only the first/);
});

test("references are read back, and anything that is not one of ours is refused", () => {
    expect(refIndex("e0")).toBe(0);
    expect(refIndex("e42")).toBe(42);
    expect(refIndex("  e7 ")).toBe(7);
    // A model improvising a CSS selector should get a refusal, not a silent no-op against element 0.
    expect(refIndex("button.submit")).toBe(-1);
    expect(refIndex("#send")).toBe(-1);
    expect(refIndex("")).toBe(-1);
});

test("a missing snapshot answers as an empty page rather than throwing", () => {
    expect(toPageState({})).toEqual({ url: "", title: "", elements: [] });
    expect(toPageState({ url: "u", title: "t" }).elements).toEqual([]);
});

// Injected script runs inside somebody's page, where a syntax error is invisible until it hits an untested site;
// parsing it here is the cheapest guard without a browser.
test("the injected script is syntactically valid javascript", () => {
    expect(() => new Function(`return ${SNAPSHOT_SCRIPT}`)).not.toThrow();
});

test("the injected script avoids the template literals it is embedded in", () => {
    // Nesting template literals here creates a bug that only appears at runtime, so none are used.
    expect(SNAPSHOT_SCRIPT).not.toContain("`");
});

test("a Chromium-family browser is looked for where each platform keeps one", () => {
    const windows = browserCandidates("win32");
    expect(windows.some((path) => path.includes("brave.exe"))).toBe(true);
    expect(windows.some((path) => path.includes("chrome.exe"))).toBe(true);
    expect(windows.some((path) => path.includes("msedge.exe"))).toBe(true);
    const linux = browserCandidates("linux");
    expect(linux).toContain("/usr/bin/brave-browser");
    expect(linux).toContain("/usr/bin/google-chrome");
    expect(linux.some((path) => path.includes("chromium"))).toBe(true);
});

// The fallback order is the guess made when the OS won't name a default, and the guess is "whichever browser was
// installed on purpose": Edge ships with Windows, so finding it proves nothing about what its owner wants.
test("a browser installed on purpose is guessed before the one the OS shipped", () => {
    const rank = (paths: string[], name: string): number => paths.findIndex((path) => path.toLowerCase().includes(name));
    const windows = browserCandidates("win32");
    expect(rank(windows, "brave")).toBeLessThan(rank(windows, "chrome"));
    expect(rank(windows, "chrome")).toBeLessThan(rank(windows, "msedge"));
    const linux = browserCandidates("linux");
    expect(rank(linux, "brave")).toBeLessThan(rank(linux, "google-chrome"));
    expect(rank(linux, "google-chrome")).toBeLessThan(rank(linux, "microsoft-edge"));
});

// Verbatim reg.exe output, captured from a Windows 11 machine: four spaces between columns, CRLF line endings,
// and a value that contains spaces of its own. Transcribing it loosely is how a parser passes its test and fails
// on the only input it will ever see.
test("a reg.exe answer yields its value, spaces and all", () => {
    const query = [
        "",
        "HKEY_CLASSES_ROOT\\MSEdgeHTM\\shell\\open\\command",
        `    (Default)    REG_SZ    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" --single-argument %1`,
        "",
    ].join("\r\n");
    expect(registryValue(query)).toBe(`"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" --single-argument %1`);
    expect(registryValue(["", "HKEY_CURRENT_USER\\…\\UserChoice", "    ProgId    REG_SZ    MSEdgeHTM", ""].join("\r\n"))).toBe("MSEdgeHTM");
    expect(registryValue("ERROR: The system was unable to find the specified registry key or value.")).toBeUndefined();
});

test("the registered open command yields the executable without its arguments", () => {
    expect(executableFromCommand(`"C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe" --single-argument %1`)).toBe(
        "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
    );
    expect(executableFromCommand(`C:\\Windows\\System32\\notepad.exe %1`)).toBe("C:\\Windows\\System32\\notepad.exe");
    expect(executableFromCommand("   ")).toBeUndefined();
});

test("a desktop entry yields its Exec without the field codes the launcher substitutes", () => {
    const entry = ["[Desktop Entry]", "Name=Brave Web Browser", "Exec=/usr/bin/brave-browser-stable %U", "Type=Application"].join("\n");
    expect(executableFromDesktopEntry(entry)).toBe("/usr/bin/brave-browser-stable");
    expect(executableFromDesktopEntry("[Desktop Entry]\nName=No Exec Here")).toBeUndefined();
});

// The case this rule exists for, from a real machine: Windows answers "MSEdgeHTM" for https on a PC whose owner
// installed Brave and lives in it, and the automation profile carries nothing of theirs either way.
test("an installed browser beats the one the OS shipped and claimed the association for", () => {
    const brave = "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe";
    const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
    expect(pickBrowser(edge, [brave, edge])).toBe(brave);
    expect(pickBrowser("/usr/bin/microsoft-edge", ["/usr/bin/brave-browser", "/usr/bin/microsoft-edge"])).toBe("/usr/bin/brave-browser");
    // Edge is all there is: the fallback is still a working browser, not a refusal.
    expect(pickBrowser(edge, [edge])).toBe(edge);
});

// Found on a real machine mid-switch: ~/.intentic/browser held "Last Version 153.0.4234.48" from Edge, and Chromium
// refuses a profile from a build newer than its own — so a shared directory turns "open Brave instead" into a dialog.
test("each browser automates on a profile of its own", () => {
    const brave = profileDir("C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe");
    const edge = profileDir("C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe");
    expect(brave).not.toBe(edge);
    expect(brave.endsWith(join(".intentic", "browser", "brave"))).toBe(true);
    expect(edge.endsWith(join(".intentic", "browser", "msedge"))).toBe(true);
    // The same browser, whichever path it was found at, keeps the profile it signed in on.
    expect(profileDir("/usr/bin/brave-browser")).toBe(profileDir("/snap/bin/brave-browser"));
});

test("a default the owner actually chose is the one that opens", () => {
    const chrome = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
    const brave = "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe";
    // Chrome is the OS's answer while Brave outranks it in the guesses; the answer wins, since it is a choice.
    expect(pickBrowser(chrome, [brave, chrome])).toBe(chrome);
    // No answer at all (a Firefox default, an OS that would not say): the best-ranked install.
    expect(pickBrowser(undefined, [brave, chrome])).toBe(brave);
    expect(pickBrowser(undefined, [])).toBeUndefined();
});

// A default that cannot be driven over CDP is a reason to fall back to the guesses, not to refuse to start.
test("only a Chromium-family binary counts as drivable", () => {
    for (const path of ["/usr/bin/brave-browser", "/usr/bin/microsoft-edge", "C:\\…\\msedge.exe", "/usr/bin/chromium", "/opt/vivaldi/vivaldi"]) {
        expect(isChromiumFamily(path)).toBe(true);
    }
    for (const path of ["/usr/bin/firefox", "/Applications/Safari.app/Contents/MacOS/Safari", "/usr/bin/flatpak"]) {
        expect(isChromiumFamily(path)).toBe(false);
    }
});
