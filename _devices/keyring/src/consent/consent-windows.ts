import { z } from "zod";
import type { ChoicePrompt, HelloDriver, HelloResult, PassphrasePrompt, ValuePrompt } from "./consent.js";
import { runPowerShell, WINRT_AWAIT } from "../powershell.js";
import type { Runner } from "../run.js";

// Windows Hello and the passphrase dialog on Windows, through Windows PowerShell 5.1 (powershell.ts): KeyCredentialManager
// to create the keyring's credential and sign with it (RSA in the TPM, released by a Hello gesture), UserConsentVerifier
// for a plain yes while unlocked, and WinForms boxes for the recovery key, the type-once value and an agent's choice,
// drawn in Windows' own light or dark look.

// Long enough for a person to walk back to the computer; no longer than a grant lives.
const PROMPT_TIMEOUT_MS = 125_000;
// How long "is Hello set up here?" is believed: it changes only when the person sets Hello up or removes it.
const AVAILABLE_FOR_MS = 5 * 60_000;

// The three boxes, compiled by Add-Type: C# 5, the newest Windows PowerShell compiles.
const FORMS = String.raw`
using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

namespace IntenticKeyring {
  // PowerShell is started hidden (windowsHide: STARTF_USESHOWWINDOW with SW_HIDE), and Windows applies that to the
  // first ShowWindow call in the process: ShowDialog's own. The box would exist, run its timer and close unseen, so
  // each one shows itself again from Shown, which a second ShowWindow call does.
  public static class Reveal {
    const int SW_SHOWNORMAL = 1;
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int command);
    public static void Show(Form form) {
      ShowWindow(form.Handle, SW_SHOWNORMAL);
      form.Activate();
    }
  }

  // How every box looks: Windows' own light or dark app mode (its title bar too), drawn at the screen's real DPI
  // instead of stretched blurry from 96, a heading, a quieter message, and one accent button for the answer.
  public static class Look {
    public const int WIDTH = 400;
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int size);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SendMessage(IntPtr window, int message, IntPtr wParam, string lParam);
    const int DWMWA_USE_IMMERSIVE_DARK_MODE = 20;
    const int EM_SETCUEBANNER = 0x1501;

    static bool dark;
    static float scale = 1f;
    static Color back, fore, muted, fieldBack, line, accent, accentText, danger;

    // Before the first window: DPI awareness is the process's, and only counts if set before one exists.
    public static void Begin() {
      try {
        SetProcessDPIAware();
      } catch (Exception) {
        // allow(silent-catch): a Windows too old to say it leaves the box stretched from 96 DPI, still usable
      }
      Application.EnableVisualStyles();
      using (Graphics screen = Graphics.FromHwnd(IntPtr.Zero)) { scale = screen.DpiX / 96f; }
      dark = false;
      try {
        object light = Microsoft.Win32.Registry.GetValue(@"HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize", "AppsUseLightTheme", 1);
        dark = light is int && (int)light == 0;
      } catch (Exception) {
        // allow(silent-catch): no app-mode setting to read is Windows' default, the light look
      }
      back = dark ? Color.FromArgb(32, 32, 32) : Color.FromArgb(243, 243, 243);
      fore = dark ? Color.FromArgb(255, 255, 255) : Color.FromArgb(27, 27, 27);
      muted = dark ? Color.FromArgb(206, 206, 206) : Color.FromArgb(92, 92, 92);
      fieldBack = dark ? Color.FromArgb(45, 45, 45) : Color.White;
      line = dark ? Color.FromArgb(80, 80, 80) : Color.FromArgb(204, 204, 204);
      danger = dark ? Color.FromArgb(255, 153, 164) : Color.FromArgb(196, 43, 28);
      accent = dark ? Color.FromArgb(76, 194, 255) : Color.FromArgb(0, 95, 184);
      accentText = dark ? Color.Black : Color.White;
    }

    // Logical pixels to the screen's: fonts are in points and scale by themselves, sizes and spacing do not.
    public static int S(int pixels) { return (int)Math.Round(pixels * scale); }

    public static Form NewForm() {
      Form form = new Form();
      form.Text = "Intentic Passwords";
      form.Font = new Font("Segoe UI", 10f);
      form.BackColor = back;
      form.ForeColor = fore;
      form.FormBorderStyle = FormBorderStyle.FixedDialog;
      form.MinimizeBox = false;
      form.MaximizeBox = false;
      form.ShowIcon = false;
      form.TopMost = true;
      form.StartPosition = FormStartPosition.CenterScreen;
      form.AutoSize = true;
      form.AutoSizeMode = AutoSizeMode.GrowAndShrink;
      form.Padding = new Padding(S(24), S(20), S(24), S(20));
      form.HandleCreated += delegate(object sender, EventArgs e) {
        int on = dark ? 1 : 0;
        try {
          DwmSetWindowAttribute(form.Handle, DWMWA_USE_IMMERSIVE_DARK_MODE, ref on, 4);
        } catch (Exception) {
          // allow(silent-catch): a Windows without the attribute keeps its light title bar over a dark box
        }
      };
      return form;
    }

    public static FlowLayoutPanel Column() {
      FlowLayoutPanel panel = new FlowLayoutPanel();
      panel.FlowDirection = FlowDirection.TopDown;
      panel.WrapContents = false;
      panel.AutoSize = true;
      panel.AutoSizeMode = AutoSizeMode.GrowAndShrink;
      panel.Margin = new Padding(0);
      return panel;
    }

    static Label Words(string text, float size, bool strong, Color color, int below) {
      Label label = new Label();
      label.Text = text;
      label.Font = new Font(strong ? "Segoe UI Semibold" : "Segoe UI", size);
      label.ForeColor = color;
      label.AutoSize = true;
      label.MaximumSize = new Size(S(WIDTH), 0);
      label.Margin = new Padding(0, 0, 0, S(below));
      return label;
    }
    public static Label Heading(string text) { return Words(text, 14f, true, fore, 8); }
    public static Label Body(string text) { return Words(text, 10f, false, muted, 18); }
    public static Label Problem(string text) { return Words(text, 10f, true, danger, 12); }
    public static Label FieldLabel(string text) { return Words(text, 10f, true, fore, 6); }

    // A text field the box's width; a cue, where given, is shown greyed while it is empty (the shape of what goes in).
    public static TextBox Field(bool secret, bool mono, string cue) {
      TextBox box = new TextBox();
      box.UseSystemPasswordChar = secret;
      box.Font = mono ? new Font("Consolas", 12f) : new Font("Segoe UI", 11f);
      box.BackColor = fieldBack;
      box.ForeColor = fore;
      box.BorderStyle = BorderStyle.FixedSingle;
      box.Width = S(WIDTH);
      box.Margin = new Padding(0, 0, 0, S(20));
      if (cue != null) {
        box.HandleCreated += delegate(object sender, EventArgs e) { SendMessage(box.Handle, EM_SETCUEBANNER, (IntPtr)1, cue); };
      }
      return box;
    }

    public static CheckBox Tick(string text, bool on) {
      CheckBox tick = new CheckBox();
      tick.Text = text;
      tick.Checked = on;
      tick.AutoSize = true;
      tick.ForeColor = fore;
      tick.Margin = new Padding(0, 0, 0, S(20));
      return tick;
    }

    public static Button Action(string text, bool primary) {
      Button button = new Button();
      button.Text = text;
      button.AutoSize = true;
      button.AutoSizeMode = AutoSizeMode.GrowAndShrink;
      button.MinimumSize = new Size(S(96), S(34));
      button.Padding = new Padding(S(12), 0, S(12), 0);
      button.FlatStyle = FlatStyle.Flat;
      button.FlatAppearance.BorderSize = 1;
      button.FlatAppearance.BorderColor = primary ? accent : line;
      button.BackColor = primary ? accent : fieldBack;
      button.ForeColor = primary ? accentText : fore;
      button.Font = new Font(primary ? "Segoe UI Semibold" : "Segoe UI", 10f);
      button.UseVisualStyleBackColor = false;
      button.Cursor = Cursors.Hand;
      return button;
    }

    // The answer buttons, right-aligned under the box's content, the first added rightmost.
    public static FlowLayoutPanel Buttons() {
      FlowLayoutPanel row = new FlowLayoutPanel();
      row.FlowDirection = FlowDirection.RightToLeft;
      row.AutoSize = true;
      row.AutoSizeMode = AutoSizeMode.GrowAndShrink;
      row.MinimumSize = new Size(S(WIDTH), 0);
      row.Margin = new Padding(0);
      return row;
    }

    public static void Add(FlowLayoutPanel row, Button button) {
      button.Margin = new Padding(S(8), 0, 0, 0);
      row.Controls.Add(button);
    }

    // The content inside the form's padding: an AutoSize form pads the right and bottom of what it holds, never the
    // left and top, so the column is placed there itself.
    public static void Hold(Form form, Control column) {
      column.Location = new Point(form.Padding.Left, form.Padding.Top);
      form.Controls.Add(column);
    }
  }

  // Each box is built by Build and shown by Ask, so a test can draw one without putting it on anybody's screen. The
  // answer's controls are found by name: "answer", and for the type-once box "user" and "keep".
  public static class Passphrase {
    // The recovery key box: what is asked as its heading, why under it, what went wrong with the last try (when it did)
    // in red, and one field shaped like the key.
    // asks: "recovery-key" (a field shaped like the key), "master-password", or "either" (consent.ts PassphraseAsks).
    public static Form Build(string title, string message, string problem, string asks) {
      Form form = Look.NewForm();
      FlowLayoutPanel panel = Look.Column();
      panel.Controls.Add(Look.Heading(title));
      panel.Controls.Add(Look.Body(message));
      if (!String.IsNullOrEmpty(problem)) panel.Controls.Add(Look.Problem(problem));
      bool key = asks != "master-password" && asks != "either";
      panel.Controls.Add(Look.FieldLabel(key ? "Recovery key" : asks == "either" ? "Master password or recovery key" : "Master password"));
      TextBox box = Look.Field(true, key, key ? "XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX" : null);
      box.Name = "answer";
      panel.Controls.Add(box);
      FlowLayoutPanel buttons = Look.Buttons();
      Button ok = Look.Action("Continue", true);
      ok.DialogResult = DialogResult.OK;
      Button cancel = Look.Action("Cancel", false);
      cancel.DialogResult = DialogResult.Cancel;
      Look.Add(buttons, ok);
      Look.Add(buttons, cancel);
      panel.Controls.Add(buttons);
      Look.Hold(form, panel);
      form.AcceptButton = ok;
      form.CancelButton = cancel;
      return form;
    }

    public static string Ask(string title, string message, string problem, string asks, int seconds) {
      Look.Begin();
      Form form = Build(title, message, problem, asks);
      TextBox box = (TextBox)form.Controls.Find("answer", true)[0];
      System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
      timer.Interval = seconds * 1000;
      timer.Tick += delegate(object sender, EventArgs e) { form.DialogResult = DialogResult.Cancel; form.Close(); };
      form.Shown += delegate(object sender, EventArgs e) { Reveal.Show(form); box.Focus(); timer.Start(); };
      DialogResult result = form.ShowDialog();
      timer.Stop();
      return result == DialogResult.OK ? box.Text : null;
    }
  }

  // The type-once box: a value (hidden) and, when asked for, a user name, with a "Remember it" tick. Answers null on
  // Cancel, else the three joined by NUL (user, remember, value), which none of them holds.
  public static class ValueBox {
    public static Form Build(string title, string message, bool remember, bool askUser, string user) {
      Form form = Look.NewForm();
      FlowLayoutPanel panel = Look.Column();
      panel.Controls.Add(Look.Heading(title));
      panel.Controls.Add(Look.Body(message));
      TextBox userBox = Look.Field(false, false, null);
      userBox.Name = "user";
      userBox.Text = user == null ? "" : user;
      if (askUser) {
        panel.Controls.Add(Look.FieldLabel("User name"));
        panel.Controls.Add(userBox);
      }
      panel.Controls.Add(Look.FieldLabel("Password"));
      TextBox box = Look.Field(true, false, null);
      box.Name = "answer";
      box.Margin = new Padding(0, 0, 0, Look.S(10));
      panel.Controls.Add(box);
      CheckBox keep = Look.Tick("Remember it", remember);
      keep.Name = "keep";
      panel.Controls.Add(keep);
      FlowLayoutPanel buttons = Look.Buttons();
      Button ok = Look.Action("OK", true);
      ok.DialogResult = DialogResult.OK;
      Button cancel = Look.Action("Cancel", false);
      cancel.DialogResult = DialogResult.Cancel;
      Look.Add(buttons, ok);
      Look.Add(buttons, cancel);
      panel.Controls.Add(buttons);
      Look.Hold(form, panel);
      form.AcceptButton = ok;
      form.CancelButton = cancel;
      // Kept on the form even when not shown, so Ask reads one control either way.
      form.Tag = userBox;
      return form;
    }

    public static string Ask(string title, string message, bool remember, bool askUser, string user, int seconds) {
      Look.Begin();
      Form form = Build(title, message, remember, askUser, user);
      TextBox userBox = (TextBox)form.Tag;
      TextBox box = (TextBox)form.Controls.Find("answer", true)[0];
      CheckBox keep = (CheckBox)form.Controls.Find("keep", true)[0];
      System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
      timer.Interval = seconds * 1000;
      timer.Tick += delegate(object sender, EventArgs e) { form.DialogResult = DialogResult.Cancel; form.Close(); };
      form.Shown += delegate(object sender, EventArgs e) { Reveal.Show(form); if (askUser && userBox.Text == "") userBox.Focus(); else box.Focus(); timer.Start(); };
      DialogResult result = form.ShowDialog();
      timer.Stop();
      if (result != DialogResult.OK || box.Text == "") return null;
      return userBox.Text + "\0" + (keep.Checked ? "1" : "0") + "\0" + box.Text;
    }
  }

  // A few buttons, one per answer, in the order given, none of them louder than another. Answers the chosen one's
  // index, or -1 on Cancel or time out; the form's Tag holds it while it is open.
  public static class Choice {
    public static Form Build(string title, string message, string[] labels) {
      Form form = Look.NewForm();
      form.Tag = -1;
      FlowLayoutPanel panel = Look.Column();
      panel.Controls.Add(Look.Heading(title));
      panel.Controls.Add(Look.Body(message));
      FlowLayoutPanel buttons = new FlowLayoutPanel();
      buttons.AutoSize = true;
      buttons.AutoSizeMode = AutoSizeMode.GrowAndShrink;
      buttons.MaximumSize = new Size(Look.S(Look.WIDTH), 0);
      buttons.Margin = new Padding(0);
      for (int i = 0; i < labels.Length; i++) {
        Button button = Look.Action(labels[i], false);
        // Narrower than an answer button, so the usual four (Allow once … Deny) sit in one row.
        button.MinimumSize = new Size(Look.S(72), Look.S(34));
        button.Padding = new Padding(Look.S(6), 0, Look.S(6), 0);
        button.Margin = new Padding(0, 0, Look.S(8), Look.S(8));
        int index = i;
        button.Click += delegate(object sender, EventArgs e) { form.Tag = index; form.Close(); };
        buttons.Controls.Add(button);
      }
      panel.Controls.Add(buttons);
      Look.Hold(form, panel);
      return form;
    }

    public static int Ask(string title, string message, string[] labels, int seconds) {
      Look.Begin();
      Form form = Build(title, message, labels);
      System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
      timer.Interval = seconds * 1000;
      timer.Tick += delegate(object sender, EventArgs e) { form.Tag = -1; form.Close(); };
      form.Shown += delegate(object sender, EventArgs e) { Reveal.Show(form); timer.Start(); };
      form.ShowDialog();
      timer.Stop();
      return (int)form.Tag;
    }
  }
}
`;

