# @intentic/ext-devices

The user's own machines (Windows and Linux) as something the agent can operate.

## Responsibilities

- Declare the two machine capabilities.
- Ship the skill that teaches an agent to run commands, read files and drive the screen on each.

## Key files

- [intentic-extension.json](intentic-extension.json): the two capabilities. This file IS the package; there is no `src/`.
- [skills/linux](skills/linux): how an agent operates a Linux machine, and what changes when that Linux is a WSL distro of a Windows PC.
- [skills/windows](skills/windows): the same for Windows, where the two genuinely differ, and the WSL distros on the PC.

## How it fits

Purely declarative. The machine agent that makes this possible lives in `_devices/machine`; this package is what tells
an agent that such a machine exists and how to use it.

## Conventions & gotchas

- "My machine" in a prompt means this, not the sandbox. The skills open by making that distinction, because an
  agent that confuses the two runs the right command in the wrong place.
- A Windows PC and the WSL distros on it are one computer connected through several doors. Both packs say how to
  cross (`run_command` with `in: "wsl:<name>"` or `in: "windows"`), which side owns the screen, and that one Docker
  engine serves every side; the turn's prompt names which ids are one PC.
