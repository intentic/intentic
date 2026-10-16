import { z } from "zod";
import { basenameOf } from "../policy.js";
import { CSHARP_JSON, runPowerShell } from "../powershell.js";
import type { Runner } from "../run.js";
import type { Inspected, Seen, Typed, Typist } from "./typist.js";

// Typing on Windows: one C# helper, compiled by Add-Type for each call, that reports the foreground window (its hwnd,
// its process's executable through QueryFullProcessImageName) and, through UI Automation, whether the focused element
// is a password field; and types with SendInput Unicode events, never SendKeys, which reads `+^%~(){}` as keys. The value
// arrives on the helper's standard input inside the JSON PowerShell reads (powershell.ts), and before the first
// character and after each one the helper checks that the foreground window and its focused element are still the ones
// inspected, stopping where they are not and saying where the focus went.

const HELPER = String.raw`
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;

${CSHARP_JSON}

public static class KeyringTypist {
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder name, ref uint size);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);

  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  // The union is as large as its largest member, the mouse's: SendInput refuses an INPUT of the wrong size.
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION u; }

  const uint INPUT_KEYBOARD = 1;
  const uint KEYEVENTF_KEYUP = 0x0002;
  const uint KEYEVENTF_UNICODE = 0x0004;
  const ushort VK_RETURN = 0x0D;
  const ushort VK_TAB = 0x09;
  const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

  static string ImagePath(uint processId) {
    IntPtr process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, processId);
    if (process == IntPtr.Zero) return "";
    try {
      StringBuilder name = new StringBuilder(1024);
      uint size = (uint)name.Capacity;
      return QueryFullProcessImageName(process, 0, name, ref size) ? name.ToString(0, (int)size) : "";
    } finally { CloseHandle(process); }
  }

  static string ForegroundPath() {
    uint processId;
    GetWindowThreadProcessId(GetForegroundWindow(), out processId);
    return ImagePath(processId);
  }

  static string ElementId(AutomationElement element) {
    int[] id = element.GetRuntimeId();
    if (id == null) return "";
    string[] parts = new string[id.Length];
    for (int i = 0; i < id.Length; i++) parts[i] = id[i].ToString();
    return string.Join(".", parts);
  }

  public static string Inspect() {
    IntPtr window = GetForegroundWindow();
    if (window == IntPtr.Zero) return "{\"ok\":false,\"reason\":\"no window holds the keyboard's focus\"}";
    uint processId;
    GetWindowThreadProcessId(window, out processId);
    string path = ImagePath(processId);
    bool password = false;
    bool known = false;
    string element = "";
    string control = "";
    try {
      AutomationElement focused = AutomationElement.FocusedElement;
      if (focused != null && focused.Current.ProcessId == (int)processId) {
        password = focused.Current.IsPassword;
        control = focused.Current.ControlType.ProgrammaticName;
        element = ElementId(focused);
        known = true;
      }
    } catch (Exception) { } // allow(silent-catch): a window that does not answer UI Automation leaves the field unknown, which policy treats as not a password field
    StringBuilder b = new StringBuilder("{\"ok\":true");
    b.Append(",\"window\":").Append(window.ToInt64());
    b.Append(",\"path\":").Append(KeyringJson.Str(path));
    b.Append(",\"field\":").Append(KeyringJson.Str(!known ? "unknown" : password ? "password" : "text"));
    b.Append(",\"control\":").Append(KeyringJson.Str(control));
    b.Append(",\"element\":").Append(KeyringJson.Str(element));
    return b.Append('}').ToString();
  }

  static INPUT Key(ushort vk, ushort scan, uint flags) {
    INPUT input = new INPUT();
    input.type = INPUT_KEYBOARD;
    input.u.ki.wVk = vk;
    input.u.ki.wScan = scan;
    input.u.ki.dwFlags = flags;
    return input;
  }

  static bool Still(IntPtr window, string element) {
    if (GetForegroundWindow() != window) return false;
    if (element == "") return true;
    // allow(silent-catch): an element UI Automation can no longer read is not the field the typing started in, so typing stops.
    try { return ElementId(AutomationElement.FocusedElement) == element; } catch (Exception) { return false; }
  }

  static string Stopped(string why, int typed, int total) {
    return "{\"ok\":false,\"reason\":" + KeyringJson.Str(why) + ",\"typed\":" + typed + ",\"total\":" + total + ",\"now\":" + KeyringJson.Str(ForegroundPath()) + "}";
  }

  public static string Type(long windowHandle, string element, string text) {
    IntPtr window = new IntPtr(windowHandle);
    if (!Still(window, element)) return Stopped("moved", 0, text.Length);
    int size = Marshal.SizeOf(typeof(INPUT));
    int typed = 0;
    for (int i = 0; i < text.Length; i++) {
      char c = text[i];
      INPUT[] inputs;
      int units = 1;
      if (c == '\r' || c == '\n') {
        if (c == '\r' && i + 1 < text.Length && text[i + 1] == '\n') { i++; units = 2; }
        inputs = new INPUT[] { Key(VK_RETURN, 0, 0), Key(VK_RETURN, 0, KEYEVENTF_KEYUP) };
      } else if (c == '\t') {
        inputs = new INPUT[] { Key(VK_TAB, 0, 0), Key(VK_TAB, 0, KEYEVENTF_KEYUP) };
      } else if (char.IsHighSurrogate(c) && i + 1 < text.Length && char.IsLowSurrogate(text[i + 1])) {
        // A character past the BMP is its two UTF-16 units, pressed in order and released after.
        char low = text[++i];
        units = 2;
        inputs = new INPUT[] { Key(0, c, KEYEVENTF_UNICODE), Key(0, low, KEYEVENTF_UNICODE), Key(0, c, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP), Key(0, low, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP) };
      } else {
        inputs = new INPUT[] { Key(0, c, KEYEVENTF_UNICODE), Key(0, c, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP) };
      }
      if (SendInput((uint)inputs.Length, inputs, size) != (uint)inputs.Length) return Stopped("blocked", typed, text.Length);
      typed += units;
      Thread.Sleep(4);
      if (!Still(window, element)) return Stopped("moved", typed, text.Length);
    }
    return "{\"ok\":true,\"typed\":" + typed + ",\"total\":" + text.Length + "}";
  }
}
`;

const SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
  Add-Type -IgnoreWarnings -ReferencedAssemblies UIAutomationClient, UIAutomationTypes, WindowsBase -TypeDefinition @'
${HELPER}
'@
  if ($KeyringInput.op -eq 'inspect') {
    [Console]::Out.WriteLine('intentic-keyring>' + [KeyringTypist]::Inspect())
  } else {
    [Console]::Out.WriteLine('intentic-keyring>' + [KeyringTypist]::Type([long]$KeyringInput.window, [string]$KeyringInput.element, [string]$KeyringInput.value))
  }
} catch {
  [Console]::Out.WriteLine('intentic-keyring>' + (@{ ok = $false; reason = 'failed'; error = $_.Exception.Message } | ConvertTo-Json -Compress))
}
`;

// Compiling the helper takes a second or two; typing a long value at a few milliseconds a character takes longer.
const TIMEOUT_MS = 60_000;

const InspectSchema = z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), window: z.number(), path: z.string(), field: z.enum(["password", "text", "unknown"]), control: z.string(), element: z.string() }),
    z.object({ ok: z.literal(false), reason: z.string(), error: z.string().optional() }),
]);

const TypeSchema = z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), typed: z.number(), total: z.number() }),
    z.object({ ok: z.literal(false), reason: z.string(), typed: z.number().optional(), total: z.number().optional(), now: z.string().optional(), error: z.string().optional() }),
]);

// `<hwnd>/<element runtime id>`: what typing checks is still in front.
const HANDLE = /^(?<window>-?\d+)\/(?<element>[\d.]*)$/u;

const stoppedReason = (answer: Extract<z.infer<typeof TypeSchema>, { ok: false }>): string => {
    const now = answer.now === undefined || answer.now === "" ? "another window" : basenameOf(answer.now);
    const where = answer.typed === undefined || answer.typed === 0 ? "nothing was typed" : `${String(answer.typed)} of ${String(answer.total ?? "?")} characters went in before it stopped`;
    switch (answer.reason) {
        case "moved":
            return `The focus moved to ${now} while typing; ${where}.`;
        case "blocked":
            return `Windows refused the keystrokes (a window running as administrator takes none from a program that is not); ${where}.`;
        default:
            return `The typing helper failed${answer.error === undefined ? "" : `: ${answer.error.slice(0, 200)}`}.`;
    }
};

export const windowsTypist = (runner: Runner): Typist => ({
    inspect: async (): Promise<Inspected> => {
        const ran = await runPowerShell(runner, { script: SCRIPT, input: { op: "inspect" }, timeoutMs: TIMEOUT_MS }, InspectSchema);
        if (!ran.ok) {
            return { ok: false, reason: ran.reason };
        }
        const answer = ran.answer;
        if (!answer.ok) {
            return { ok: false, reason: answer.error ?? answer.reason };
        }
        return { ok: true, seen: { focus: { program: basenameOf(answer.path), path: answer.path, field: answer.field }, handle: `${String(answer.window)}/${answer.element}` } };
    },
    type: async (_place, seen: Seen, value: string): Promise<Typed> => {
        const handle = HANDLE.exec(seen.handle);
        if (handle?.groups?.["window"] === undefined) {
            return { ok: false, reason: "The window to type into was not one this typist inspected.", partly: false };
        }
        const ran = await runPowerShell(
            runner,
            { script: SCRIPT, input: { op: "type", window: handle.groups["window"], element: handle.groups["element"] ?? "", value }, timeoutMs: TIMEOUT_MS + value.length * 50 },
            TypeSchema,
        );
        if (!ran.ok) {
            // Whether anything went in is not known: the helper may have stopped mid-way.
            return { ok: false, reason: ran.reason, partly: true };
        }
        const answer = ran.answer;
        return answer.ok ? { ok: true } : { ok: false, reason: stoppedReason(answer), partly: (answer.typed ?? 0) > 0 };
    },
});
