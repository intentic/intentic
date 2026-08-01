import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostScopes } from "@intentic/sandbox-contract";
import { assertScope } from "../policy.js";

/* A screenshot of the user's actual desktop — the tool that answers questions no command can ("what does this
 * dialog say", "is the build still running in that window").
 *
 * Every platform does this with a DIFFERENT program that may or may not be installed, so this is a list of
 * candidates tried in order rather than one command. Windows is the exception and the easy case: .NET is always
 * there, so a few lines of PowerShell always work. Linux is the hard case — the right tool depends on whether
 * the session is Wayland or X11, and on which desktop shipped which utility — so the failure message names the
 * one-line install for what is missing instead of just reporting that nothing worked.
 *
 * PNG via a temp file rather than a pipe: several of these tools only write to a path, and a base64 payload of a
 * 4K screen is large enough that streaming it through stdout buffers is not worth the saving. */

const PNG_PATH = (): string => join(tmpdir(), `intentic-host-${process.pid}-${Date.now()}.png`);

// One candidate: the program, its argv given a destination path, and what to tell the user to install when
// none of them is present.
interface Grabber {
    readonly command: string;
    readonly args: (out: string) => string[];
    readonly install: string;
}

const WINDOWS_SCRIPT = (out: string): string =>
    [
        "Add-Type -AssemblyName System.Windows.Forms,System.Drawing;",
        "$b = [System.Windows.Forms.SystemInformation]::VirtualScreen;",
        "$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height;",
        "$g = [System.Drawing.Graphics]::FromImage($bmp);",
        "$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size);",
        `$bmp.Save('${out}', [System.Drawing.Imaging.ImageFormat]::Png);`,
        "$g.Dispose(); $bmp.Dispose();",
    ].join(" ");

const grabbers = (out: string): Grabber[] => {
    if (process.platform === "win32") {
        return [
            {
                command: "powershell.exe",
                args: () => ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_SCRIPT(out)],
                install: "",
            },
        ];
    }
    // Wayland first when the session says Wayland: grim is the standard there and an X11 tool would capture a
    // black frame (or nothing) under it.
    const wayland = process.env["XDG_SESSION_TYPE"] === "wayland" || process.env["WAYLAND_DISPLAY"] !== undefined;
    const waylandTools: Grabber[] = [
        { command: "grim", args: (path) => [path], install: "sudo apt install grim  (or your distro's package)" },
        {
            command: "gnome-screenshot",
            args: (path) => ["-f", path],
            install: "sudo apt install gnome-screenshot",
        },
        { command: "spectacle", args: (path) => ["-b", "-n", "-o", path], install: "sudo apt install kde-spectacle" },
    ];
    const x11Tools: Grabber[] = [
        { command: "import", args: (path) => ["-window", "root", path], install: "sudo apt install imagemagick" },
        { command: "scrot", args: (path) => [path], install: "sudo apt install scrot" },
        { command: "gnome-screenshot", args: (path) => ["-f", path], install: "sudo apt install gnome-screenshot" },
    ];
    return wayland ? [...waylandTools, ...x11Tools] : [...x11Tools, ...waylandTools];
};

const run = (command: string, args: readonly string[]): Promise<boolean> =>
    new Promise((resolvePromise) => {
        const child = spawn(command, args, { windowsHide: true });
        child.on("error", () => resolvePromise(false));
        child.on("close", (code) => resolvePromise(code === 0));
    });

// The PNG as base64, ready to become an MCP image content block. Throws with an actionable message when the
// screen cannot be captured — which on Linux usually means one apt-get away, and on a headless box means the
// honest answer that there is no screen.
export const captureScreen = async (scopes: HostScopes): Promise<string> => {
    assertScope(scopes, "screen");
    if (process.platform === "linux" && process.env["DISPLAY"] === undefined && process.env["WAYLAND_DISPLAY"] === undefined) {
        throw new Error("This computer has no graphical session right now (no DISPLAY or WAYLAND_DISPLAY), so there is no screen to capture.");
    }
    const out = PNG_PATH();
    try {
        for (const grabber of grabbers(out)) {
            if (!(await run(grabber.command, grabber.args(out)))) {
                continue;
            }
            const png = await readFile(out).catch(() => undefined);
            if (png !== undefined && png.length > 0) {
                return png.toString("base64");
            }
        }
        const installs = grabbers(out)
            .map((grabber) => grabber.install)
            .filter((install) => install !== "");
        throw new Error(
            installs.length === 0
                ? "Could not capture the screen."
                : `No screenshot tool on this computer. Ask the user to install one: ${installs.join(" — or — ")}.`,
        );
    } finally {
        await rm(out, { force: true }).catch(() => undefined);
    }
};
