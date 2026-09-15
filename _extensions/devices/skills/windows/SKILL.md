---
name: windows
description: Operate "${id}", the user's own Windows device: run commands, read and write files, capture its screen. Use whenever the user says "my machine", "my laptop", "my PC", "locally", or names this device, and for anything that must happen on their device rather than in the sandbox.
---

${tools}
## This machine runs Windows

`run_command` gives you **PowerShell 7** (`pwsh`) when it is installed, otherwise Windows PowerShell 5.1. Both
are PowerShell: `cmd.exe` builtins (`dir /s`, `copy`, `&&`) are not what you are typing into.

### Quoting and paths
- Paths with spaces: `& "C:\Program Files\Git\bin\git.exe" status`. The `&` call operator is required whenever
  the command itself is quoted.
- Prefer forward slashes in arguments you pass to cross-platform tools; PowerShell accepts both.
- `$env:USERPROFILE`, `$env:APPDATA`, `$env:LOCALAPPDATA`: use these, never a hardcoded `C:\Users\<name>`.
- Chain with `;` (always runs) or `-and`; `&&` works only in PowerShell 7.

### Exit codes
A failing native program does NOT stop a PowerShell script. Check `$LASTEXITCODE` after native commands, and
start scripts with `$ErrorActionPreference = 'Stop'` so cmdlet failures surface instead of scrolling past.

### The idioms worth knowing
| Job | Command |
| --- | --- |
| Find files | `Get-ChildItem -Recurse -Filter *.log -ErrorAction SilentlyContinue` |
| Search text | `Select-String -Path *.txt -Pattern 'needle'` |
| Read/write text | `Get-Content f.txt -Raw` / `Set-Content f.txt -Value $x -Encoding utf8` |
| Processes | `Get-Process node`, `Stop-Process -Name node -Force` |
| Services | `Get-Service Spooler`, `Restart-Service Spooler` (elevation needed) |
| Installed apps | `winget list`, install with `winget install --id Git.Git -e --silent` |
| Scheduled tasks | `Get-ScheduledTask`, `Register-ScheduledTask` |
| Open something | `Start-Process notepad.exe`, `Start-Process https://example.com` |
| Clipboard | `Get-Clipboard` / `Set-Clipboard -Value 'text'` |
| Registry | `Get-ItemProperty 'HKCU:\Software\...'` |
| JSON | `Get-Content x.json | ConvertFrom-Json`, `$obj | ConvertTo-Json -Depth 10` |
| WSL | `wsl -l -v` lists the distros; running inside one is `in:` below, not a `wsl` command |

### WSL distros on this PC
`describe` lists them ("WSL distros on this PC: Arch, Ubuntu-22.04"). Each is a Linux install sharing this PC's
hardware, Docker engine and hostname, with its own filesystem and its own shell.

- **Run a Linux command inside one** with `run_command` and `in: "wsl:<name>"` (or `in: "wsl"` for the default
  distro). The command runs through `sh -lc` in that distro and never passes through PowerShell, so write plain sh:
  no `wsl -d … -- bash -lc '…'` and no PowerShell quoting of a Linux command. `cwd` is then a Linux path; it
  defaults to the distro's home.
- **One folder, two names.** This PC's drives are under `/mnt` in a distro (`C:\Users\you` is `/mnt/c/Users/you`);
  a distro's files are under `\\wsl.localhost\<name>\` from here (`/home/you` is `\\wsl.localhost\Arch\home\you`).
  Prefer working on files from the side they live on: cross-boundary file access is slow and drops permissions.
- **One Docker engine.** Docker Desktop's containers are the same list from here and from any distro, so
  `list_sandboxes` agrees on both sides and a sandbox is managed through whichever door is open.
- **If a distro is also connected as its own device** (the prompt says which ids are one computer), prefer that
  door for Linux work: its own login shell, PATH and tools, and the same permissions the owner set for it. This
  door owns the screen, the GUI, the clipboard and PowerShell.

### Office and other COM apps
Outlook, Excel and Word are reachable through COM when the app is installed and the user is signed in:
```powershell
$outlook = New-Object -ComObject Outlook.Application
$inbox = $outlook.Session.GetDefaultFolder(6)   # 6 = olFolderInbox
$inbox.Items | Select-Object -First 5 Subject, SenderName, ReceivedTime
```
COM objects hold the app open: finish with `[System.Runtime.InteropServices.Marshal]::ReleaseComObject($x)`.

### Driving the Windows GUI
Input goes through user32 (`SendInput`-class calls), so it behaves like a real keyboard and mouse: including
that it lands on **whatever window has focus**. `Start-Process` then a click on the new window is more reliable
than assuming focus followed. `super+e` opens Explorer, `super+r` the Run box; both work here even though
Windows' own SendKeys cannot press that key.

A UAC prompt appears on a SECURE DESKTOP that no injected input can reach: if one opens, the GUI route is over
and the user has to click it themselves. Say so rather than retrying.

### Elevation
You are running as the logged-in user, NOT as administrator, and `Start-Process -Verb RunAs` pops a UAC prompt
on the user's screen that they must click. Say so before you try it; do not fire UAC prompts at somebody
unannounced.

### Two filesystems, and which tool for which job
- **Their device is not this sandbox.** A file you create here does not exist there; a path they name
  (`C:\Users\…`, `~\Documents`) is on their device; a command or path you put in their clipboard or type
  into their app must exist on their side. Move bytes explicitly (`write_file`, `read_file`), never assume.
- **Pick the tool by what the target is.** An app with its own capability card (mail, calendar, a service API)
  is fastest and most precise; a web app goes through a browser (theirs via the chrome skill, or the sandbox's
  own); this skill is for native desktop apps and cross-app work, which no connector reaches. A connector that
  errors is debugged or reported, not silently retried through a slower tier.
- **Look before asserting.** Asked what is open, what an app can do, or whether something is installed: take a
  screenshot or run the command and answer from what you saw, not from memory. Their setup and versions differ
  from the ones you expect, and "that app can't do that" grounded in nothing is the wrong answer more often
  than not. Do not describe the screen, or call the machine reachable, until a call has succeeded.
