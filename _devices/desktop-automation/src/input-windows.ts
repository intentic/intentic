import { windowsChord } from "./keys.js";
import { run } from "./run.js";
import type { MouseButton, Point, ScrollDirection } from "./types.js";

// Windows input via PowerShell P/Invoke into user32.dll, not nut.js: its native addon cannot load from a
// single-file compiled binary. Mouse uses SetCursorPos + mouse_event, keys use keybd_event; only text goes through
// SendKeys, since it alone handles unicode text and cannot press the Windows key.

const SHIM = `
Add-Type -Namespace IntenticDesktop -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
[DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, System.IntPtr dwExtraInfo);
[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, System.IntPtr dwExtraInfo);
'@;
`;

// user32 mouse_event flags; SetCursorPos already positions the pointer, so the unreliable-across-monitors absolute mode
// is unused.
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

// Screenshot pixels are relative to the virtual desktop's top-left; adding the origin converts to OS coordinates.
const absolute = (at: Point, origin: Point): Point => ({ x: Math.round(at.x + origin.x), y: Math.round(at.y + origin.y) });

const moveScript = (at: Point, origin: Point): string => {
    const { x, y } = absolute(at, origin);
    return `[IntenticDesktop.Native]::SetCursorPos(${x}, ${y}) | Out-Null;`;
};

const clickScript = (button: MouseButton): string =>
    `[IntenticDesktop.Native]::mouse_event(${DOWN[button]}, 0, 0, 0, [System.IntPtr]::Zero); ` +
    `Start-Sleep -Milliseconds 20; ` +
    `[IntenticDesktop.Native]::mouse_event(${UP[button]}, 0, 0, 0, [System.IntPtr]::Zero);`;

// SendKeys reads +^%~(){}[] as syntax; wrapping a literal in braces types it instead of triggering a modifier or group.
const escapeText = (text: string): string => text.replace(/[+^%~(){}[\]]/g, (character) => `{${character}}`);

export const windowsInput = {
    move: async (to: Point, origin: Point): Promise<void> => await powershell(moveScript(to, origin)),

    click: async (at: Point, button: MouseButton, origin: Point): Promise<void> =>
        await powershell(`${moveScript(at, origin)} Start-Sleep -Milliseconds 20; ${clickScript(button)}`),

    doubleClick: async (at: Point, origin: Point): Promise<void> =>
        await powershell(
            `${moveScript(at, origin)} Start-Sleep -Milliseconds 20; ${clickScript("left")} Start-Sleep -Milliseconds 40; ${clickScript("left")}`,
        ),

    // Press, move, release with a pause between each: events delivered instantaneously are not always seen as a drag.
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
        // Newlines become Enter; SendKeys would otherwise drop a literal newline character.
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
        // Modifiers down, key, then modifiers up in reverse: the order a real keyboard produces.
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
