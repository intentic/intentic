import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./run.js";
import { DesktopError, type ScreenFrame } from "./types.js";

/* Seeing the screen, and knowing how big it is.
 *
 * Every platform does this with a DIFFERENT program that may or may not be installed, so capture is a list of
 * candidates tried in order rather than one command. Windows is the easy case: .NET is always there, so a few
 * lines of PowerShell always work. Linux is the hard one, the right tool depends on whether the session is
 * Wayland or X11 and on which desktop shipped which utility, so a total failure names the one-line install for
 * what is missing instead of reporting that nothing worked.
 *
 * PNG via a temp file rather than a pipe: several of these tools only write to a path, and a base64 payload of a
 * 4K screen is large enough that streaming it through stdout buffers is not worth the saving. */

const pngPath = (): string => join(tmpdir(), `intentic-desktop-${process.pid}-${Date.now()}.png`);

interface Grabber {
    readonly command: string;
    readonly args: (out: string) => string[];
    readonly install: string;
}

const WINDOWS_CAPTURE = (out: string): string =>
    [
        "Add-Type -AssemblyName System.Windows.Forms,System.Drawing;",
        "$b = [System.Windows.Forms.SystemInformation]::VirtualScreen;",
        "$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height;",
        "$g = [System.Drawing.Graphics]::FromImage($bmp);",
        "$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size);",
        `$bmp.Save('${out}', [System.Drawing.Imaging.ImageFormat]::Png);`,
        "$g.Dispose(); $bmp.Dispose();",
    ].join(" ");

export const isWayland = (): boolean => process.env["XDG_SESSION_TYPE"] === "wayland" || process.env["WAYLAND_DISPLAY"] !== undefined;

const grabbers = (out: string): Grabber[] => {
    if (process.platform === "win32") {
        return [{ command: "powershell.exe", args: () => ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_CAPTURE(out)], install: "" }];
    }
    // Wayland first when the session says Wayland: grim is the standard there and an X11 tool would capture a
    // black frame (or nothing) under it.
    const waylandTools: Grabber[] = [
        { command: "grim", args: (path) => [path], install: "sudo apt install grim  (or your distro's package)" },
        { command: "gnome-screenshot", args: (path) => ["-f", path], install: "sudo apt install gnome-screenshot" },
        { command: "spectacle", args: (path) => ["-b", "-n", "-o", path], install: "sudo apt install kde-spectacle" },
    ];
    const x11Tools: Grabber[] = [
        { command: "import", args: (path) => ["-window", "root", path], install: "sudo apt install imagemagick" },
        { command: "scrot", args: (path) => [path], install: "sudo apt install scrot" },
        { command: "gnome-screenshot", args: (path) => ["-f", path], install: "sudo apt install gnome-screenshot" },
    ];
    return isWayland() ? [...waylandTools, ...x11Tools] : [...x11Tools, ...waylandTools];
};

const attempt = (command: string, args: readonly string[]): Promise<boolean> =>
    new Promise((resolvePromise) => {
        const child = spawn(command, [...args], { windowsHide: true });
        child.on("error", () => resolvePromise(false));
        child.on("close", (code) => resolvePromise(code === 0));
    });

export const hasGraphicalSession = (): boolean =>
    process.platform === "win32" || process.env["DISPLAY"] !== undefined || process.env["WAYLAND_DISPLAY"] !== undefined;

export const capture = async (): Promise<Buffer> => {
    if (!hasGraphicalSession()) {
        throw new DesktopError("This computer has no graphical session right now (no DISPLAY or WAYLAND_DISPLAY), so there is no screen.");
    }
    const out = pngPath();
    try {
        for (const grabber of grabbers(out)) {
            if (!(await attempt(grabber.command, grabber.args(out)))) {
                continue;
            }
            const png = await readFile(out).catch(() => undefined);
            if (png !== undefined && png.length > 0) {
                return png;
            }
        }
        const installs = grabbers(out)
            .map((grabber) => grabber.install)
            .filter((install) => install !== "");
        throw new DesktopError(
            installs.length === 0 ? "Could not capture the screen." : "No screenshot tool on this computer.",
            installs.length === 0 ? undefined : installs.join(", or — "),
        );
    } finally {
        await rm(out, { force: true }).catch(() => undefined);
    }
};

/* A PNG's own dimensions, read from its IHDR, the header is fixed-layout, so this is two big-endian reads at
 * known offsets rather than a decoder. It is the fallback for the one case with no cheap way to ask the OS
 * (Wayland deliberately hides screen geometry from unprivileged clients), and it has the property the others
 * lack: it describes exactly the image the caller is looking at, which is the frame its coordinates are in. */
export const pngSize = (png: Buffer): { width: number; height: number } => {
    if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47) {
        throw new DesktopError("That is not a PNG, so its size cannot be read.");
    }
    return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
};

const WINDOWS_FRAME =
    "Add-Type -AssemblyName System.Windows.Forms; " +
    "$b = [System.Windows.Forms.SystemInformation]::VirtualScreen; " +
    'Write-Output "$($b.Width) $($b.Height) $($b.Left) $($b.Top)"';

export const frame = async (): Promise<ScreenFrame> => {
    if (process.platform === "win32") {
        // Windows answers with the VIRTUAL desktop, which is what CopyFromScreen captured, including a negative
        // left edge when a second monitor sits to the left of the primary one.
        const out = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_FRAME]);
        const [width, height, left, top] = out.trim().split(/\s+/).map(Number);
        if (width === undefined || height === undefined || Number.isNaN(width) || Number.isNaN(height)) {
            throw new DesktopError("Could not read this computer's screen size.");
        }
        return { width, height, origin: { x: left ?? 0, y: top ?? 0 } };
    }
    if (!isWayland()) {
        // X11 will simply tell us, and far faster than a screenshot would.
        const out = await run("xdotool", ["getdisplaygeometry"], "sudo apt install xdotool");
        const [width, height] = out.trim().split(/\s+/).map(Number);
        if (width !== undefined && height !== undefined && !Number.isNaN(width) && !Number.isNaN(height)) {
            return { width, height, origin: { x: 0, y: 0 } };
        }
    }
    // Wayland (and an X11 session whose xdotool answered oddly): the screenshot is the only honest source.
    return { ...pngSize(await capture()), origin: { x: 0, y: 0 } };
};
