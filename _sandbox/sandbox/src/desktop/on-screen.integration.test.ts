import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { packageRoot } from "@intentic/constants/node";
import { onScreenGuidance } from "./on-screen.js";
import { desktopRouter } from "./desktop-tools.js";
import { z } from "zod";

const SCRIPT = join(packageRoot(import.meta.url), "bin", "on-screen");
const dir = mkdtempSync(join(tmpdir(), "on-screen-test-"));
const socket = join(dir, "wayland-0");
const script = join(dir, "on-screen");
// Exercise the installed script with a real socket in a private fixture; never borrow a live host's screen.
writeFileSync(script, readFileSync(SCRIPT, "utf8").replaceAll("/run/intentic/screen/wayland-0", socket));
let server: Server | undefined;

const screenshotGuidance = async (): Promise<string> => {
    const response = await desktopRouter(socket).handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const { tools } = z.object({ tools: z.array(z.object({ name: z.string(), description: z.string() })) }).parse(response?.result);
    return tools.find((entry) => entry.name === "screenshot")?.description ?? "";
};

afterAll(async () => {
    if (server !== undefined) {
        await new Promise<void>((resolve) => server?.close(() => resolve()));
    }
    rmSync(dir, { recursive: true, force: true });
});

test("the owner's screen guidance is offered only for a socket, and notices when it disappears", async () => {
    expect(onScreenGuidance(socket)).toBe("");
    expect(await screenshotGuidance()).not.toContain("on-screen <command>");
    writeFileSync(socket, "a regular file is not a screen");
    expect(onScreenGuidance(socket)).toBe("");
    rmSync(socket);
    server = createServer();
    await new Promise<void>((resolve) => server?.listen(socket, resolve));
    expect(onScreenGuidance(socket)).toBe(
        " To show an app on the owner's own screen run `on-screen <command>`; you cannot see or screenshot it there, so check it on your own desktop first.",
    );
    expect(await screenshotGuidance()).toContain(onScreenGuidance(socket));
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
    expect(onScreenGuidance(socket)).toBe("");
    expect(await screenshotGuidance()).not.toContain("on-screen <command>");
});

test("a missing mount refuses plainly even when another display was inherited", () => {
    const result = spawnSync("sh", [script, "true"], {
        env: { ...process.env, DISPLAY: ":88", WAYLAND_DISPLAY: "wayland-unrestricted" },
        encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("This sandbox can't show windows on this computer's screen: its screen socket is unavailable.");
});

test("native apps get only Wayland, a private writable runtime, literal arguments and their own exit status", async () => {
    server = createServer();
    await new Promise<void>((resolve) => server?.listen(socket, resolve));
    const result = spawnSync("sh", [script, process.execPath, "-e", `
        const fs = require("node:fs");
        fs.writeFileSync(process.env.XDG_RUNTIME_DIR + "/probe", "writable");
        fs.unlinkSync(process.env.XDG_RUNTIME_DIR + "/probe");
        console.log(JSON.stringify({
            display: process.env.DISPLAY ?? null, inheritedFd: process.env.WAYLAND_SOCKET ?? null,
            wayland: process.env.WAYLAND_DISPLAY, gtk: process.env.GDK_BACKEND, qt: process.env.QT_QPA_PLATFORM,
            sdl: process.env.SDL_VIDEODRIVER, mozilla: process.env.MOZ_ENABLE_WAYLAND,
            electron: process.env.ELECTRON_OZONE_PLATFORM_HINT, runtime: process.env.XDG_RUNTIME_DIR,
            mode: fs.statSync(process.env.XDG_RUNTIME_DIR).mode & 511, args: process.argv.slice(1)
        }));
        process.exit(17);
    `, "argument with spaces", "literal$(command)"], {
        env: { ...process.env, DISPLAY: ":88", WAYLAND_DISPLAY: "unrestricted", WAYLAND_SOCKET: "99" },
        encoding: "utf8",
    });
    expect(result.status).toBe(17);
    const output = JSON.parse(result.stdout);
    expect(output).toEqual({
        display: null, inheritedFd: null, wayland: socket, gtk: "wayland", qt: "wayland", sdl: "wayland", mozilla: "1", electron: "wayland",
        runtime: expect.stringMatching(/^\/tmp\/intentic-on-screen\./), mode: 0o700, args: ["argument with spaces", "literal$(command)"],
    });
    expect(existsSync(output.runtime)).toBe(false);
    const x11 = spawnSync("sh", [script, "--x11", "xterm"], { encoding: "utf8" });
    expect(x11.status).toBe(1);
    expect(x11.stderr).toContain("xwayland-satellite is not packaged for this image's Debian trixie base");
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
});
