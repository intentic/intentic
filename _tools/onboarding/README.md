# @intentic-app/onboarding

The onboarding tier: one journey through the product's front door, run once per way of getting a sandbox.

## Responsibilities

- Stand up the whole platform from the branch's own code: postgres, the api, the SPA, and a stand-in for the
  one outside service onboarding cannot do without.
- Walk the install path a user walks (the wizard, the bytes it renders, the container that comes up) and
  assert the platform sees the sandbox connected and the browser can talk to it.
- Give every path the same seeded account and the same assertions, so a regression in signing in or in
  chatting is found once rather than three times or not at all.

## Why it is not more specs in `_tools/e2e`

That tier cannot run in CI and its own README says why: every server it starts is addressed on `localhost`,
which is true on a developer's machine and false anywhere the test process is itself in a container driving
some other Docker daemon. This tier exists to be the one that runs everywhere, and it also goes somewhere that
one never does: through provisioning, into a real daemon the wizard's own instructions started.

```dag
{ "title": "The shared world, and the one part that differs per path", "direction": "LR",
  "nodes": [{ "id": "browser", "label": "Playwright", "note": "the journey", "accent": "1" },
            { "id": "web", "label": "SPA", "note": "branch image", "accent": "1" },
            { "id": "api", "label": "Platform api", "note": "branch image", "accent": "3" },
            { "id": "pg", "label": "Postgres", "accent": "neutral" },
            { "id": "up", "label": "fake-upstream", "note": "stand-in model", "accent": "5" },
            { "id": "box", "label": "Sandbox", "note": "compose / cli / desktop", "accent": "2" }],
  "edges": [{ "from": "browser", "to": "web" }, { "from": "browser", "to": "api" }, { "from": "browser", "to": "box" },
            { "from": "api", "to": "pg" }, { "from": "api", "to": "up" },
            { "from": "box", "to": "api" }] }
```

What to notice: only the sandbox differs between the onboarding paths. Everything else is stood up once,
which is why a path costs one adapter rather than a suite of its own.

## What it covers today, and what it does not

| Segment | State |
| --- | --- |
| arrive signed in | covered, with a **seeded** session |
| the wizard mints a code, renders a compose file, the box comes up and announces | covered, end to end |
| the wizard mints a code, `ic sandbox connect` redeems it, the box comes up dialling its edge | covered, end to end |
| the browser adopts the box's address and the workspace opens | covered |
| send a message to the free agent and read the reply | **written and skipped**: see below |

**The last row is skipped for a reason worth knowing.** A provisioned daemon authenticates people against
Google itself (that is the whole reason a sandbox ever asked for Google a second time) so it answers the
seeded credential the platform accepted with a 401 on every call. Nothing is broken; a seeded sign-in simply
cannot reach a box that verifies for real. The stand-in Google that signs tokens properly is what unblocks it,
and `SIGN_IN_IS_SEEDED` in [src/seed.ts](src/seed.ts) is the single line that turns the test on when it lands.

The **Google free channel** (the free sign-in the model picker leads its locked rows with) needs a real Google
account inside the box and is not covered by this tier at all. The free agent here is the trial, which is what
a new user actually lands on: no card asks them to sign in to anything before they can type.

## Conventions & gotchas

Most of these were discovered by watching this tier fail in ways that named something other than the cause.

- **The whole world is served over TLS on loopback, and neither half is a preference.** The daemon's outbound
  channel to the platform is `node:https` by hand, so a plain-http platform fails every announce with
  `ERR_INVALID_PROTOCOL` while the box looks perfectly healthy. And the SPA's own content security policy
  permits plain-http calls to `127.0.0.1` alone, so an api on any other host is refused by the document before
  the request leaves the page: which surfaces as "Intentic isn't reachable", a screen that blames the network.
  [src/certs.ts](src/certs.ts) and [src/docker.ts](src/docker.ts) carry the full accounts.
- **Reachability is a signature, so there is no hub to stand up.** The platform mints a sandbox's reachability
  grant by signing it and calls nothing, so this world hands the api a throwaway Ed25519 key and that alone is
  what makes the wizard willing to mint a setup code: with no key at all, the provisioning routes 404 and setup
  offers only the attach lane, which is a legitimate mode but not one a journey through the install paths can
  walk. The ingress that grant names does not exist (an unroutable `.test` address) and nothing here needs it —
  the box is reached over loopback, and its tunnel dial retries in the background as it would against an edge
  that is down.
- **The api and the SPA share a host, a scheme and a certificate.** They are separate origins that must stay
  same-site, or the browser drops the session cookie on every call and a signed-in journey looks exactly like
  a broken login. Same-site comparison includes the scheme, so the two move together or not at all.
