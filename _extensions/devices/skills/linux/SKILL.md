---
name: linux
description: Operate "${id}", the user's own Linux device, run commands, read and write files, capture its screen. Use whenever the user says "my machine", "my laptop", "my PC", "my desktop", "locally", or names this device, and for anything that has to happen on their own device rather than in the sandbox.
---

${tools}
## This machine runs Linux

`run_command` gives you the user's login shell through `sh -lc`, so their PATH, aliases from profile files, and
version managers (nvm, asdf, mise) are in scope, but this is a DESKTOP session, not a server: a graphical
session is usually alive, and that is what makes the GUI idioms below work.

### Know which session you are in
`echo $XDG_SESSION_TYPE`: `wayland` and `x11` differ for anything touching the screen, the clipboard or input.
Get this once from `describe` (it reports it) rather than assuming X11.

### The idioms worth knowing
| Job | Command |
| --- | --- |
| Find files | `find ~ -name '*.log' -type f 2>/dev/null` (or `fd` when installed) |
| Search text | `grep -rn 'needle' ~/dir` (or `rg`) |
| Which package manager | `command -v apt dnf pacman zypper apk`: never assume apt |
| Install | `sudo apt-get install -y <pkg>`: sudo may prompt; see below |
| User services | `systemctl --user status <unit>`, `journalctl --user -u <unit> -n 100` |
| System services | `systemctl status <unit>`, `journalctl -u <unit> -n 100` |
| Open a file/URL | `xdg-open <path-or-url>` |
| Clipboard (Wayland) | `wl-copy < file` / `wl-paste` |
| Clipboard (X11) | `xclip -selection clipboard -i` / `-o` |
| Notify the user | `notify-send 'title' 'body'` |
| Disk / memory | `df -h`, `free -h`, `lsblk` |
| What's listening | `ss -tlnp` |

### sudo
Assume there is **no** passwordless sudo. A `sudo` command that needs a password will hang until it times out:
there is no terminal for the user to type into. Run `sudo -n true` first: if it fails, ask the user to run the
privileged command themselves, and hand them the exact line to paste.

### Driving the Linux GUI
Which tools are needed depends on the session `describe` reported:
- **X11**, everything runs through `xdotool`. One package, no permissions: `sudo apt install xdotool`.
- **Wayland**: the compositor refuses synthetic input by design, so pointer actions go through `ydotool` (which
  needs `/dev/uinput`: `sudo apt install ydotool` then `sudo usermod -aG input $USER`, and a re-login), and
  typing/keys prefer `wtype` (`sudo apt install wtype`), which needs no privileges.

When one is missing the tool says which and gives the exact install line: pass it on rather than concluding the
machine cannot be driven.

### Long-running things
`run_command` waits for the command to exit. For anything that should outlive the call, start it detached
(`systemd-run --user --unit=<name> <cmd>`, or `nohup <cmd> >~/log 2>&1 &`) and poll its log with a later call.

### Two filesystems, and which tool for which job
- **Their device is not this sandbox.** A file you create here does not exist there; a path they name
  (`~/Documents/…`) is on their device; a command or path you put in their clipboard or type into their app
  must exist on their side. Move bytes explicitly (`write_file`, `read_file`), never assume.
- **Pick the tool by what the target is.** An app with its own capability card (mail, calendar, a service API)
  is fastest and most precise; a web app goes through a browser (theirs via the chrome skill, or the sandbox's
  own); this skill is for native desktop apps and cross-app work, which no connector reaches. A connector that
  errors is debugged or reported, not silently retried through a slower tier.
- **Look before asserting.** Asked what is open, what an app can do, or whether something is installed: take a
  screenshot or run the command and answer from what you saw, not from memory. Their setup and versions differ
  from the ones you expect, and "that app can't do that" grounded in nothing is the wrong answer more often
  than not. Do not describe the screen, or call the machine reachable, until a call has succeeded.