const PREAMBLE = `
$ErrorActionPreference = 'Stop'
function Answer($o) { [Console]::Out.WriteLine('intentic-keyring>' + ($o | ConvertTo-Json -Compress)) }
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @'
${FORMS}
'@
`;

// The Hello script: one of `available`, `enrol`, `sign` or `verify`, as $KeyringInput.op says. A challenge travels as
// standard base64, which is what [Convert] reads.
const HELLO_SCRIPT = `${PREAMBLE}
${WINRT_AWAIT}
[Windows.Security.Credentials.KeyCredentialManager,Windows.Security.Credentials,ContentType=WindowsRuntime] | Out-Null
[Windows.Security.Credentials.UI.UserConsentVerifier,Windows.Security.Credentials.UI,ContentType=WindowsRuntime] | Out-Null
[Windows.Security.Cryptography.Core.CryptographicPublicKeyBlobType,Windows.Security.Cryptography.Core,ContentType=WindowsRuntime] | Out-Null
$buffers = [System.Runtime.InteropServices.WindowsRuntime.WindowsRuntimeBufferExtensions]
function SignWith($credential) {
  $challenge = $buffers::AsBuffer([Convert]::FromBase64String($KeyringInput.challenge))
  $signed = Await ($credential.RequestSignAsync($challenge)) ([Windows.Security.Credentials.KeyCredentialOperationResult])
  if ([string]$signed.Status -ne 'Success') { return @{ ok = $false; status = [string]$signed.Status } }
  return @{ ok = $true; signature = [Convert]::ToBase64String($buffers::ToArray($signed.Result)) }
}
try {
  $op = $KeyringInput.op
  if ($op -eq 'available') {
    $supported = Await ([Windows.Security.Credentials.KeyCredentialManager]::IsSupportedAsync()) ([bool])
    $verifier = Await ([Windows.Security.Credentials.UI.UserConsentVerifier]::CheckAvailabilityAsync()) ([Windows.Security.Credentials.UI.UserConsentVerifierAvailability])
    Answer @{ ok = $true; supported = [bool]$supported; status = [string]$verifier }
  } elseif ($op -eq 'verify') {
    $result = Await ([Windows.Security.Credentials.UI.UserConsentVerifier]::RequestVerificationAsync($KeyringInput.message)) ([Windows.Security.Credentials.UI.UserConsentVerificationResult])
    Answer @{ ok = ([string]$result -eq 'Verified'); status = [string]$result }
  } else {
    if ($op -eq 'enrol') {
      $made = Await ([Windows.Security.Credentials.KeyCredentialManager]::RequestCreateAsync($KeyringInput.credential, [Windows.Security.Credentials.KeyCredentialCreationOption]::ReplaceExisting)) ([Windows.Security.Credentials.KeyCredentialRetrievalResult])
      if ([string]$made.Status -ne 'Success') { Answer @{ ok = $false; status = [string]$made.Status } } else {
        $answer = SignWith $made.Credential
        # X.509 SubjectPublicKeyInfo, which the protected service reads with node:crypto to check later signatures.
        $answer.publicKey = [Convert]::ToBase64String($buffers::ToArray($made.Credential.RetrievePublicKey([Windows.Security.Cryptography.Core.CryptographicPublicKeyBlobType]::X509SubjectPublicKeyInfo)))
        Answer $answer
      }
    } else {
      $opened = Await ([Windows.Security.Credentials.KeyCredentialManager]::OpenAsync($KeyringInput.credential)) ([Windows.Security.Credentials.KeyCredentialRetrievalResult])
      if ([string]$opened.Status -ne 'Success') { Answer @{ ok = $false; status = [string]$opened.Status } } else { Answer (SignWith $opened.Credential) }
    }
  }
} catch {
  Answer @{ ok = $false; error = $_.Exception.Message }
}
`;

