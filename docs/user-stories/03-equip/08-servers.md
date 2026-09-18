# Give the agent a machine, a way onto a private network, and the disks on it

As someone whose real systems are behind SSH and a VPN, I want to hand the agent a host, a tunnel, and the file shares behind them, so that it can operate the infrastructure I actually have rather than only the code in front of it.

SSH is the card that has to branch: a key and a password are different credentials, and a form asking for both is asking me to leave one blank and hope. So choosing the authentication mode changes which field I am asked for, and a private key gets a field that survives being pasted, a single-line input silently eats the newlines and corrupts the key, which is a failure with no visible cause.

The VPN card knows that nobody types a tunnel's settings from memory. It accepts an exported configuration and fills the form from a connection in it, while being honest that the passwords in that file are encrypted by the exporting client and cannot be read, so it tells me which fields I still have to enter. Dialling the tunnel is not done here: the sandbox's status view owns that flow, and the card links to it rather than growing a thinner copy.

The Network disk card is where I decide how much of my file server the agent gets. A share is added with its server, share name and an account, and the one choice that matters is read-only or read and write: read-only is the default, it is what the disk is mounted as, and the card tells me plainly that the fence I can trust is a read-only account on the server itself, because the sandbox could remount what it mounted. A disk behind my VPN just works once the tunnel is up, and comes back on its own after a restart, after the tunnel does. Mounting happens on the disk's own row, and the agent can do the same through a command that goes through the same door, so what it mounts I see and what I unmount it loses.

## Acceptance criteria

- [ ] The Servers section lists the remote-machine and private-network cards with a line saying what each gives the agent
- [ ] The SSH card offers a choice of authentication mode, and the credential field shown changes with it
- [ ] A pasted multi-line private key keeps its line breaks in the field it is entered into
- [ ] A port outside the valid range is rejected before the form is submitted
- [ ] The VPN card accepts an exported client configuration and lists the connections found in it
- [ ] Picking one of those connections fills the form's non-secret fields and names which fields still need entering
- [ ] A value that is encrypted ciphertext from that export is refused with an explanation, rather than being sent and rejected later
- [ ] A connected tunnel is dialled from the sandbox's status view, and the card links there rather than duplicating the controls
- [ ] A connected tunnel shows the address it was assigned and what it routes, so I can tell whether my internal host is reachable through it
- [ ] The Network disk card asks for a server, a share and an account, and defaults its access to read-only
- [ ] A read-only disk is mounted read-only, and the row says so from the live mount, not from the form
- [ ] The card says a read-only account on the server is the fence to trust, and the effects list says what the agent gets before I add it
- [ ] A disk marked to mount on start comes back after a sandbox restart, after the VPN it sits behind
- [ ] A mount that fails says why in words I can act on: wrong credentials, a server not reachable through a down tunnel, a client the sandbox does not carry yet
- [ ] A disk whose live mount takes writes though its card says read-only is reported, on the row and in the daemon's own checks
