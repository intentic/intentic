import { windowsChord } from "./keys.js";
import { run } from "./run.js";
import type { MouseButton, Point, ScrollDirection } from "./types.js";

/* Windows input, through PowerShell into user32.dll. PowerShell is on every Windows and can P/Invoke, which is
 * the whole trick.
 *
 * WHY NOT nut.js, which does this properly in C, this was tried, not assumed. `bun build --compile` DOES embed
 * `.node` addons, and the cross-compile worked: bun bundled all three of libnut's platform packages and produced
 * both a Linux and a Windows binary. The binary then cannot load the addon at all. libnut finds its `.node`
 * through the `bindings` package, which walks up from __dirname looking for a package.json, and inside a
 * standalone binary __dirname is `/$bunfs/root/…`, a virtual filesystem with no package.json, so it throws
 * "Could not find module root" before it ever opens the addon. That is inside libnut's own index.js, so there is
 * nothing to configure around it.
 *
 * Three more findings from the same test, any one of which would also have decided it: the Linux prebuild is
 * x86-64 ONLY, so the linux-arm64 target would have no binary at all; libnut also needs libXtst.so.6 present on
 * the machine, an unstated system dependency (at least `xdotool` announces itself with an install line); and the
 * compiled artifact went from single-digit MB to 92MB.
 *
 * So this is not "we preferred to hand-roll". nut.js is a fine library for a normally-installed Node app and
 * cannot survive being compiled into one file, which is how this agent ships. Revisit only if that changes.
 *
 * ONE `Add-Type` per call is the cost. It compiles a few lines of C# in-process (~150ms), which is invisible next
 * to the round trip that delivered the request and irrelevant against a human-speed UI, and it buys a backend
 * with no install step, no service, and nothing left running on the user's machine between actions.
 *
 * Mouse goes through SetCursorPos + mouse_event, keys through keybd_event, and only TEXT goes through SendKeys.
 * The split is not arbitrary: SendKeys is the only one of the three that handles arbitrary unicode text sensibly,
 * and the only one that cannot press the Windows key, so text uses it and chords do not. */

const SHIM = `
Add-Type -Namespace IntenticDesktop -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
[DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, System.IntPtr dwExtraInfo);
[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, System.IntPtr dwExtraInfo);
'@;
`;

// user32 mouse_event flags. Absolute positioning is not used: SetCursorPos already put the pointer where it
// belongs, and mouse_event's absolute mode wants 0–65535 normalised coordinates that multi-monitor setups make
// its own kind of wrong.
const DOWN: Record<MouseButton, number> = { left: 0x0002, right: 0x0008, middle: 0x0020 };
const UP: Record<MouseButton, number> = { left: 0x0004, right: 0x0010, middle: 0x0040 };
const WHEEL = 0x0800;
const HWHEEL = 0x01000;
const KEYUP = 0x0002;
// One wheel notch, as Windows counts them.
const WHEEL_DELTA = 120;

const powershell = async (script: string): Promise<void> => {
    await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `${SHIM}${script}`]);
};

// Screenshot pixels are relative to the virtual desktop's top-left; the pointer API wants the OS's own
// coordinates. Adding the origin back is what makes a click land on the right monitor.
const absolute = (at: Point, origin: Point): Point => ({ x: Math.round(at.x + origin.x), y: Math.round(at.y + origin.y) });

const moveScript = (at: Point, origin: Point): string => {
    const { x, y } = absolute(at, origin);
    return `[IntenticDesktop.Native]::SetCursorPos(${x}, ${y}) | Out-Null;`;
};

const clickScript = (button: MouseButton): string =>
    `[IntenticDesktop.Native]::mouse_event(${DOWN[button]}, 0, 0, 0, [System.IntPtr]::Zero); ` +
    `Start-Sleep -Milliseconds 20; ` +
    `[IntenticDesktop.Native]::mouse_event(${UP[button]}, 0, 0, 0, [System.IntPtr]::Zero);`;

/* SendKeys reads these as syntax, so a literal one has to be wrapped in braces, a password containing `+` or a
 * path containing `(` would otherwise be typed as a modifier or a group. */
const escapeText = (text: string): string => text.replace(/[+^%~(){}[\]]/g, (character) => `{${character}}`);

export const windowsInput = {
    move: async (to: Point, origin: Point): Promise<void> => await powershell(moveScript(to, origin)),

    click: async (at: Point, button: MouseButton, origin: Point): Promise<void> =>
        await powershell(`${moveScript(at, origin)} Start-Sleep -Milliseconds 20; ${clickScript(button)}`),

    doubleClick: async (at: Point, origin: Point): Promise<void> =>
        await powershell(
            `${moveScript(at, origin)} Start-Sleep -Milliseconds 20; ${clickScript("left")} Start-Sleep -Milliseconds 40; ${clickScript("left")}`,
        ),

    // Press, move, release, with the pointer settling between each, because a drag delivered as three
    // instantaneous events is one many applications never see as a drag at all.
    drag: async (from: Point, to: Point, origin: Point): Promise<void> =>
        await powershell(
            [
                moveScript(from, origin),
                "Start-Sleep -Milliseconds 40;",
                `[IntenticDesktop.Native]::mouse_event(${DOWN.left}, 0, 0, 0, [System.IntPtr]::Zero);`,
                "Start-Sleep -Milliseconds 60;",
                moveScript(to, origin),
                "Start-Sleep -Milliseconds 60;",
                `[IntenticDesktop.Native]::mouse_event(${UP.left}, 0, 0, 0, [System.IntPtr]::Zero);`,
            ].join(" "),
        ),

    type: async (text: string): Promise<void> => {
        // Newlines are Enter, not a literal character SendKeys would drop.
        const parts = text.split(/\r?\n/);
        const script = parts
            .map((part, index) => {
                const send = part === "" ? "" : `[System.Windows.Forms.SendKeys]::SendWait('${escapeText(part).replace(/'/g, "''")}');`;
                return index < parts.length - 1 ? `${send} [System.Windows.Forms.SendKeys]::SendWait('{ENTER}');` : send;
            })
            .join(" ");
        await powershell(`Add-Type -AssemblyName System.Windows.Forms; ${script}`);
    },

    key: async (combo: string): Promise<void> => {
        const chord = windowsChord(combo);
        const press = (code: number, up: boolean): string =>
            `[IntenticDesktop.Native]::keybd_event(${code}, 0, ${up ? KEYUP : 0}, [System.IntPtr]::Zero);`;
        // Modifiers down, key, modifiers up in reverse, the order a real keyboard produces, and the one
        // applications watching for chords expect.
        await powershell(
            [
                ...chord.modifiers.map((code) => press(code, false)),
                press(chord.key, false),
                "Start-Sleep -Milliseconds 20;",
                press(chord.key, true),
                ...chord.modifiers.toReversed().map((code) => press(code, true)),
            ].join(" "),
        );
    },

    scroll: async (at: Point, direction: ScrollDirection, amount: number, origin: Point): Promise<void> => {
        const horizontal = direction === "left" || direction === "right";
        const sign = direction === "down" || direction === "left" ? -1 : 1;
        const delta = sign * WHEEL_DELTA * Math.max(1, Math.round(amount));
        await powershell(
            `${moveScript(at, origin)} [IntenticDesktop.Native]::mouse_event(${horizontal ? HWHEEL : WHEEL}, 0, 0, ${delta}, [System.IntPtr]::Zero);`,
        );
    },
};