const PASSPHRASE_SCRIPT = `${PREAMBLE}
try {
  $typed = [IntenticKeyring.Passphrase]::Ask($KeyringInput.title, $KeyringInput.message, [string]$KeyringInput.problem, [string]$KeyringInput.asks, [int]$KeyringInput.seconds)
  if ($typed -eq $null) { Answer @{ ok = $false; cancelled = $true } } else { Answer @{ ok = $true; passphrase = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($typed)) } }
} catch {
  Answer @{ ok = $false; error = $_.Exception.Message }
}
`;

const VALUE_SCRIPT = `${PREAMBLE}
try {
  $typed = [IntenticKeyring.ValueBox]::Ask($KeyringInput.title, $KeyringInput.message, $KeyringInput.remember -eq '1', $KeyringInput.askUser -eq '1', $KeyringInput.user, [int]$KeyringInput.seconds)
  if ($typed -eq $null) { Answer @{ ok = $false; cancelled = $true } } else { Answer @{ ok = $true; passphrase = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($typed)) } }
} catch {
  Answer @{ ok = $false; error = $_.Exception.Message }
}
`;

const CHOICE_SCRIPT = `${PREAMBLE}
try {
  $index = [IntenticKeyring.Choice]::Ask($KeyringInput.title, $KeyringInput.message, [string[]]($KeyringInput.labels -split "\n"), [int]$KeyringInput.seconds)
  if ($index -lt 0) { Answer @{ ok = $false; cancelled = $true } } else { Answer @{ ok = $true; status = [string]$index } }
} catch {
  Answer @{ ok = $false; error = $_.Exception.Message }
}
`;

