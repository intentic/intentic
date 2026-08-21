# Get an address for a sandbox I never had to name

As someone who has just signed in and owns no infrastructure, I want the product to hand me a working address for a machine I have not started yet, so that "pick a name, then find a domain and a tunnel" is not the first thing standing between me and a workspace.

Setup opens as a numbered spine, and step one is already done when I get there: the sandbox exists, under a name it chose for me. That is not a decision taken away, a name only tells sandboxes apart in the switcher, and my first one has nothing to be told apart from, and it stays mine to change, from that same card, at any point, without holding anything up.

Step two is where most products would ask for a Cloudflare account. This one does not: it prepares a domain under its own zone and shows me the hostname it just provisioned, read-only, because there is no decision left for me in it.

The bring-your-own path is still there, one line away, for someone who wants their sandbox on their own zone: and it asks for exactly what it needs, says what the token is scoped for, links to where to create it, and promises the token is never stored.

## Acceptance criteria

- [ ] Setup opens outside the workspace, titled for the task, with numbered steps and a promise line about what is coming
- [ ] Step one asks for nothing: the sandbox is created on arrival, the step reads as done, and it carries the name it was given
- [ ] A first sandbox is named `workspace`, and a later one counts up rather than colliding with a name the account already holds
- [ ] Arriving with a sandbox I started setting up earlier resumes that one instead of creating another
- [ ] Renaming from step one is one action, keeps what I typed, and leaves the rest of setup exactly where it was
- [ ] A sandbox that could not be created says so and offers to try again, rather than falling back to a form
- [ ] Step two defaults to an address provided by intentic and shows the resulting hostname, with no Cloudflare account asked for
- [ ] Choosing to use my own Cloudflare zone instead reveals a token field, a zone choice and an editable subdomain, and a way back to the provided address
- [ ] The token field states which permissions the token needs, links out to where one is created, and says the token is not stored
- [ ] An invalid subdomain is rejected with a message naming what is allowed, and a valid one shows the full hostname it will produce
- [ ] A step already satisfied reads as done, so the spine says where I am without my counting
