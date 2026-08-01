# Give the agent a machine, and a way onto a private network

As someone whose real systems are behind SSH and a VPN, I want to hand the agent a host and a tunnel, so that it can operate the infrastructure I actually have rather than only the code in front of it.

SSH is the card that has to branch: a key and a password are different credentials, and a form asking for both is asking me to leave one blank and hope. So choosing the authentication mode changes which field I am asked for, and a private key gets a field that survives being pasted — a single-line input silently eats the newlines and corrupts the key, which is a failure with no visible cause.

The VPN card knows that nobody types a tunnel's settings from memory. It accepts an exported configuration and fills the form from a connection in it, while being honest that the passwords in that file are encrypted by the exporting client and cannot be read — so it tells me which fields I still have to enter. Dialling the tunnel is not done here: the sandbox's status view owns that flow, and the card links to it rather than growing a thinner copy.

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