const AnswerSchema = z.object({
    ok: z.boolean(),
    supported: z.boolean().optional(),
    status: z.string().optional(),
    error: z.string().optional(),
    signature: z.string().optional(),
    publicKey: z.string().optional(),
    passphrase: z.string().optional(),
    cancelled: z.boolean().optional(),
});
type Answer = z.infer<typeof AnswerSchema>;

// The statuses that mean the person turned the prompt down, rather than Hello being unable to ask.
const CANCELLED = new Set(["UserCanceled", "Canceled"]);

const failed = <T>(answer: Answer): HelloResult<T> => ({
    ok: false,
    cancelled: answer.status !== undefined && CANCELLED.has(answer.status),
    reason: answer.error ?? `Windows Hello answered ${answer.status ?? "without a status"}`,
});

const base64 = (text: string | undefined): Buffer | undefined => (text === undefined || !/^[A-Za-z0-9+/=]+$/u.test(text) ? undefined : Buffer.from(text, "base64"));
// The keyring keeps challenges as base64url; [Convert] reads standard base64.
const standardBase64 = (challenge: string): string => Buffer.from(challenge, "base64url").toString("base64");

export const windowsHello = (runner: Runner, now: () => number = Date.now): HelloDriver => {
    let known: { readonly at: number; readonly available: boolean } | undefined;
    const hello = async (input: Readonly<Record<string, string>>): Promise<HelloResult<Answer>> => {
        const ran = await runPowerShell(runner, { script: HELLO_SCRIPT, input, timeoutMs: PROMPT_TIMEOUT_MS }, AnswerSchema);
        return ran.ok ? { ok: true, value: ran.answer } : { ok: false, cancelled: false, reason: ran.reason };
    };
    return {
        available: async () => {
            if (known !== undefined && now() - known.at < AVAILABLE_FOR_MS) {
                return known.available;
            }
            const asked = await hello({ op: "available" });
            const available = asked.ok && asked.value.ok && asked.value.supported === true;
            known = { at: now(), available };
            return available;
        },
        enrol: async (credential, challenge) => {
            const asked = await hello({ op: "enrol", credential, challenge: standardBase64(challenge) });
            if (!asked.ok) {
                return asked;
            }
            const signature = base64(asked.value.signature);
            const publicKey = asked.value.publicKey;
            return asked.value.ok && signature !== undefined && publicKey !== undefined ? { ok: true, value: { signature, publicKey } } : failed(asked.value);
        },
        sign: async (credential, challenge) => {
            const asked = await hello({ op: "sign", credential, challenge: standardBase64(challenge) });
            if (!asked.ok) {
                return asked;
            }
            const signature = base64(asked.value.signature);
            return asked.value.ok && signature !== undefined ? { ok: true, value: signature } : failed(asked.value);
        },
        verify: async (notice) => {
            const asked = await hello({ op: "verify", message: `${notice.title}\n\n${notice.message}` });
            if (!asked.ok) {
                return asked;
            }
            return asked.value.ok ? { ok: true, value: true } : failed(asked.value);
        },
    };
};

