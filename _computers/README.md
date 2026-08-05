# Your computer

Everything that runs on the user's OWN machine rather than in a sandbox: the host agent that lets a sandbox
work there, the browser and desktop drivers it uses, and the local-agent plumbing (state home, autostart,
detached loops) every one of these CLIs shares. Scopes are enforced on the machine, never in the sandbox —
see [host/](host).
