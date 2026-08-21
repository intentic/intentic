# @intentic/ext-computers

The user's own machines (Windows and Linux) as something the agent can operate.

## Responsibilities

- Declare the two machine capabilities.
- Ship the skill that teaches an agent to run commands, read files and drive the screen on each.

## Key files

- [intentic-extension.json](intentic-extension.json): the two capabilities. This file IS the package; there is no `src/`.
- [skills/linux](skills/linux): how an agent operates a Linux machine.
- [skills/windows](skills/windows): the same for Windows, and where the two genuinely differ.

## How it fits

Purely declarative. The machine agent that makes this possible lives in `_computers/host`; this package is what tells
an agent that such a machine exists and how to use it.

## Conventions & gotchas

- "My machine" in a prompt means this, not the sandbox. The skills open by making that distinction, because an
  agent that confuses the two runs the right command in the wrong place.
