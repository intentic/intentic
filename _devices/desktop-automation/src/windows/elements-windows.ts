import { setTimeout as sleep } from "node:timers/promises";
import { parseElementJson, parseElementTreeJson } from "../parse.js";
import { psText } from "./powershell.js";
import { run } from "../run.js";
import { DesktopError, type ElementAction, type ElementTree, type UiElement } from "../types.js";
import { WINDOWS_DPI_AWARE } from "./windows-dpi.js";

/* A window's controls through UI Automation, the accessibility API every Windows toolkit answers (Win32, WPF,
   WinForms, UWP, Chromium and Electron once a client asks). Written in C# and compiled by PowerShell's Add-Type,
   which keeps this package free of native modules like everything else here; Windows PowerShell compiles C# 5,
   so the code below uses nothing newer.

   The tree is read with one cache request over the whole subtree: walking it node by node costs a cross-process
   round trip per node, which a browser window's thousands of nodes turn into a minute. An element is found again
   by its runtime id, which UI Automation keeps for as long as the element lives. */

const HELPER = `
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;

public static class IntenticUia {
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);

  static readonly AutomationProperty[] Props = new AutomationProperty[] {
    AutomationElement.NameProperty, AutomationElement.ControlTypeProperty, AutomationElement.BoundingRectangleProperty,
    AutomationElement.IsEnabledProperty, AutomationElement.HasKeyboardFocusProperty, AutomationElement.IsOffscreenProperty,
    AutomationElement.RuntimeIdProperty, AutomationElement.IsKeyboardFocusableProperty,
    AutomationElement.IsInvokePatternAvailableProperty, AutomationElement.IsValuePatternAvailableProperty,
    AutomationElement.IsTogglePatternAvailableProperty, AutomationElement.IsExpandCollapsePatternAvailableProperty,
    AutomationElement.IsSelectionItemPatternAvailableProperty, ValuePattern.ValueProperty, ValuePattern.IsReadOnlyProperty,
    TogglePattern.ToggleStateProperty
  };

  static string Esc(string s) {
    if (s == null) return "null";
    if (s.Length > 200) s = s.Substring(0, 200) + "…";
    StringBuilder b = new StringBuilder("\\"");
    foreach (char c in s) {
      if (c == '"') b.Append("\\\\\\"");
      else if (c == '\\\\') b.Append("\\\\\\\\");
      else if (c < 0x20) b.AppendFormat("\\\\u{0:x4}", (int)c);
      else b.Append(c);
    }
    return b.Append('"').ToString();
  }

  static CacheRequest Request(TreeScope scope, AutomationElementMode mode) {
    CacheRequest request = new CacheRequest();
    request.TreeScope = scope;
    request.TreeFilter = Automation.ControlViewCondition;
    request.AutomationElementMode = mode;
    foreach (AutomationProperty p in Props) request.Add(p);
    return request;
  }

  static bool Flag(AutomationElement e, AutomationProperty p) {
    object v = e.GetCachedPropertyValue(p, true);
    return v is bool && (bool)v;
  }

  static string Record(AutomationElement e, int depth) {
    int left = GetSystemMetrics(76), top = GetSystemMetrics(77);
    object name = e.GetCachedPropertyValue(AutomationElement.NameProperty, true);
    ControlType type = e.GetCachedPropertyValue(AutomationElement.ControlTypeProperty, true) as ControlType;
    object rect = e.GetCachedPropertyValue(AutomationElement.BoundingRectangleProperty, true);
    int[] rid = e.GetCachedPropertyValue(AutomationElement.RuntimeIdProperty, true) as int[];
    object value = e.GetCachedPropertyValue(ValuePattern.ValueProperty, true);
    object toggle = e.GetCachedPropertyValue(TogglePattern.ToggleStateProperty, true);
    StringBuilder b = new StringBuilder("{");
    b.Append("\\"id\\":").Append(Esc(rid == null ? "" : string.Join(".", rid)));
    b.Append(",\\"type\\":").Append(Esc(type == null ? "" : type.ProgrammaticName));
    b.Append(",\\"name\\":").Append(Esc(name as string ?? ""));
    if (value is string) b.Append(",\\"value\\":").Append(Esc((string)value));
    else if (toggle is ToggleState) b.Append(",\\"value\\":").Append(Esc(toggle.ToString()));
    if (rect is System.Windows.Rect && !((System.Windows.Rect)rect).IsEmpty && !double.IsInfinity(((System.Windows.Rect)rect).X)) {
      System.Windows.Rect r = (System.Windows.Rect)rect;
      b.AppendFormat(",\\"x\\":{0},\\"y\\":{1},\\"width\\":{2},\\"height\\":{3}", (int)Math.Round(r.X) - left, (int)Math.Round(r.Y) - top, (int)Math.Round(r.Width), (int)Math.Round(r.Height));
    }
    b.Append(",\\"enabled\\":").Append(Flag(e, AutomationElement.IsEnabledProperty) ? "true" : "false");
    b.Append(",\\"focused\\":").Append(Flag(e, AutomationElement.HasKeyboardFocusProperty) ? "true" : "false");
    b.Append(",\\"offscreen\\":").Append(Flag(e, AutomationElement.IsOffscreenProperty) ? "true" : "false");
    b.Append(",\\"focusable\\":").Append(Flag(e, AutomationElement.IsKeyboardFocusableProperty) ? "true" : "false");
    b.Append(",\\"invoke\\":").Append(Flag(e, AutomationElement.IsInvokePatternAvailableProperty) ? "true" : "false");
    b.Append(",\\"settable\\":").Append(Flag(e, AutomationElement.IsValuePatternAvailableProperty) && !Flag(e, ValuePattern.IsReadOnlyProperty) ? "true" : "false");
    b.Append(",\\"toggle\\":").Append(Flag(e, AutomationElement.IsTogglePatternAvailableProperty) ? "true" : "false");
    b.Append(",\\"expand\\":").Append(Flag(e, AutomationElement.IsExpandCollapsePatternAvailableProperty) ? "true" : "false");
    b.Append(",\\"select\\":").Append(Flag(e, AutomationElement.IsSelectionItemPatternAvailableProperty) ? "true" : "false");
    b.Append(",\\"depth\\":").Append(depth);
    return b.Append('}').ToString();
  }

  static IntPtr Handle(long hwnd) {
    IntPtr h = hwnd == 0 ? GetForegroundWindow() : new IntPtr(hwnd);
    if (h == IntPtr.Zero) throw new InvalidOperationException("nothing holds the foreground");
    return h;
  }

  public static string Tree(long hwnd, int max) {
    IntPtr h = Handle(hwnd);
    AutomationElement root = AutomationElement.FromHandle(h);
    AutomationElement cached = root.GetUpdatedCache(Request(TreeScope.Subtree, AutomationElementMode.None));
    string app = "";
    try { app = Process.GetProcessById(root.Current.ProcessId).ProcessName; } catch (Exception) { } // allow(silent-catch): a process gone since its window was read leaves the app unnamed, not the tree unread
    StringBuilder b = new StringBuilder("{\\"window\\":{");
    b.Append("\\"id\\":").Append(Esc(h.ToInt64().ToString())).Append(",\\"title\\":").Append(Esc(root.Current.Name)).Append(",\\"app\\":").Append(Esc(app));
    b.Append(",\\"class\\":").Append(Esc(root.Current.ClassName));
    b.Append("},\\"elements\\":[");
    Stack<KeyValuePair<AutomationElement, int>> stack = new Stack<KeyValuePair<AutomationElement, int>>();
    stack.Push(new KeyValuePair<AutomationElement, int>(cached, 0));
    int count = 0;
    bool truncated = false;
    while (stack.Count > 0) {
      if (count >= max) { truncated = true; break; }
      KeyValuePair<AutomationElement, int> next = stack.Pop();
      if (count > 0) b.Append(',');
      b.Append(Record(next.Key, next.Value));
      count++;
      AutomationElementCollection children = next.Key.CachedChildren;
      if (children == null) continue;
      for (int i = children.Count - 1; i >= 0; i--) stack.Push(new KeyValuePair<AutomationElement, int>(children[i], next.Value + 1));
    }
    return b.Append("],\\"truncated\\":").Append(truncated ? "true" : "false").Append('}').ToString();
  }

  static AutomationElement Locate(long hwnd, string rid, CacheRequest request) {
    AutomationElement root = AutomationElement.FromHandle(Handle(hwnd));
    string[] parts = rid.Split('.');
    int[] ids = new int[parts.Length];
    for (int i = 0; i < parts.Length; i++) ids[i] = int.Parse(parts[i]);
    using (request.Activate()) {
      return root.FindFirst(TreeScope.Subtree, new PropertyCondition(AutomationElement.RuntimeIdProperty, ids));
    }
  }

  public static string Find(long hwnd, string rid) {
    AutomationElement e = Locate(hwnd, rid, Request(TreeScope.Element, AutomationElementMode.None));
    return e == null ? "" : Record(e, 0);
  }

  // A pattern call runs on a thread of its own and is given a few seconds: Invoke on a button that opens a modal
  // dialog does not return until the dialog closes in some toolkits, and the click has been delivered by then.
  public static string Act(long hwnd, string rid, string action, string value) {
    AutomationElement e = Locate(hwnd, rid, Request(TreeScope.Element, AutomationElementMode.Full));
    if (e == null) return "gone";
    string failure = null;
    Thread worker = new Thread(delegate () {
      try {
        if (action == "invoke") ((InvokePattern)e.GetCurrentPattern(InvokePattern.Pattern)).Invoke();
        else if (action == "set_value") ((ValuePattern)e.GetCurrentPattern(ValuePattern.Pattern)).SetValue(value);
        else if (action == "toggle") ((TogglePattern)e.GetCurrentPattern(TogglePattern.Pattern)).Toggle();
        else if (action == "expand") ((ExpandCollapsePattern)e.GetCurrentPattern(ExpandCollapsePattern.Pattern)).Expand();
        else if (action == "collapse") ((ExpandCollapsePattern)e.GetCurrentPattern(ExpandCollapsePattern.Pattern)).Collapse();
        else if (action == "select") ((SelectionItemPattern)e.GetCurrentPattern(SelectionItemPattern.Pattern)).Select();
        else if (action == "focus") e.SetFocus();
        else failure = "unknown action " + action;
      } catch (InvalidOperationException ex) {
        failure = "unsupported: " + ex.Message;
      } catch (Exception ex) {
        failure = ex.Message;
      }
    });
    worker.IsBackground = true;
    worker.Start();
    if (!worker.Join(4000)) return "pending";
    return failure == null ? "ok" : "failed: " + failure;
  }
}
`;

