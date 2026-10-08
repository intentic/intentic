import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CuaClient, cuaDesktop, cuaDriverCandidates, cuaKey, parseCuaElements, parseCuaWindows } from "./cua.js";
import { DesktopError } from "./types.js";

/* cua-driver as a Desktop: what its answers become, and the stdio client against a stand-in driver that speaks just
   enough MCP. The shapes are cua-driver 0.33.4's, read off a live run under Xvfb. */

// A tool result carrying only structured content, as list_windows and get_window_state answer.
const answered = (structuredContent: unknown) => ({ content: [], structuredContent, isError: false });

test("keys are spelled the driver's way, modifiers kept", () => {
    expect(cuaKey("ctrl+shift+Page_Up")).toEqual({ key: "pageup", modifiers: ["ctrl", "shift"] });
    expect(cuaKey("Return")).toEqual({ key: "return", modifiers: [] });
    expect(cuaKey("alt+F4")).toEqual({ key: "f4", modifiers: ["alt"] });
    expect(cuaKey("cmd+c")).toEqual({ key: "c", modifiers: ["super"] });
});

test("windows carry pid and window id together, and off-screen ones are left out", () => {
    const listed = parseCuaWindows(
        answered({
            windows: [
            { app_name: "Xmessage", bounds: { x: 565, y: 389, width: 150, height: 68 }, pid: 1813321, title: "xmessage", window_id: 4194341, z_index: 0 },
            { app_name: "Hidden", bounds: { x: 0, y: 0, width: 10, height: 10 }, pid: 7, title: "h", window_id: 8, is_on_screen: false },
                { app_name: "No pid", window_id: 9 },
            ],
        }),
    );
    expect(listed).toEqual([
        { id: "1813321:4194341", title: "xmessage", app: "Xmessage", bounds: { x: 565, y: 389, width: 150, height: 68 }, focused: true, pid: 1813321 },
    ]);
});

test("elements keep the driver's desktop frames, and offer what their accessibility actions allow", () => {
    const window = { x: 485, y: 285, width: 310, height: 230 };
    const { elements } = parseCuaElements(
        answered({
            elements: [
                { element_token: "s0000002a:3", role: "push button", label: "OK", actions: ["click"], frame: { x: 600, y: 470, w: 80, h: 30 }, depth: 2 },
                { element_token: "s0000002a:4", role: "text", label: "Name", value: "draft", screenshot_frame: { x: 10, y: 60, w: 200, h: 24 }, depth: 2 },
                { element_token: "s0000002a:5", role: "check box", label: "Wrap", actions: ["toggle"], enabled: false, depth: 2 },
                { role: "filler", label: "no token" },
            ],
        }),
        window,
    );
    expect(elements.map((element) => [element.id, element.role, element.actions, element.bounds])).toEqual([
        ["s0000002a:3", "push button", ["invoke"], { x: 600, y: 470, width: 80, height: 30 }],
        // Only a window-local frame: moved by the window's origin.
        ["s0000002a:4", "text", ["set_value"], { x: 495, y: 345, width: 200, height: 24 }],
        ["s0000002a:5", "check box", ["toggle"], { x: 0, y: 0, width: 0, height: 0 }],
    ]);
    expect(elements[1]?.value).toBe("draft");
    expect(elements[2]?.enabled).toBe(false);
});

test("a child GTK 4 places at its window's own origin has no known place, rather than a corner to click", () => {
    // zenity 4.1's question dialog under cua-driver 0.33.4: both buttons reported at the dialog's top-left.
    const window = { x: 485, y: 285, width: 310, height: 230 };
    const {
        elements: [dialog, no],
    } = parseCuaElements(
        answered({
            elements: [
                { element_token: "s00000001:0", role: "dialog", label: "Question", actions: ["default.activate"], frame: { x: 485, y: 285, w: 310, h: 230 }, depth: 0 },
                { element_token: "s00000001:1", role: "button", label: "No", actions: ["click"], frame: { x: 485, y: 285, w: 120, h: 44 }, depth: 4 },
            ],
        }),
        window,
    );
    expect(dialog?.bounds).toEqual(window);
    expect(no?.bounds).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(no?.actions).toEqual(["invoke"]);
});

test("the driver is looked for where it was named, on PATH, then where its installers put it", () => {
    const candidates = cuaDriverCandidates({ INTENTIC_CUA_DRIVER: "/opt/cua", PATH: "/usr/bin:/bin" }, "/home/me");
    expect(candidates[0]).toBe("/opt/cua");
    expect(candidates).toContain(join("/usr/bin", process.platform === "win32" ? "cua-driver.exe" : "cua-driver"));
    expect(candidates).toContain(join("/home/me", ".local", "bin", "cua-driver"));
});

// A stand-in driver: answers initialize, start_session, and a few tools, recording every call it was sent.
const fakeDriver = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "fake-cua-"));
    const path = join(dir, "cua-driver");
    await writeFile(
        path,
        `#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const answer = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
rl.on("line", (line) => {
    const message = JSON.parse(line);
    if (message.id === undefined) return;
    if (message.method === "initialize") return answer(message.id, { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fake" } });
    const { name, arguments: args } = message.params;
    if (name === "start_session") return answer(message.id, { content: [{ type: "text", text: "active " + args.session }] });
    if (name === "get_screen_size") return answer(message.id, { structuredContent: { width: 640, height: 400, scale_factor: 2 } });
    if (name === "get_desktop_state") return answer(message.id, { content: [{ type: "image", data: png, mimeType: "image/png" }] });
    if (name === "click") return answer(message.id, { content: [{ type: "text", text: "clicked " + JSON.stringify(args) }] });
    if (name === "type_text") return answer(message.id, { isError: true, content: [{ type: "text", text: "no focused window" }] });
    answer(message.id, { content: [] });
});
`,
    );
    await chmod(path, 0o755);
    return path;
};

test.skipIf(process.platform === "win32")("the client starts a session once, reads the desktop in its pixels, and throws a driver's error in its words", async () => {
    const client = new CuaClient(await fakeDriver(), process.env);
    try {
        const screen = cuaDesktop(client);
        // Points times the backing scale: the screenshot's own pixels.
        expect(await screen.frame()).toEqual({ width: 1280, height: 800, origin: { x: 0, y: 0 } });
        expect((await screen.capture()).subarray(1, 4).toString()).toBe("PNG");
        await screen.click({ x: 10.4, y: 20.6 }, "right");
        await expect(screen.type("hello")).rejects.toThrow(new DesktopError("cua-driver type_text: no focused window"));
    } finally {
        client.stop();
    }
});
