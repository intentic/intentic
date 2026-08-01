# Copy one command, and know what it will do before I run it

As someone about to paste a command into a shell on my own machine, I want to know exactly what it installs and what it carries, so that I am not pasting a stranger's script on trust.

The command is generated for me, personalised, and offered for the shell I actually use — Linux and macOS, PowerShell, or a compose file for a host I manage properly. There is a copy action, because selecting a wrapped one-liner by hand is where this flow used to lose people. What the command carries is a short-lived code that redeems the real values later, not my credentials in plain text on my shell history.

Before I run it, the page tells me the three things I would otherwise have to guess: that it needs Docker and will offer to install it, that it opens a private tunnel rather than a port, and that nothing is being deployed anywhere. The command does not appear until it can actually work — while the address is still being prepared, the box says what it is waiting for instead of handing me something that would fail in a terminal.

## Acceptance criteria

- [ ] The run step offers the command for Linux/macOS, for Windows PowerShell, and as a Docker Compose file, one at a time
- [ ] A copy action puts the shown command on the clipboard
- [ ] While the address is not ready, the command is withheld and replaced by a line saying what is still needed
- [ ] The step states that Docker is required and will be installed if missing, with the user asked first
- [ ] A disclosure explains what running it does — starts the container, opens a private tunnel, exposes no ports and deploys nothing
- [ ] The Linux/macOS and PowerShell commands carry a setup code rather than a raw credential
- [ ] Switching between the command tabs changes the command shown without losing the step's other choices
- [ ] The desktop-sync option can be turned on and off, and when on the step names the local folder that will be mirrored
- [ ] Turning desktop sync on or off changes only the one command, without the address or the rest of the step being re-prepared