- **The CLI lane drives the ic THIS checkout builds, and takes only the setup code off the rendered command.**
  The one-liner a user copies is a bootstrap shim: it downloads `ic` from the latest GitHub release and gets the
  machine ready for Docker. Running those bytes here would test the last release rather than the branch (the
  objection [src/images.ts](src/images.ts) makes about pulling `:latest`), so the lane reads the code out of the
  copied command, guards that the command names THIS run's platform, and runs the binary from
  `IC_BIN`/`dist-bin`/`cargo`. Fetching the shim and preparing Docker is what the desktop smokes cover, on both
  operating systems, against the bytes an installer actually shipped.
- **`reachedBy` is what the CLI lane asserts, because a hermetic world has no edge.** The grant this world
  signs names an unroutable `.test` address, so no tunnel can ever come up and asserting one would be asserting
  a fiction. The daemon's `/health` reports the POSTURE it was configured into instead: `tunnel` when it was
  handed a grant and an edge and is dialling, `loopback` when it was handed neither. That one field is the
  fingerprint of the regression this lane was added for — a setup that drops the grant produces a box which is
  healthy, registers, and answers 502 on its own address for good. For the same reason, `Public DNS` and
  `Public URL` are the only checks `ic sandbox connect` is allowed to fail here, and any other failing link
  fails the lane.
- **The wizard's commands run in a FRESH shell, not this process's environment.** Compose interpolates
  `${CONNECT_TOKEN}` from the `.env` the claim writes: but a shell variable of the same name outranks that
  file. A harness that exported one of its own started the box with somebody else's credential: the container
  came up, the platform answered every announce with 404, and nothing anywhere said the word "token".
- **The browser is granted `local-network-access`, and the app's own offer is still clicked.** Reaching a box
  on this machine is a loopback hop the app prefers, but it asks first with a card of its own and remembers
  the answer: and until that card is answered it never probes the local address at all.
- **The api and the SPA are built from the branch**, using the same two Dockerfiles the release uses, with the
  push left off. A gate that tests the last release is not a gate.
- **No reaper.** Containers are removed explicitly and a label sweep clears whatever a killed run left, which
  is less machinery than a helper container that has to be reachable to do its job.
- **It stands down rather than going red.** No switch or no Docker writes a reason into the world file and
  every spec skips with that sentence. This tier is meant to gate releases, so the reasons it is red have to
  be reasons somebody can fix.

## Run

```sh
pnpm --filter @intentic-app/onboarding e2e:onboarding
```

Needs Docker, `openssl`, and Playwright's Chromium: and needs to be running where Docker publishes, since the
world lives on loopback ports. The CLI lane additionally needs this checkout's `ic`: hand one in with `IC_BIN`,
leave one at `_sandbox/ic/dist-bin/ic-linux-amd64` (`bash _tools/scripts/build/build-ic.sh linux-x64`), or have
`cargo` on PATH and it builds one. With none of those that lane stands down with the sentence that fixes it and
the compose lane still runs. Two switches earn their keep while working on it:
`ONBOARDING_SKIP_IMAGE_BUILD=1` reuses whatever is already tagged, and `ONBOARDING_KEEP=1` leaves the world, the
compose folder and the CLI lane's sandbox standing after a failure, which is the difference between reading a
daemon's log and reproducing the run to get one.

In CI this is nightly.yml's `onboarding` job, on the desktop runner because the CLI lane needs the Rust
toolchain that image bakes.

## Key files

- [src/world.ts](src/world.ts): the half of the world every onboarding path shares.
- [src/certs.ts](src/certs.ts): why the world is TLS, and the per-run certificate that makes it so.
- [src/docker.ts](src/docker.ts): where the world has to live, and the check that says so when it cannot.
- [src/containers.ts](src/containers.ts): containers on a network whose subnet we chose, so addresses are
  known before anything starts.
- [src/provisioner.ts](src/provisioner.ts): the one thing that differs between the paths.
- [src/provisioners/compose.ts](src/provisioners/compose.ts): the wizard's own bytes, run the way a user runs
  them.
- [src/provisioners/ic.ts](src/provisioners/ic.ts): the CLI the desktop app and the one-liner hand off to, and
  the posture assertion that is the point of running it.
- [src/announce.ts](src/announce.ts): what "connected" means, asked of the platform's own registry.
- [src/shell.ts](src/shell.ts): the fresh terminal every lane runs its commands in.
- [src/ic-binary.ts](src/ic-binary.ts): where the CLI lane's binary comes from, and when it stands down.
- [src/seed.ts](src/seed.ts): the signed-in account, and how far a seeded one can carry a journey.
- [specs/world.spec.ts](specs/world.spec.ts): the facts everything else rests on, asserted first.
- [specs/journey.spec.ts](specs/journey.spec.ts): the journey itself.
