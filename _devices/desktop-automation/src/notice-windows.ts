import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { type Modifier, parseChord, windowsChord } from "./keys.js";
import type { Notice, NoticeEvents } from "./types.js";

// The notice on Windows: one hidden powershell.exe hosting a WinForms window, told "show <text>" or "quit" on stdin
// (end of input is quit) and answering "hotkey" or "hotkey-taken" on stdout. The window may never take focus, catch
// a click or appear in a capture: the agent it announces types into the focused window and reads screenshots.

// RegisterHotKey's modifier bits, by this package's modifier names.
const MOD: Record<Modifier, number> = { alt: 0x1, ctrl: 0x2, shift: 0x4, super: 0x8 };

// How long a helper asked to quit has before it is killed: it has one window to close and nothing to save.
const QUIT_GRACE_MS = 1_000;

// C# 5, the newest Windows PowerShell 5.1 compiles. Never ShowWindow: its first call obeys a hidden spawn's SW_HIDE.
const PILL = `
using System;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace IntenticNotice {
  public class Pill : Form {
    const int WS_EX_TOPMOST = 0x00000008;
    const int WS_EX_TRANSPARENT = 0x00000020;
    const int WS_EX_TOOLWINDOW = 0x00000080;
    const int WS_EX_APPWINDOW = 0x00040000;
    const int WS_EX_LAYERED = 0x00080000;
    const int WS_EX_NOACTIVATE = 0x08000000;
    const uint WDA_EXCLUDEFROMCAPTURE = 0x00000011;
    const uint LWA_ALPHA = 0x00000002;
    const uint MOD_NOREPEAT = 0x00004000;
    const int WM_HOTKEY = 0x0312;
    const int HOTKEY_ID = 1;
    const uint SWP_NOACTIVATE = 0x0010;
    const uint SWP_SHOWWINDOW = 0x0040;
    static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);

    [DllImport("user32.dll", SetLastError = true)] static extern bool SetWindowDisplayAffinity(IntPtr window, uint affinity);
    [DllImport("user32.dll")] static extern bool SetLayeredWindowAttributes(IntPtr window, uint colorKey, byte alpha, uint flags);
    [DllImport("user32.dll")] static extern bool RegisterHotKey(IntPtr window, int id, uint modifiers, uint key);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] static extern int SetWindowRgn(IntPtr window, IntPtr region, bool redraw);
    [DllImport("gdi32.dll")] static extern IntPtr CreateRoundRectRgn(int left, int top, int right, int bottom, int width, int height);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

    readonly uint modifiers;
    readonly uint key;
    string text = "";
    Rectangle? area;

    Pill(uint modifiers, uint key) {
      this.modifiers = modifiers;
      this.key = key;
      FormBorderStyle = FormBorderStyle.None;
      ShowInTaskbar = false;
      StartPosition = FormStartPosition.Manual;
      BackColor = Color.FromArgb(32, 33, 36);
      ForeColor = Color.White;
      Font = new Font("Segoe UI Semibold", 10f);
    }

    protected override bool ShowWithoutActivation { get { return true; } }

    protected override CreateParams CreateParams {
      get {
        CreateParams created = base.CreateParams;
        created.ExStyle |= WS_EX_NOACTIVATE | WS_EX_TRANSPARENT | WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_TOPMOST;
        created.ExStyle &= ~WS_EX_APPWINDOW;
        return created;
      }
    }

    protected override void OnHandleCreated(EventArgs e) {
      base.OnHandleCreated(e);
      SetLayeredWindowAttributes(Handle, 0, 235, LWA_ALPHA);
      if (!SetWindowDisplayAffinity(Handle, WDA_EXCLUDEFROMCAPTURE)) {
        Quit("Windows would not keep the notice out of screen captures (error " + Marshal.GetLastWin32Error() + ").");
      }
      if (!RegisterHotKey(Handle, HOTKEY_ID, modifiers | MOD_NOREPEAT, key)) {
        Say("hotkey-taken");
      }
    }

    protected override void WndProc(ref Message message) {
      if (message.Msg == WM_HOTKEY && message.WParam.ToInt32() == HOTKEY_ID) {
        Say("hotkey");
      }
      base.WndProc(ref message);
    }

    protected override void OnPaint(PaintEventArgs e) {
      TextRenderer.DrawText(e.Graphics, text, Font, ClientRectangle, ForeColor,
        TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine | TextFormatFlags.NoPrefix);
    }

    void Pin(string next) {
      text = next;
      if (area == null) {
        area = Screen.FromPoint(Cursor.Position).WorkingArea;
      }
      Rectangle screen = area.Value;
      Size measured = TextRenderer.MeasureText(text, Font);
      int height = measured.Height + Font.Height;
      int width = measured.Width + 2 * Font.Height;
      SetWindowRgn(Handle, CreateRoundRectRgn(0, 0, width + 1, height + 1, height, height), true);
      SetWindowPos(Handle, HWND_TOPMOST, screen.X + (screen.Width - width) / 2, screen.Y + Font.Height, width, height, SWP_NOACTIVATE | SWP_SHOWWINDOW);
      Invalidate();
    }

    static void Say(string line) {
      Console.Out.WriteLine(line);
      Console.Out.Flush();
    }

    static void Quit(string why) {
      Console.Error.WriteLine(why);
      Environment.Exit(1);
    }

    public static void Run(uint modifiers, uint key) {
      SetProcessDPIAware();
      Application.ThreadException += delegate(object sender, ThreadExceptionEventArgs e) { Quit(e.Exception.Message); };
      Pill pill = new Pill(modifiers, key);
      if (pill.Handle == IntPtr.Zero) {
        Quit("The notice's window could not be created.");
      }
      Thread reader = new Thread(delegate() {
        try {
          StreamReader input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
          for (string line = input.ReadLine(); line != null && line != "quit"; line = input.ReadLine()) {
            if (line.StartsWith("show ", StringComparison.Ordinal)) {
              string next = line.Substring(5);
              pill.BeginInvoke(new MethodInvoker(delegate() { pill.Pin(next); }));
            }
          }
        } catch (IOException) {
        }
        pill.BeginInvoke(new MethodInvoker(Application.ExitThread));
      });
      reader.IsBackground = true;
      reader.Start();
      Application.Run();
    }
  }
}
`;

