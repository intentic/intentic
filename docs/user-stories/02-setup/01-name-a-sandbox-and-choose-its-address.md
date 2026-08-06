# Name a sandbox, and get an address for it without owning a domain

As someone who has just signed in and owns no infrastructure, I want the product to hand me a working address for a machine I have not started yet, so that "you'll need a domain and a tunnel" is not the first thing standing between me and a workspace.

Setup opens as a numbered spine, and step one asks for the one thing only I can answer: a name, so I can tell this sandbox apart from the next one. Step two is where most products would ask for a Cloudflare account. This one does not: it prepares a domain under its own zone and shows me the hostname it just provisioned, read-only, because there is no decision left for me in it.

The bring-your-own path is still there, one line away, for someone who wants their sandbox on their own zone — and it asks for exactly what it needs, says what the token is scoped for, links to where to create it, and promises the token is never stored.

## Acceptance criteria

- [ ] Setup opens outside the workspace, titled for the task, with numbered steps and a promise line about what is coming
- [ ] Step one takes a name, its Create action stays unavailable while the field is empty, and the field suggests what a name looks like
- [ ] Creating the sandbox collapses step one to a summary carrying that name, and reveals the following steps
- [ ] Step two defaults to an address provided by intentic and shows the resulting hostname, with no Cloudflare account asked for
- [ ] Choosing to use my own Cloudflare zone instead reveals a token field, a zone choice and an editable subdomain, and a way back to the provided address
- [ ] The token field states which permissions the token needs, links out to where one is created, and says the token is not stored
- [ ] An invalid subdomain is rejected with a message naming what is allowed, and a valid one shows the full hostname it will produce
- [ ] A step already satisfied reads as done, so the spine says where I am without my counting
