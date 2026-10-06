import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDisplaysJson, parseSwayOutputs, parseXrandrMonitors } from "./parse.js";
import { environment, has, run } from "./run.js";
import { DesktopError, type DisplayInfo, type Rect, type ScreenFrame } from "./types.js";
import { WINDOWS_DPI_AWARE } from "./windows-dpi.js";

// Screen capture and geometry across platforms. Capture tries a list of candidate tools in order, since each
// platform's screenshot program varies; a total failure names what to install. PNG goes to a temp file rather than
// a pipe, since several tools only write to a path.

// Unique per call: parallel captures in one millisecond would otherwise share a file that the first to finish deletes.
export const pngPath = (): string => join(tmpdir(), `intentic-desktop-${process.pid}-${Date.now()}-${randomUUID()}.png`);

interface Grabber {
    readonly command: string;
    readonly args: (out: string) => string[];
    readonly install: string;
}

// The virtual desktop, or `region` of it: the region is in screenshot pixels, so the desktop's own top-left (left of
// zero with a monitor left of the primary) is added before copying.
const WINDOWS_CAPTURE = (out: string, region: Rect | undefined): string =>
    [
        WINDOWS_DPI_AWARE,
        "Add-Type -AssemblyName System.Windows.Forms,System.Drawing;",
        "$b = [System.Windows.Forms.SystemInformation]::VirtualScreen;",
        region === undefined
            ? "$x = $b.Left; $y = $b.Top; $w = $b.Width; $h = $b.Height;"
            : `$x = $b.Left + ${Math.round(region.x)}; $y = $b.Top + ${Math.round(region.y)}; $w = ${Math.round(region.width)}; $h = ${Math.round(region.height)};`,
        "$bmp = New-Object System.Drawing.Bitmap $w, $h;",
        "$g = [System.Drawing.Graphics]::FromImage($bmp);",
        "$g.CopyFromScreen($x, $y, 0, 0, $bmp.Size);",
        `$bmp.Save('${out}', [System.Drawing.Imaging.ImageFormat]::Png);`,
        "$g.Dispose(); $bmp.Dispose();",
    ].join(" ");

export const isWayland = (): boolean => environment()["XDG_SESSION_TYPE"] === "wayland" || environment()["WAYLAND_DISPLAY"] !== undefined;

const grabbers = (out: string, region?: Rect): Grabber[] => {
    if (process.platform === "win32") {
        return [{ command: "powershell.exe", args: () => ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_CAPTURE(out, region)], install: "" }];
    }
    // Wayland tools first when the session is Wayland; an X11 tool captures a black or empty frame under it.
    const waylandTools: Grabber[] = [
        { command: "grim", args: (path) => [path], install: "sudo apt install grim  (or your distro's package)" },
        { command: "gnome-screenshot", args: (path) => ["-f", path], install: "sudo apt install gnome-screenshot" },
        { command: "spectacle", args: (path) => ["-b", "-n", "-o", path], install: "sudo apt install kde-spectacle" },
    ];
    const x11Tools: Grabber[] = [
        { command: "import", args: (path) => ["-window", "root", path], install: "sudo apt install imagemagick" },
        { command: "scrot", args: (path) => [path], install: "sudo apt install scrot" },
        // One frame of x11grab: what a machine with ffmpeg and no screenshot program has (the sandbox's own displays,
        // where ffmpeg is already there to stream them). No cursor, like the others.
        {
            command: "ffmpeg",
            args: (path) => ["-loglevel", "error", "-f", "x11grab", "-draw_mouse", "0", "-i", environment()["DISPLAY"] ?? ":0", "-frames:v", "1", "-y", path],
            install: "sudo apt install ffmpeg",
        },
        { command: "gnome-screenshot", args: (path) => ["-f", path], install: "sudo apt install gnome-screenshot" },
    ];
    return isWayland() ? [...waylandTools, ...x11Tools] : [...x11Tools, ...waylandTools];
};

// A grabber that is not installed, as `attempt` says it; every other failure is carried as what the tool said.
const MISSING = "missing";

// Undefined once the tool exited cleanly; otherwise MISSING, or the tail of what it said on the way out.
const attempt = (command: string, args: readonly string[]): Promise<string | undefined> =>
    new Promise((resolvePromise) => {
        const child = spawn(command, [...args], { windowsHide: true, env: environment() });
        let said = "";
        child.stderr?.on("data", (chunk: Buffer) => {
            said += chunk.toString();
        });
        child.on("error", (error: NodeJS.ErrnoException) => resolvePromise(error.code === "ENOENT" ? MISSING : error.message));
        child.on("close", (code) => resolvePromise(code === 0 ? undefined : said.trim() === "" ? `exited with code ${code}` : said.trim().slice(-300)));
    });

export const hasGraphicalSession = (): boolean =>
    process.platform === "win32" || environment()["DISPLAY"] !== undefined || environment()["WAYLAND_DISPLAY"] !== undefined;

