# The sandbox

One private box per project, where your code and the agents live. The daemon that owns it, the wire contracts
both sides of every connection agree on (`sandbox-contract`, `extension-api`), and the workspace machinery
(scaffolding, ignore rules, setup, sync). The daemon app itself is [sandbox/](sandbox); everything else here
is what it and its clients share.
