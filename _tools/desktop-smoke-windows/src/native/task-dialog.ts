import { psText, type WindowInfo } from "@intentic/desktop-automation";
import { CONFIRM_BUTTON } from "../constants.js";
import { powershell } from "../run.js";

// The setup confirmation is an rfd TaskDialogIndirect dialog. Its own button message goes to its message queue
// even in the background. In run 45490807637, UI Automation could read its button but invoking it hung.
const TASK_DIALOG = `
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class SmokeTaskDialog {
  delegate bool EnumChildProc(IntPtr child, IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr window, EnumChildProc callback, IntPtr data);
  [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr window);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder name, int capacity);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int capacity);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SendMessageTimeout(
    IntPtr window, uint message, UIntPtr wParam, StringBuilder text, uint flags, uint timeout, out UIntPtr result);
  [DllImport("user32.dll", SetLastError = true)] static extern bool PostMessageW(IntPtr window, uint message, UIntPtr wParam, IntPtr lParam);

  const uint WM_GETTEXT = 0x000D;
  const uint SMTO_ABORTIFHUNG = 0x0002;
  const uint TDM_CLICK_BUTTON = 0x0400 + 102;
  // rfd 0.16 assigns this ID to OkCancelCustom's OK button. Native child windows report ID zero.
  const uint ID_CUSTOM_OK = 1000;

  static string ClassName(IntPtr window) {
    var name = new StringBuilder(128);
    GetClassName(window, name, name.Capacity);
    return name.ToString();
  }

  public static void Click(IntPtr dialog, uint expectedPid, string expectedTitle, string label) {
    uint pid;
    var title = new StringBuilder(256);
    GetWindowThreadProcessId(dialog, out pid);
    GetWindowText(dialog, title, title.Capacity);
    if (pid != expectedPid || title.ToString() != expectedTitle || ClassName(dialog) != "#32770") {
      throw new InvalidOperationException("Window " + dialog + " is no longer the expected task dialog.");
    }

    bool found = false;
    EnumChildWindows(dialog, delegate (IntPtr child, IntPtr data) {
      if (!IsWindowEnabled(child) || ClassName(child) != "Button") return true;
      var text = new StringBuilder(256);
      UIntPtr length;
      if (SendMessageTimeout(child, WM_GETTEXT, new UIntPtr((uint)text.Capacity), text, SMTO_ABORTIFHUNG, 1000, out length) == IntPtr.Zero) return true;
      if (text.ToString() != label) return true;
      found = true;
      return false;
    }, IntPtr.Zero);
    if (!found) throw new InvalidOperationException("Window " + dialog + " has no enabled \\"" + label + "\\" button.");
    if (!PostMessageW(dialog, TDM_CLICK_BUTTON, new UIntPtr(ID_CUSTOM_OK), IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
  }
}
`;

export const clickSetupButton = async (dialog: WindowInfo): Promise<void> => {
    const { id, pid, title } = dialog;
    if (!/^[1-9]\d*$/.test(id) || pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) {
        throw new Error(`Window ${id} has no usable Windows handle and owner.`);
    }
    const { code, stderr } = await powershell(
        `$ErrorActionPreference = 'Stop'
         $ProgressPreference = 'SilentlyContinue'
         try {
             Add-Type -TypeDefinition @'
${TASK_DIALOG}
'@
             [SmokeTaskDialog]::Click([IntPtr]::new([int64]'${id}'), [uint32]${pid}, ${psText(title)}, ${psText(CONFIRM_BUTTON)})
         } catch {
             [Console]::Error.WriteLine($_.Exception.GetBaseException().Message)
             exit 1
         }`,
        { timeoutMs: 15_000 },
    );
    if (code !== 0) {
        throw new Error(stderr.trim() || `Posting the setup button to Windows failed with exit code ${code}.`);
    }
};
