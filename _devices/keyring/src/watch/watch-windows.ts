import { CSHARP_JSON, POWERSHELL } from "../powershell.js";
import type { ChipPlace } from "./chip.js";

// The focus watcher and the chip on Windows: one long-running Windows PowerShell holding a C# class (Add-Type, C# 5).
// UI Automation's focus-changed event (AddAutomationFocusChangedEventHandler) reports each focused element: whether it
// is a password field (IsPassword), its process's executable, and its BoundingRectangle, printed as one JSON line after
// the ANSWER mark. The chip is a borderless, topmost WinForms window that never takes focus (WS_EX_NOACTIVATE and
// ShowWithoutActivation), so the field keeps the keyboard; a click on it prints a `click` line. What the chip shows comes
// in on standard input, one command per line: `show<TAB>x<TAB>y<TAB>label` or `hide`. The field's value is never read:
// UI Automation's ValuePattern refuses a password field's anyway, and nothing here asks for it.

const WATCH_CS = String.raw`
using System;
using System.Diagnostics;
using System.Drawing;
using System.Threading;
using System.Windows.Automation;
using System.Windows.Forms;

namespace IntenticKeyring {
  ${CSHARP_JSON}

  public class Chip : Form {
    const int WS_EX_TOPMOST = 0x8;
    const int WS_EX_TOOLWINDOW = 0x80;
    const int WS_EX_NOACTIVATE = 0x08000000;
    readonly Label label;
    public Chip() {
      FormBorderStyle = FormBorderStyle.None;
      ShowInTaskbar = false;
      TopMost = true;
      StartPosition = FormStartPosition.Manual;
      AutoSize = true;
      AutoSizeMode = AutoSizeMode.GrowAndShrink;
      BackColor = Color.FromArgb(32, 32, 36);
      Padding = new Padding(10, 5, 10, 5);
      label = new Label();
      label.AutoSize = true;
      label.ForeColor = Color.White;
      label.Font = new Font("Segoe UI", 9f, FontStyle.Bold);
      label.Cursor = Cursors.Hand;
      label.Click += delegate(object sender, EventArgs e) { Watch.Say("{\"event\":\"click\"}"); };
      Click += delegate(object sender, EventArgs e) { Watch.Say("{\"event\":\"click\"}"); };
      Controls.Add(label);
    }
    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams {
      get { CreateParams p = base.CreateParams; p.ExStyle |= WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE; return p; }
    }
    public void ShowAt(string text, int x, int y) {
      label.Text = text;
      Location = new Point(x, y);
      if (!Visible) { Show(); }
    }
  }

  public static class Watch {
    static readonly object gate = new object();
    public static void Say(string json) {
      lock (gate) { Console.Out.WriteLine("intentic-keyring>" + json); Console.Out.Flush(); }
    }
    static string PathOf(int pid) {
      // allow(silent-catch): a process of another user or one already gone hides its path; its name is the next best
      try { return Process.GetProcessById(pid).MainModule.FileName; } catch (Exception) { }
      // allow(silent-catch): and a process gone by now has neither, which reads as no program
      try { return Process.GetProcessById(pid).ProcessName + ".exe"; } catch (Exception) { }
      return "";
    }
    static int Whole(double d) { return double.IsInfinity(d) || double.IsNaN(d) ? 0 : (int)d; }
    static void Command(Chip chip, string line) {
      if (line == "hide") { chip.Hide(); return; }
      string[] parts = line.Split('\t');
      int x; int y;
      if (parts.Length == 4 && parts[0] == "show" && int.TryParse(parts[1], out x) && int.TryParse(parts[2], out y)) { chip.ShowAt(parts[3], x, y); }
    }
    public static void Run() {
      Application.EnableVisualStyles();
      Chip chip = new Chip();
      IntPtr made = chip.Handle;
      int own = Process.GetCurrentProcess().Id;
      Automation.AddAutomationFocusChangedEventHandler(delegate(object sender, AutomationFocusChangedEventArgs e) {
        try {
          AutomationElement element = sender as AutomationElement;
          if (element == null) { return; }
          int pid = element.Current.ProcessId;
          if (pid == own) { return; }
          System.Windows.Rect r = element.Current.BoundingRectangle;
          Say("{\"event\":\"focus\",\"password\":" + (element.Current.IsPassword ? "true" : "false") + ",\"path\":" + KeyringJson.Str(PathOf(pid)) +
              ",\"x\":" + Whole(r.Left) + ",\"y\":" + Whole(r.Top) + ",\"width\":" + Whole(r.Width) + ",\"height\":" + Whole(r.Height) + "}");
        // allow(silent-catch): an element that vanished while focus moved has nothing to report, and the next focus does
        } catch (Exception) { }
      });
      Thread reader = new Thread(delegate() {
        string line;
        while ((line = Console.In.ReadLine()) != null) {
          string command = line;
          chip.BeginInvoke((MethodInvoker)delegate { Command(chip, command); });
        }
        chip.BeginInvoke((MethodInvoker)delegate { Application.ExitThread(); });
      });
      reader.IsBackground = true;
      reader.Start();
      Application.Run();
    }
  }
}
`;

const WATCH_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase, System.Windows.Forms, System.Drawing
Add-Type -ReferencedAssemblies UIAutomationClient, UIAutomationTypes, WindowsBase, System.Windows.Forms, System.Drawing -TypeDefinition @'
${WATCH_CS}
'@
[IntenticKeyring.Watch]::Run()
`;

// The script rides -EncodedCommand (UTF-16LE base64): it is a constant, holds nothing secret, and leaves standard
// input free for the chip's commands.
export const windowsWatchArgs = (): readonly string[] => ["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", Buffer.from(WATCH_SCRIPT, "utf16le").toString("base64")];

export const WINDOWS_WATCH_COMMAND = POWERSHELL;

/** The chip's commands as the script reads them. Pure. A label holds no tab or line break; one that did is cut there. */
export const showCommand = (label: string, at: ChipPlace): string => `show\t${String(Math.round(at.x))}\t${String(Math.round(at.y))}\t${label.split(/[\t\r\n]/u)[0] ?? ""}`;
export const HIDE_COMMAND = "hide";
