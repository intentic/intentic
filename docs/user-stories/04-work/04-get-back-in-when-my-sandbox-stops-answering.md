# Get back in when my sandbox stops answering

As someone who opened Intentic and found my sandbox not answering, I want to be told what is actually wrong and what, if anything, I have to do, so that I am not left on a spinner guessing between commands, and so that a sandbox that is merely busy never frightens me into restarting it.

The page finds out before it says anything. It checks this device's own connection, Intentic, the sandbox's address, the machine the sandbox runs on, and the sandbox itself, and it names the one link that broke. A sandbox that is alive and slow is busy, and it says so calmly: the tab does not turn to Offline, nothing asks me to act for a minute and a half, and a restart is only mentioned after five minutes, as an option rather than advice. When something is actually down, I get one sentence about it and at most one thing to press.

Whatever can be fixed without me is fixed without me. On my own computer the Intentic agent notices first. It starts Docker Desktop when it isn't running, including after a reboot, restarts a sandbox that gave up, and clears leftover images when the disk is full. The page shows what it is doing while it does it ("rog is starting Docker Desktop"), even when I am looking from my phone. It does nothing disruptive by itself: restarting a stuck Docker, rolling back an update, or switching Docker's mode is always asked first.

When I have to act, I am handed one command for the computer the sandbox runs on, in that computer's shell. It checks every layer, fixes what is safe, asks in its terminal before anything else, and the page follows it as it runs. In the desktop app the command is a button. For a sandbox Intentic runs, the button is Restart, and Roll back when the last update is what broke it.

## Acceptance criteria

- [ ] A sandbox whose netd says its daemon is up, or that answers anything at its address, is shown as busy and never as down, however long it lasts
- [ ] While a sandbox is busy, the browser tab does not say Offline and no card appears for the first 90 seconds
- [ ] A restart is offered for a busy sandbox only after five minutes, and only among the other options
- [ ] The recovery panel appears when the diagnosis finds a cause with something to do about it, never because a timer ran out
- [ ] Each diagnosis shows one title, one sentence, and at most one primary action; anything else is behind "Other options"
- [ ] The panel shows which link broke: this device, the internet, the machine it runs on, or the sandbox
- [ ] When this device is offline, or only the sandbox's address is blocked on this network, the page says so and blames nothing on the sandbox
- [ ] A sandbox on my own computer that is not connected is waited on while it may still reconnect by itself, then gets the one command
- [ ] What the machine reported about this outage is shown in its own words, including what it is doing right now
- [ ] A report from before the current outage is never shown as the machine's word about it
- [ ] The command carries a short-lived code rather than a credential, and the page follows its run through that code
- [ ] The command is offered for the machine's own OS when the machine reported it, and for either shell on request
- [ ] In the desktop app, the command is a button that runs it on this computer
- [ ] A hosted sandbox whose machine failed or never connected offers Restart, and Roll back where the platform kept the previous version
- [ ] A hosted sandbox that is waking gets more patience when its machine was built to order than when it came from the warm pool
- [ ] The machine agent starts Docker Desktop by itself when a sandbox on that computer is unreachable because Docker isn't running, including right after sign-in
- [ ] The machine agent never restarts Docker Desktop, shuts WSL down, rolls back, or starts a sandbox its owner stopped, without being asked
- [ ] The machine agent's self-repair can be switched off