const ADD_HELPER = `${WINDOWS_DPI_AWARE}
Add-Type -ReferencedAssemblies UIAutomationClient, UIAutomationTypes, WindowsBase -TypeDefinition @'
${HELPER}
'@;
`;

// A big window's tree takes seconds to read; more than run.ts's usual budget, less than a model's patience.
const TREE_TIMEOUT_MS = 40_000;
// Nodes read before the walk stops. Enough for a settings dialog or an editor's chrome; a browser page's content
// past this is what the browser tools are for.
const MAX_NODES = 2_500;

const handle = (window: string | undefined): string => {
    if (window === undefined) {
        return "0";
    }
    if (!/^\d+$/.test(window)) {
        throw new DesktopError(`"${window}" is not a window id: take one from the window list.`);
    }
    return window;
};

const runtimeId = (id: string): string => {
    if (!/^-?\d+(\.-?\d+)*$/.test(id)) {
        throw new DesktopError(`"${id}" is not an element id this device handed out.`);
    }
    return id;
};

const powershell = (script: string, timeoutMs?: number): Promise<string> =>
    run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `${ADD_HELPER}${script}`], undefined, timeoutMs);

// Text for a helper's string parameter, as data (powershell.ts): a field's new value is whatever the agent chose.
const quoted = psText;