// The whole helper, with the hotkey (this package's key vocabulary, e.g. "Ctrl+Alt+Shift+P") spelled as
// RegisterHotKey takes it.
export const noticeScript = (hotkey: string): string => {
    const modifiers = parseChord(hotkey).modifiers.reduce((bits, modifier) => bits | MOD[modifier], 0);
    return [
        "$ErrorActionPreference = 'Stop'",
        "$ProgressPreference = 'SilentlyContinue'",
        "Add-Type -AssemblyName System.Windows.Forms, System.Drawing",
        `Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -IgnoreWarnings -TypeDefinition @'${PILL}'@`,
        `[IntenticNotice.Pill]::Run(${modifiers}, ${windowsChord(hotkey).key})`,
    ].join("\n");
};

// Every helper still running, all ended by one exit hook; a crash that skips it still closes their stdin, read as quit.
const running = new Set<ChildProcess>();
let hooked = false;

// The helper process, whatever runs it: lines in, events out. Apart from the script so a stand-in can drive it anywhere.
export const spawnNotice = (command: string, args: readonly string[], events: NoticeEvents): Notice => {
    if (!hooked) {
        hooked = true;
        process.on("exit", () => running.forEach((helper) => helper.kill()));
    }
    const child = spawn(command, [...args], { windowsHide: true, stdio: "pipe" });
    running.add(child);
    // Set once, by `close` or by the helper going on its own: nothing is sent and no event fires after it.
    let over = false;
    let said = "";
    const kill = (): void => void child.kill();
    const gone = (why: string): void => {
        running.delete(child);
        if (over) {
            return;
        }
        over = true;
        events.exited(why);
    };
    child.on("error", (error) => gone(error.message));
    child.on("close", (code) => gone(said.trim().replace(/\s+/g, " ") || `it exited with code ${code}`));
    // A helper that stopped reading is wedged or gone; either way it is not left on screen.
    child.stdin.on("error", kill);
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        said = `${said}${chunk}`.slice(-2_000);
    });
    createInterface({ input: child.stdout }).on("line", (line) => {
        if (over) {
            return;
        }
        if (line === "hotkey") {
            events.hotkey();
        } else if (line === "hotkey-taken") {
            events.hotkeyTaken();
        }
    });
    return {
        // One command per line is the protocol, so the text is kept to one line.
        show: (text) => {
            if (!over) {
                child.stdin.write(`show ${text.replace(/\s+/g, " ")}\n`);
            }
        },
        close: () => {
            if (over) {
                return;
            }
            over = true;
            child.stdin.end("quit\n");
            setTimeout(kill, QUIT_GRACE_MS).unref();
        },
    };
};

export const windowsNotice = (hotkey: string, events: NoticeEvents): Notice =>
    spawnNotice("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", noticeScript(hotkey)], events);
