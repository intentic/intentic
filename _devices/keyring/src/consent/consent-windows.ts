import { z } from "zod";
import type { ChoicePrompt, HelloDriver, HelloResult, PassphrasePrompt, ValuePrompt } from "./consent.js";
import { runPowerShell, WINRT_AWAIT } from "../powershell.js";
import type { Runner } from "../run.js";

// Windows Hello and the passphrase dialog on Windows, through Windows PowerShell 5.1 (powershell.ts): KeyCredentialManager
// to create the keyring's credential and sign with it (RSA in the TPM, released by a Hello gesture), UserConsentVerifier
// for a plain yes while unlocked, a WinForms password box, and the Passwords app's type-once box and choice dialog.

// Long enough for a person to walk back to the computer; no longer than a grant lives.
const PROMPT_TIMEOUT_MS = 125_000;
// How long "is Hello set up here?" is believed: it changes only when the person sets Hello up or removes it.
const AVAILABLE_FOR_MS = 5 * 60_000;

// The password box, compiled by Add-Type: C# 5, the newest Windows PowerShell compiles.
const FORMS = String.raw`
using System;
using System.Drawing;
using System.Threading;
using System.Windows.Forms;

namespace IntenticKeyring {
  public static class Passphrase {
    public static string Ask(string title, string message, int seconds) {
      Application.EnableVisualStyles();
      Form form = new Form();
      form.Text = title;
      form.FormBorderStyle = FormBorderStyle.FixedDialog;
      form.MinimizeBox = false;
      form.MaximizeBox = false;
      form.TopMost = true;
      form.StartPosition = FormStartPosition.CenterScreen;
      form.AutoSize = true;
      form.AutoSizeMode = AutoSizeMode.GrowAndShrink;
      form.Padding = new Padding(16);
      FlowLayoutPanel panel = new FlowLayoutPanel();
      panel.FlowDirection = FlowDirection.TopDown;
      panel.AutoSize = true;
      Label body = new Label();
      body.Text = message + "\r\n\r\nThe keyring's passphrase:";
      body.AutoSize = true;
      body.MaximumSize = new Size(480, 0);
      TextBox box = new TextBox();
      box.UseSystemPasswordChar = true;
      box.Width = 320;
      FlowLayoutPanel buttons = new FlowLayoutPanel();
      buttons.AutoSize = true;
      Button ok = new Button();
      ok.Text = "OK";
      ok.DialogResult = DialogResult.OK;
      Button cancel = new Button();
      cancel.Text = "Cancel";
      cancel.DialogResult = DialogResult.Cancel;
      buttons.Controls.Add(ok);
      buttons.Controls.Add(cancel);
      panel.Controls.Add(body);
      panel.Controls.Add(box);
      panel.Controls.Add(buttons);
      form.Controls.Add(panel);
      form.AcceptButton = ok;
      form.CancelButton = cancel;
      System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
      timer.Interval = seconds * 1000;
      timer.Tick += delegate(object sender, EventArgs e) { form.DialogResult = DialogResult.Cancel; form.Close(); };
      form.Shown += delegate(object sender, EventArgs e) { form.Activate(); box.Focus(); timer.Start(); };
      DialogResult result = form.ShowDialog();
      timer.Stop();
      return result == DialogResult.OK ? box.Text : null;
    }
  }

  // The type-once box: a value (hidden) and, when asked for, a user name, with a "Remember it" tick. Answers null on
  // Cancel, else the three joined by NUL (user, remember, value), which none of them holds.
  public static class ValueBox {
    public static string Ask(string title, string message, bool remember, bool askUser, string user, int seconds) {
      Application.EnableVisualStyles();
      Form form = new Form();
      form.Text = title;
      form.FormBorderStyle = FormBorderStyle.FixedDialog;
      form.MinimizeBox = false;
      form.MaximizeBox = false;
      form.TopMost = true;
      form.StartPosition = FormStartPosition.CenterScreen;
      form.AutoSize = true;
      form.AutoSizeMode = AutoSizeMode.GrowAndShrink;
      form.Padding = new Padding(16);
      FlowLayoutPanel panel = new FlowLayoutPanel();
      panel.FlowDirection = FlowDirection.TopDown;
      panel.AutoSize = true;
      Label body = new Label();
      body.Text = message;
      body.AutoSize = true;
      body.MaximumSize = new Size(480, 0);
      panel.Controls.Add(body);
      TextBox userBox = new TextBox();
      userBox.Width = 320;
      userBox.Text = user == null ? "" : user;
      if (askUser) {
        Label userLabel = new Label();
        userLabel.Text = "User name:";
        userLabel.AutoSize = true;
        panel.Controls.Add(userLabel);
        panel.Controls.Add(userBox);
      }
      Label valueLabel = new Label();
      valueLabel.Text = "Password:";
      valueLabel.AutoSize = true;
      TextBox box = new TextBox();
      box.UseSystemPasswordChar = true;
      box.Width = 320;
      CheckBox keep = new CheckBox();
      keep.Text = "Remember it";
      keep.Checked = remember;
      keep.AutoSize = true;
      FlowLayoutPanel buttons = new FlowLayoutPanel();
      buttons.AutoSize = true;
      Button ok = new Button();
      ok.Text = "OK";
      ok.DialogResult = DialogResult.OK;
      Button cancel = new Button();
      cancel.Text = "Cancel";
      cancel.DialogResult = DialogResult.Cancel;
      buttons.Controls.Add(ok);
      buttons.Controls.Add(cancel);
      panel.Controls.Add(valueLabel);
      panel.Controls.Add(box);
      panel.Controls.Add(keep);
      panel.Controls.Add(buttons);
      form.Controls.Add(panel);
      form.AcceptButton = ok;
      form.CancelButton = cancel;
      System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
      timer.Interval = seconds * 1000;
      timer.Tick += delegate(object sender, EventArgs e) { form.DialogResult = DialogResult.Cancel; form.Close(); };
      form.Shown += delegate(object sender, EventArgs e) { form.Activate(); if (askUser && userBox.Text == "") userBox.Focus(); else box.Focus(); timer.Start(); };
      DialogResult result = form.ShowDialog();
      timer.Stop();
      if (result != DialogResult.OK || box.Text == "") return null;
      return userBox.Text + "\0" + (keep.Checked ? "1" : "0") + "\0" + box.Text;
    }
  }

  // A few buttons, one per answer, in the order given. Answers the chosen one's index, or -1 on Cancel or time out.
  public static class Choice {
    public static int Ask(string title, string message, string[] labels, int seconds) {
      Application.EnableVisualStyles();
      Form form = new Form();
      form.Text = title;
      form.FormBorderStyle = FormBorderStyle.FixedDialog;
      form.MinimizeBox = false;
      form.MaximizeBox = false;
      form.TopMost = true;
      form.StartPosition = FormStartPosition.CenterScreen;
      form.AutoSize = true;
      form.AutoSizeMode = AutoSizeMode.GrowAndShrink;
      form.Padding = new Padding(16);
      FlowLayoutPanel panel = new FlowLayoutPanel();
      panel.FlowDirection = FlowDirection.TopDown;
      panel.AutoSize = true;
      Label body = new Label();
      body.Text = message;
      body.AutoSize = true;
      body.MaximumSize = new Size(480, 0);
      panel.Controls.Add(body);
      FlowLayoutPanel buttons = new FlowLayoutPanel();
      buttons.AutoSize = true;
      int chosen = -1;
      for (int i = 0; i < labels.Length; i++) {
        Button button = new Button();
        button.Text = labels[i];
        button.AutoSize = true;
        int index = i;
        button.Click += delegate(object sender, EventArgs e) { chosen = index; form.Close(); };
        buttons.Controls.Add(button);
      }
      panel.Controls.Add(buttons);
      form.Controls.Add(panel);
      System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
      timer.Interval = seconds * 1000;
      timer.Tick += delegate(object sender, EventArgs e) { chosen = -1; form.Close(); };
      form.Shown += delegate(object sender, EventArgs e) { form.Activate(); timer.Start(); };
      form.ShowDialog();
      timer.Stop();
      return chosen;
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
  $typed = [IntenticKeyring.Passphrase]::Ask($KeyringInput.title, $KeyringInput.message, [int]$KeyringInput.seconds)
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

export const windowsPassphrasePrompt =
    (runner: Runner): PassphrasePrompt =>
    async (notice) => {
        const ran = await runPowerShell(
            runner,
            { script: PASSPHRASE_SCRIPT, input: { title: notice.title, message: notice.message, seconds: String(Math.floor(PROMPT_TIMEOUT_MS / 1000) - 5) }, timeoutMs: PROMPT_TIMEOUT_MS },
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

const dialogSeconds = String(Math.floor(PROMPT_TIMEOUT_MS / 1000) - 5);

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