// Chromium and every Electron app build their accessibility tree only once a client asks for one, so the first read
// of such a window answers its title bar and little else; the same read a moment later answers the page. Measured on
// VS Code (2026-10-05): 14 elements, then 1330.
const CHROMIUM_WINDOW = /"class":"Chrome_WidgetWin_/;
const BARE_TREE = 40;
const CHROMIUM_WAKE_MS = 400;

const readTree = async (window: string | undefined): Promise<string> =>
    (await powershell(`[IntenticUia]::Tree(${handle(window)}, ${MAX_NODES})`, TREE_TIMEOUT_MS)).trim();

export const actScript = (window: string, id: string, action: ElementAction, value?: string): string =>
    `[IntenticUia]::Act(${handle(window)}, ${quoted(runtimeId(id))}, ${quoted(action)}, ${quoted(value ?? "")})`;

export const windowsElements = {
    elements: async (window?: string): Promise<ElementTree> => {
        const first = await readTree(window);
        const tree = parseElementTreeJson(first);
        if (!CHROMIUM_WINDOW.test(first) || tree.elements.length > BARE_TREE) {
            return tree;
        }
        await sleep(CHROMIUM_WAKE_MS);
        const again = parseElementTreeJson(await readTree(tree.window.id));
        return again.elements.length > tree.elements.length ? again : tree;
    },

    element: async (window: string, id: string): Promise<UiElement | undefined> => {
        const answer = (await powershell(`[IntenticUia]::Find(${handle(window)}, ${quoted(runtimeId(id))})`)).trim();
        return answer === "" ? undefined : parseElementJson(answer);
    },

    elementAct: async (window: string, id: string, action: ElementAction, value?: string): Promise<void> => {
        const answer = (await powershell(actScript(window, id, action, value))).trim();
        if (answer === "ok") {
            return;
        }
        if (answer === "gone") {
            throw new DesktopError(`Element ${id} is no longer in that window. List the elements again.`);
        }
        if (answer === "pending") {
            throw new DesktopError(
                `Asked element ${id} to ${action.replace("_", " ")}, and the application has not answered after 4s: it has probably opened a dialog. Take a screenshot to see.`,
            );
        }
        throw new DesktopError(answer.startsWith("failed: unsupported") ? `Element ${id} does not support ${action.replace("_", " ")}.` : `Could not ${action.replace("_", " ")} element ${id}: ${answer.replace(/^failed: /, "")}`);
    },
};