const dialogSeconds = String(Math.floor(PROMPT_TIMEOUT_MS / 1000) - 5);

export const windowsPassphrasePrompt =
    (runner: Runner): PassphrasePrompt =>
    async (notice) => {
        const ran = await runPowerShell(
            runner,
            { script: PASSPHRASE_SCRIPT, input: { title: notice.title, message: notice.message, problem: notice.problem ?? "", asks: notice.asks ?? "recovery-key", seconds: dialogSeconds }, timeoutMs: PROMPT_TIMEOUT_MS },
            AnswerSchema,
        );
        if (!ran.ok) {
            return { kind: "unavailable", reason: ran.reason };
        }
        if (ran.answer.ok) {
            const typed = base64(ran.answer.passphrase);
            return typed === undefined ? { kind: "unavailable", reason: "the passphrase dialog answered with nothing" } : { kind: "answered", passphrase: typed.toString("utf8") };
        }
        return ran.answer.cancelled === true ? { kind: "cancelled" } : { kind: "unavailable", reason: ran.answer.error ?? "the passphrase dialog failed" };
    };

// The type-once box (consent.ts ValuePrompt): the value comes back base64 inside the helper's JSON, never on a command
// line, together with the user name and the Remember tick.
export const windowsValuePrompt =
    (runner: Runner): ValuePrompt =>
    async (notice) => {
        const input = {
            title: notice.title,
            message: notice.message,
            remember: notice.remember ? "1" : "0",
            askUser: notice.username === undefined ? "0" : "1",
            user: notice.username?.value ?? "",
            seconds: dialogSeconds,
        };
        const ran = await runPowerShell(runner, { script: VALUE_SCRIPT, input, timeoutMs: PROMPT_TIMEOUT_MS }, AnswerSchema);
        if (!ran.ok) {
            return { kind: "unavailable", reason: ran.reason };
        }
        if (!ran.answer.ok) {
            return ran.answer.cancelled === true ? { kind: "cancelled" } : { kind: "unavailable", reason: ran.answer.error ?? "the box failed" };
        }
        const [user = "", remember = "0", ...rest] = (base64(ran.answer.passphrase)?.toString("utf8") ?? "").split("\0");
        const value = rest.join("\0");
        if (value === "") {
            return { kind: "cancelled" };
        }
        return user === "" ? { kind: "answered", value, remember: remember === "1" } : { kind: "answered", value, remember: remember === "1", username: user };
    };

// The choice dialog (consent.ts ChoicePrompt): one button per answer.
export const windowsChoicePrompt =
    (runner: Runner): ChoicePrompt =>
    async (notice) => {
        const input = { title: notice.title, message: notice.message, labels: notice.choices.map((choice) => choice.label.replace(/\n/gu, " ")).join("\n"), seconds: dialogSeconds };
        const ran = await runPowerShell(runner, { script: CHOICE_SCRIPT, input, timeoutMs: PROMPT_TIMEOUT_MS }, AnswerSchema);
        if (!ran.ok) {
            return { kind: "unavailable", reason: ran.reason };
        }
        const chosen = ran.answer.ok ? notice.choices[Number(ran.answer.status)] : undefined;
        if (chosen !== undefined) {
            return { kind: "chosen", id: chosen.id };
        }
        return ran.answer.cancelled === true || ran.answer.ok ? { kind: "cancelled" } : { kind: "unavailable", reason: ran.answer.error ?? "the dialog failed" };
    };
