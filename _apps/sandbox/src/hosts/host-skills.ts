import type { HostPlatform } from "@intentic/sandbox-contract";

/* The SKILL.md a connected computer installs into .claude/skills/<id>/ — the reason this is one capability PER
 * MACHINE rather than one "computers" capability with a list.
 *
 * A skill is context, and context is not free: teaching an agent PowerShell quoting on a turn where the only
 * connected machine runs Ubuntu costs tokens and invites `osascript`-shaped nonsense. So each machine installs
 * exactly its own platform's pack, and the pack is written for THIS machine — the tool names are already
 * namespaced with its id, so the examples are copy-pasteable rather than illustrative.
 *
 * What goes in a pack is chosen by what the model gets WRONG unaided, not by what is documentable:
 *   - which shell it is actually talking to (the single biggest source of failed first commands),
 *   - how to do a job in ONE call instead of ten (every call is a round trip through a tunnel to a laptop),
 *   - the platform's non-obvious spellings (utf8 encoding on Windows, Wayland vs X11 clipboards on Linux),
 *   - and what to do when a call is REFUSED, which is a scope decision the user made, not an error to retry. */

const SHARED = (id: string, machine: string): string => `# ${machine} — connected computer "${id}"

This is a real computer belonging to the person you are working for. It is not the sandbox: the sandbox is where
you live and where the repository is; this is their own machine, reached over a socket it opened to us.

## Tools

| Tool | What it does |
| --- | --- |
| \`mcp__${id}__describe\` | This machine's OS, shell, home directory, and the roots you may touch. |
| \`mcp__${id}__run_command\` | Run a command and get stdout/stderr/exit code back. |
| \`mcp__${id}__read_file\` | Read a file under the allowed roots. |
| \`mcp__${id}__write_file\` | Create or overwrite a file under the allowed roots. |
| \`mcp__${id}__list_dir\` | List a directory under the allowed roots. |
| \`mcp__${id}__trash_file\` | Move a file to the recycle bin / trash — there is no delete tool, on purpose. |
| \`mcp__${id}__screenshot\` | Capture the screen as an image. |

## Rules that are not negotiable

1. **Call \`describe\` first**, once, before your first command on this machine. It tells you the OS build, the
   shell you are actually talking to, and the directories you may read and write. Do not guess any of them.
2. **The user's machine is not a scratch pad.** Before anything that deletes, overwrites, installs, uninstalls,
   changes system settings, or touches a file you did not create, say what you are about to do and get a yes.
   Reading, listing and screenshots need no ceremony.
3. **A refusal is an answer.** If a call comes back saying a scope is off or a path is outside the allowed roots,
   that is the owner's decision, not a transient failure. Tell them which switch to flip on the capability card.
   Never look for a way around it — there isn't one, and trying reads as an attack.
4. **One call, not ten.** Every call is a round trip to a machine that may be on hotel wifi. Write a small script
   and run it once instead of chaining ten commands and reasoning between each.
5. **Never paste a secret into a command.** Command lines are visible in the machine's process list and are
   written to this machine's audit log.
6. **If the machine is offline** the tool says so plainly. It means a closed lid or a dropped network — report it,
   do not retry in a loop.
`;

