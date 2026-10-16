import { z } from "zod";
import type { HelloDriver, HelloResult, Notice, PassphrasePrompt } from "./consent.js";
import { runPowerShell, WINRT_AWAIT } from "../powershell.js";
import type { Runner } from "../run.js";

// Windows Hello and the passphrase dialog on Windows, through Windows PowerShell 5.1 (powershell.ts): KeyCredentialManager
// to create the keyring's credential and sign with it (RSA in the TPM, released by a Hello gesture), UserConsentVerifier
// for a plain yes while unlocked, and a WinForms password box. Hello's own prompt for a signature says only "make sure
// it's you", and one raised by a process with no window can open behind others, so a small topmost notice naming what is
// asked stays up while it waits.

// Long enough for a person to walk back to the computer; no longer than a grant lives.
const PROMPT_TIMEOUT_MS = 125_000;
// How long "is Hello set up here?" is believed: it changes only when the person sets Hello up or removes it.
const AVAILABLE_FOR_MS = 5 * 60_000;

// The notice and the password box, compiled by Add-Type: C# 5, the newest Windows PowerShell compiles.
const FORMS = String.raw`
using System;
using System.Drawing;
using System.Threading;
using System.Windows.Forms;

namespace IntenticKeyring {
  public class Notice {
    Form form;
    readonly ManualResetEvent shown = new ManualResetEvent(false);

    public static Notice Show(string title, string message) {
      Notice notice = new Notice();
      Thread thread = new Thread(delegate() { notice.Run(title, message); });
      thread.SetApartmentState(ApartmentState.STA);
      thread.IsBackground = true;
      thread.Start();
      notice.shown.WaitOne(5000);
      return notice;
    }

    void Run(string title, string message) {
      form = new Form();
      form.Text = "intentic keyring";
      form.FormBorderStyle = FormBorderStyle.FixedToolWindow;
      form.TopMost = true;
      form.ShowInTaskbar = false;
      form.StartPosition = FormStartPosition.Manual;
      form.AutoSize = true;
      form.AutoSizeMode = AutoSizeMode.GrowAndShrink;
      form.Padding = new Padding(16);
      FlowLayoutPanel panel = new FlowLayoutPanel();
      panel.FlowDirection = FlowDirection.TopDown;
      panel.AutoSize = true;
      Label heading = new Label();
      heading.Text = title;
      heading.AutoSize = true;
      heading.MaximumSize = new Size(480, 0);
      heading.Font = new Font("Segoe UI Semibold", 11f);
      Label body = new Label();
      body.Text = message + "\r\n\r\nWindows Hello asks for your gesture to answer it.";
      body.AutoSize = true;
      body.MaximumSize = new Size(480, 0);
      body.Font = new Font("Segoe UI", 9.5f);
      panel.Controls.Add(heading);
      panel.Controls.Add(body);
      form.Controls.Add(panel);
      form.Shown += delegate(object sender, EventArgs e) {
        Rectangle area = Screen.PrimaryScreen.WorkingArea;
        form.Location = new Point(area.X + (area.Width - form.Width) / 2, area.Y + 24);
        shown.Set();
      };
      Application.Run(form);
    }

    public void Close() {
      try { if (form != null && form.IsHandleCreated) form.BeginInvoke(new MethodInvoker(form.Close)); } catch (Exception) { } // allow(silent-catch): a notice already gone has nothing left to close
    }
  }

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
    $notice = [IntenticKeyring.Notice]::Show($KeyringInput.title, $KeyringInput.message)
    try {
      if ($op -eq 'enrol') {
        $made = Await ([Windows.Security.Credentials.KeyCredentialManager]::RequestCreateAsync($KeyringInput.credential, [Windows.Security.Credentials.KeyCredentialCreationOption]::ReplaceExisting)) ([Windows.Security.Credentials.KeyCredentialRetrievalResult])
        if ([string]$made.Status -ne 'Success') { Answer @{ ok = $false; status = [string]$made.Status } } else {
          $answer = SignWith $made.Credential
          # X.509 SubjectPublicKeyInfo, which hardened mode's service reads with node:crypto to check later signatures.
          $answer.publicKey = [Convert]::ToBase64String($buffers::ToArray($made.Credential.RetrievePublicKey([Windows.Security.Cryptography.Core.CryptographicPublicKeyBlobType]::X509SubjectPublicKeyInfo)))
          Answer $answer
        }
      } else {
        $opened = Await ([Windows.Security.Credentials.KeyCredentialManager]::OpenAsync($KeyringInput.credential)) ([Windows.Security.Credentials.KeyCredentialRetrievalResult])
        if ([string]$opened.Status -ne 'Success') { Answer @{ ok = $false; status = [string]$opened.Status } } else { Answer (SignWith $opened.Credential) }
      }
    } finally { $notice.Close() }
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
        enrol: async (credential, challenge, notice: Notice) => {
            const asked = await hello({ op: "enrol", credential, challenge: standardBase64(challenge), title: notice.title, message: notice.message });
            if (!asked.ok) {
                return asked;
            }
            const signature = base64(asked.value.signature);
            const publicKey = asked.value.publicKey;
            return asked.value.ok && signature !== undefined && publicKey !== undefined ? { ok: true, value: { signature, publicKey } } : failed(asked.value);
        },
        sign: async (credential, challenge, notice: Notice) => {
            const asked = await hello({ op: "sign", credential, challenge: standardBase64(challenge), title: notice.title, message: notice.message });
            if (!asked.ok) {
                return asked;
            }
            const signature = base64(asked.value.signature);
            return asked.value.ok && signature !== undefined ? { ok: true, value: signature } : failed(asked.value);
        },
        verify: async (notice: Notice) => {
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
