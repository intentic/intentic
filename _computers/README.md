# Your computer

Everything that runs on the user's OWN machine rather than in a sandbox: the host agent that lets a sandbox
work there, the browser and desktop drivers it uses, the extension that lets a sandbox work in the browser they
are already signed into, and the local-agent plumbing (state home, autostart, detached loops) every one of these
CLIs shares. Permissions are enforced at the far end, never in the sandbox: see [host/](host) for a machine's,
[webext/](webext) for a browser's.

Two connectors, and the difference is worth stating once: [host/](host) is the whole computer — a shell, files,
the screen — connected by a one-liner run over there. [webext/](webext) is one browser on it, connected by a
code pasted into an extension, and it can do exactly one thing the other cannot: act as the person on the sites
their browser is already signed into.