// Only Windows cuts `region` out while capturing; the Linux tools hand back the whole screen, which the caller cuts.
export const capture = async (region?: Rect): Promise<Buffer> => {
    if (!hasGraphicalSession()) {
        throw new DesktopError("This device has no graphical session right now (no DISPLAY or WAYLAND_DISPLAY), so there is no screen.");
    }
    const out = pngPath();
    // An installed tool that failed is reported as itself: the install hint below is only for a device that has none.
    const failures: string[] = [];
    try {
        for (const grabber of grabbers(out, region)) {
            const failed = await attempt(grabber.command, grabber.args(out));
            if (failed === MISSING) {
                continue;
            }
            if (failed !== undefined) {
                failures.push(`${grabber.command}: ${failed}`);
                continue;
            }
            // allow(silent-catch): a grabber that wrote nothing is reported just below, with the others, in its own words
            const png = await readFile(out).catch(() => undefined);
            if (png !== undefined && png.length > 0) {
                return png;
            }
            failures.push(`${grabber.command}: exited cleanly without writing an image`);
        }
        if (failures.length > 0) {
            throw new DesktopError(`Could not capture the screen. ${failures.join("; ")}`);
        }
        const installs = grabbers(out)
            .map((grabber) => grabber.install)
            .filter((install) => install !== "");
        throw new DesktopError(
            installs.length === 0 ? "Could not capture the screen." : "No screenshot tool on this device.",
            installs.length === 0 ? undefined : installs.join(", or — "),
        );
    } finally {
        // allow(silent-catch): removing the scratch file is tidying; the capture has already answered or thrown
        await rm(out, { force: true }).catch(() => undefined);
    }
};

// Reads width/height from the PNG IHDR at fixed offsets: the fallback when the OS cannot report geometry (Wayland
// hides it from unprivileged clients).
export const pngSize = (png: Buffer): { width: number; height: number } => {
    if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47) {
        throw new DesktopError("That is not a PNG, so its size cannot be read.");
    }
    return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
};

const WINDOWS_FRAME =
    `${WINDOWS_DPI_AWARE 
    }Add-Type -AssemblyName System.Windows.Forms; ` +
    `$b = [System.Windows.Forms.SystemInformation]::VirtualScreen; ` +
    `Write-Output "$($b.Width) $($b.Height) $($b.Left) $($b.Top)"`;

export const frame = async (): Promise<ScreenFrame> => {
    if (process.platform === "win32") {
        // The virtual desktop, same as CopyFromScreen; left edge can be negative for a monitor left of primary.
        const out = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_FRAME]);
        const [width, height, left, top] = out.trim().split(/\s+/).map(Number);
        if (width === undefined || height === undefined || Number.isNaN(width) || Number.isNaN(height)) {
            throw new DesktopError("Could not read this device's screen size.");
        }
        return { width, height, origin: { x: left ?? 0, y: top ?? 0 } };
    }
    if (!isWayland()) {
        // X11 answers directly, faster than a screenshot.
        const out = await run("xdotool", ["getdisplaygeometry"], "sudo apt install xdotool");
        const [width, height] = out.trim().split(/\s+/).map(Number);
        if (width !== undefined && height !== undefined && !Number.isNaN(width) && !Number.isNaN(height)) {
            return { width, height, origin: { x: 0, y: 0 } };
        }
    }
    // Wayland, or X11 with a bad xdotool answer: the screenshot is the only honest source.
    return { ...pngSize(await capture()), origin: { x: 0, y: 0 } };
};

// Each monitor's bounds relative to the virtual desktop's top-left, so they share the screenshot's pixels.
const WINDOWS_DISPLAYS =
    `${WINDOWS_DPI_AWARE 
    }Add-Type -AssemblyName System.Windows.Forms; ` +
    `$v = [System.Windows.Forms.SystemInformation]::VirtualScreen; ` +
    `$list = @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object { [pscustomobject]@{ name = $_.DeviceName; primary = $_.Primary; ` +
    `x = $_.Bounds.X - $v.Left; y = $_.Bounds.Y - $v.Top; width = $_.Bounds.Width; height = $_.Bounds.Height } }); ` +
    `ConvertTo-Json -Compress -Depth 3 -InputObject $list`;

// The whole frame as one display: what a desktop that will not list its monitors is taken to have.
const single = async (): Promise<DisplayInfo[]> => {
    const { width, height } = await frame();
    return [{ name: "screen", primary: true, bounds: { x: 0, y: 0, width, height } }];
};

const primaryFirst = (displays: DisplayInfo[]): DisplayInfo[] => displays.toSorted((a, b) => Number(b.primary) - Number(a.primary));

export const displays = async (): Promise<DisplayInfo[]> => {
    if (process.platform === "win32") {
        const listed = parseDisplaysJson((await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_DISPLAYS])).trim());
        return listed.length === 0 ? await single() : primaryFirst(listed);
    }
    if (process.platform !== "linux") {
        return await single();
    }
    const swaySocket = environment()["SWAYSOCK"] ?? environment()["I3SOCK"];
    if (isWayland() && swaySocket !== undefined && (await has("swaymsg"))) {
        const listed = parseSwayOutputs(await run("swaymsg", ["-t", "get_outputs"]));
        return listed.length === 0 ? await single() : primaryFirst(listed);
    }
    if (!isWayland() && (await has("xrandr"))) {
        // allow(silent-catch): monitors xrandr cannot list fall back to the one screen single() reads
        const listed = parseXrandrMonitors(await run("xrandr", ["--listactivemonitors"]).catch(() => ""));
        return listed.length === 0 ? await single() : primaryFirst(listed);
    }
    return await single();
};
