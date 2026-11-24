import { diffContent, pathUnder, toolCard, toolLocations } from "./tool-cards.js";

// The parts of a tool card a computer's turns and the daemon's build alike. The daemon's own suites cover the rest
// through its names for them (sandbox sessions/vocabulary/tool-calls.test.ts, runtimes/decorators/vendor-events.test.ts).

test("a path under the turn's folder is read relative to it, and one outside it is not read at all", () => {
    expect(pathUnder("/home/ada/shop/src/app.ts", "/home/ada/shop")).toBe("src/app.ts");
    expect(pathUnder("src/app.ts", "/home/ada/shop")).toBe("src/app.ts");
    expect(pathUnder("/home/ada/other/app.ts", "/home/ada/shop")).toBeUndefined();
    expect(pathUnder("../other/app.ts", "/home/ada/shop")).toBeUndefined();
    // The folder itself names no file in it.
    expect(pathUnder("/home/ada/shop", "/home/ada/shop")).toBeUndefined();
});

test("a Windows folder reads drive letters and backslashes as Windows does, whatever machine reads it", () => {
    expect(pathUnder(String.raw`C:\Users\ada\shop\src\app.ts`, String.raw`C:\Users\ada\shop`)).toBe("src/app.ts");
    expect(pathUnder(String.raw`c:\users\ada\shop\src\app.ts`, String.raw`C:\Users\ada\shop`)).toBe("src/app.ts");
    expect(pathUnder(String.raw`src\app.ts`, String.raw`C:\Users\ada\shop`)).toBe("src/app.ts");
    expect(pathUnder(String.raw`C:\Users\ada\other\app.ts`, String.raw`C:\Users\ada\shop`)).toBeUndefined();
    // Another drive leaves no path relative to the folder.
    expect(pathUnder(String.raw`D:\work\app.ts`, String.raw`C:\Users\ada\shop`)).toBeUndefined();
    expect(pathUnder(String.raw`\\wsl.localhost\arch\home\ada\shop\app.ts`, String.raw`\\wsl.localhost\arch\home\ada\shop`)).toBe("app.ts");
});

test("a folder inside a WSL distro is POSIX, and a backslash in a name there stays part of the name", () => {
    expect(pathUnder(String.raw`/home/ada/shop/odd\name.txt`, "/home/ada/shop")).toBe(String.raw`odd\name.txt`);
});

test("a call's files are read by the caller's own reading where it names one", () => {
    const state = (raw: string): string | undefined => (raw.startsWith("~/") ? raw.slice(2) : undefined);
    expect(toolLocations({ file_path: "~/notes/plan.md", offset: 12 }, "/home/ada/shop", state)).toEqual([{ path: "notes/plan.md", line: 12 }]);
    expect(toolLocations({ file_path: "/home/ada/shop/a.ts" }, "/home/ada/shop", state)).toBeUndefined();
    expect(toolLocations({ path: "/home/ada/shop/a.ts", offset: 0 }, "/home/ada/shop")).toEqual([{ path: "a.ts" }]);
    expect(toolLocations("ls", "/home/ada/shop")).toBeUndefined();
    expect(toolLocations({ command: "ls" }, "/home/ada/shop")).toBeUndefined();
});

test("a card names the files its input does only against a folder, read the folder's way", () => {
    const card = toolCard({ id: "t1", name: "Read", input: { file_path: String.raw`C:\shop\src\app.ts`, offset: 3 }, cwd: String.raw`C:\shop` });
    expect(card).toMatchObject({ kind: "tool_call", id: "t1", category: "read", status: "in_progress", locations: [{ path: "src/app.ts", line: 3 }] });
    expect(toolCard({ id: "t2", name: "Read", input: { file_path: "/shop/src/app.ts" } }).locations).toBeUndefined();
    const own = toolCard({ id: "t3", name: "Read", input: { file_path: "/elsewhere/app.ts" }, cwd: "/shop", pathOf: () => "linked/app.ts" });
    expect(own.locations).toEqual([{ path: "linked/app.ts" }]);
});

test("a diff keeps both sides, an absent old side stays absent, and an oversized side is cut and said to be", () => {
    expect(diffContent("a.ts", "old", "new")).toEqual({ type: "diff", path: "a.ts", oldText: "old", newText: "new" });
    expect(diffContent("a.ts", undefined, "new")).toEqual({ type: "diff", path: "a.ts", newText: "new" });
    const cut = diffContent("a.ts", undefined, "x".repeat(40_000));
    expect(cut).toMatchObject({ type: "diff", truncated: true });
    expect(cut.type === "diff" ? cut.newText.length : 0).toBe(32_000);
});