const WINDOWS = `## This machine runs Windows

\`run_command\` gives you **PowerShell 7** (\`pwsh\`) when it is installed, otherwise Windows PowerShell 5.1. Both
are PowerShell — \`cmd.exe\` builtins (\`dir /s\`, \`copy\`, \`&&\`) are not what you are typing into.

### Quoting and paths
- Paths with spaces: \`& "C:\\Program Files\\Git\\bin\\git.exe" status\`. The \`&\` call operator is required whenever
  the command itself is quoted.
- Prefer forward slashes in arguments you pass to cross-platform tools; PowerShell accepts both.
- \`$env:USERPROFILE\`, \`$env:APPDATA\`, \`$env:LOCALAPPDATA\` — use these, never a hardcoded \`C:\\Users\\<name>\`.
- Chain with \`;\` (always runs) or \`-and\`; \`&&\` works only in PowerShell 7.

### Exit codes
A failing native program does NOT stop a PowerShell script. Check \`$LASTEXITCODE\` after native commands, and
start scripts with \`$ErrorActionPreference = 'Stop'\` so cmdlet failures surface instead of scrolling past.

### The idioms worth knowing
| Job | Command |
| --- | --- |
| Find files | \`Get-ChildItem -Recurse -Filter *.log -ErrorAction SilentlyContinue\` |
| Search text | \`Select-String -Path *.txt -Pattern 'needle'\` |
| Read/write text | \`Get-Content f.txt -Raw\` / \`Set-Content f.txt -Value $x -Encoding utf8\` |
| Processes | \`Get-Process node\`, \`Stop-Process -Name node -Force\` |
| Services | \`Get-Service Spooler\`, \`Restart-Service Spooler\` (elevation needed) |
| Installed apps | \`winget list\`, install with \`winget install --id Git.Git -e --silent\` |
| Scheduled tasks | \`Get-ScheduledTask\`, \`Register-ScheduledTask\` |
| Open something | \`Start-Process notepad.exe\`, \`Start-Process https://example.com\` |
| Clipboard | \`Get-Clipboard\` / \`Set-Clipboard -Value 'text'\` |
| Registry | \`Get-ItemProperty 'HKCU:\\Software\\...'\` |
| JSON | \`Get-Content x.json | ConvertFrom-Json\`, \`$obj | ConvertTo-Json -Depth 10\` |
| WSL | \`wsl -d Ubuntu -- bash -lc 'uname -a'\` |

### Office and other COM apps
Outlook, Excel and Word are reachable through COM when the app is installed and the user is signed in:
\`\`\`powershell
$outlook = New-Object -ComObject Outlook.Application
$inbox = $outlook.Session.GetDefaultFolder(6)   # 6 = olFolderInbox
$inbox.Items | Select-Object -First 5 Subject, SenderName, ReceivedTime
\`\`\`
COM objects hold the app open — finish with \`[System.Runtime.InteropServices.Marshal]::ReleaseComObject($x)\`.

### Elevation
You are running as the logged-in user, NOT as administrator, and \`Start-Process -Verb RunAs\` pops a UAC prompt
on the user's screen that they must click. Say so before you try it; do not fire UAC prompts at somebody
unannounced.
`;

const LINUX = `## This machine runs Linux

\`run_command\` gives you the user's login shell through \`sh -lc\`, so their PATH, aliases from profile files, and
version managers (nvm, asdf, mise) are in scope — but this is a DESKTOP session, not a server: a graphical
session is usually alive, and that is what makes the GUI idioms below work.

### Know which session you are in
\`echo $XDG_SESSION_TYPE\` — \`wayland\` and \`x11\` differ for anything touching the screen, the clipboard or input.
Get this once from \`describe\` (it reports it) rather than assuming X11.

### The idioms worth knowing
| Job | Command |
| --- | --- |
| Find files | \`find ~ -name '*.log' -type f 2>/dev/null\` (or \`fd\` when installed) |
| Search text | \`grep -rn 'needle' ~/dir\` (or \`rg\`) |
| Which package manager | \`command -v apt dnf pacman zypper apk\` — never assume apt |
| Install | \`sudo apt-get install -y <pkg>\` — sudo may prompt; see below |
| User services | \`systemctl --user status <unit>\`, \`journalctl --user -u <unit> -n 100\` |
| System services | \`systemctl status <unit>\`, \`journalctl -u <unit> -n 100\` |
| Open a file/URL | \`xdg-open <path-or-url>\` |
| Clipboard (Wayland) | \`wl-copy < file\` / \`wl-paste\` |
| Clipboard (X11) | \`xclip -selection clipboard -i\` / \`-o\` |
| Notify the user | \`notify-send 'title' 'body'\` |
| Disk / memory | \`df -h\`, \`free -h\`, \`lsblk\` |
| What's listening | \`ss -tlnp\` |

### sudo
Assume there is **no** passwordless sudo. A \`sudo\` command that needs a password will hang until it times out —
there is no terminal for the user to type into. Run \`sudo -n true\` first: if it fails, ask the user to run the
privileged command themselves, and hand them the exact line to paste.

### Long-running things
\`run_command\` waits for the command to exit. For anything that should outlive the call, start it detached
(\`systemd-run --user --unit=<name> <cmd>\`, or \`nohup <cmd> >~/log 2>&1 &\`) and poll its log with a later call.
`;

const PACKS: Record<HostPlatform, { readonly machine: string; readonly body: string }> = {
    windows: { machine: "Windows", body: WINDOWS },
    linux: { machine: "Linux", body: LINUX },
};

// The skill's frontmatter name is the capability id, so two connected machines never register the same skill —
// the browser capability's rule, for the same reason. The description is what decides whether the agent reaches
// for this machine at all, so it names the machine AND the verbs a user would say.
export const hostSkill = (id: string, platform: HostPlatform): string => {
    const pack = PACKS[platform];
    return `---
name: ${id}
description: Operate "${id}", the user's own ${pack.machine} computer — run commands, read and write files, capture its screen. Use whenever the user says "my machine", "my laptop", "my PC", "my desktop", "locally", or names this computer, and for anything that has to happen on their computer rather than in the sandbox.
---

${SHARED(id, pack.machine)}
${pack.body}`;
};
