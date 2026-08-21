# Point it at a sandbox I am already running

As someone who already runs the container behind a domain of my own, I want to hand over one address and be done, so that I am not provisioning a tunnel I will never use.

This is the one-step lane, offered from the same first step as everything else. I paste the address my sandbox already answers on, the browser checks it, and if it answers I am in the workspace: no command, no tunnel, no waiting for an announcement. The name is optional here, because the address already implies one.

The value of this lane is entirely in what it says when the probe fails, because every failure is a different job. Nothing listening is a DNS or container problem. Something listening that never answers is a boot or a proxy port. A tunnel answering with nothing behind it is a container that is not running. And a sandbox that is up but will not let me in is waiting to be claimed: so it asks for the connection token rather than telling me it is broken.

## Acceptance criteria

- [ ] The first setup step offers a way to connect a sandbox that is already running at a domain
- [ ] That lane asks for the address and nothing else required, and states that the name is only for telling sandboxes apart
- [ ] An address that is not a usable domain is called out before any request is made
- [ ] An address nothing answers on reports that nothing answered, and suggests what to check
- [ ] An address that accepts the connection but never answers is reported differently from one that refuses
- [ ] A live domain with no sandbox behind it says exactly that, rather than quoting a raw status code alone
- [ ] A sandbox that is up but unclaimed asks for its connection token, and says the token is used once and never stored
- [ ] Switching between this lane and the guided one keeps the name already typed and any sandbox already created
- [ ] A successful connect opens the workspace without a second setup step
