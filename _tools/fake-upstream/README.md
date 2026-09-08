# @intentic/fake-upstream

A stand-in for the model the free trial spends: Google's two surfaces, served locally and deterministically.

## Responsibilities

- Answer the model listing and the chat completion the platform's trial calls, on the wire rather than through
  an injected `fetch`.
- Refuse the wrong credential the way the real upstream refuses it, so a dialect mix-up fails in a test.
- Return a reply a browser test can assert it saw, and record every prompt it was sent.

## How it fits

The trial is the one place this product sits on the command path: a user with no model account of their own
chats through the platform, which spends intentic's own key upstream. Until now that path was covered by unit
tests with an injected `fetch`: which proves the routing and proves nothing about the wire. This package is the
other end of the wire, so the onboarding journey can drive a real message from a real browser to a rendered
reply without a real key, a real quota, or a network.

Pointing the platform at it needs **no product change**: `TRIAL_BASE_URL` is already config, and already
documented as any OpenAI-compatible upstream.

```dag
{ "title": "A trial message, with this package standing in for Google", "direction": "LR",
  "nodes": [{ "id": "web", "label": "Browser app", "accent": "1" },
            { "id": "daemon", "label": "Sandbox daemon", "note": "trial endpoint", "accent": "2" },
            { "id": "api", "label": "Platform api", "note": "spends the allowance", "accent": "3" },
            { "id": "fake", "label": "fake-upstream", "note": "this package", "accent": "5" }],
  "edges": [{ "from": "web", "to": "daemon" }, { "from": "daemon", "to": "api" }, { "from": "api", "to": "fake" }] }
```

What to notice: the platform is the only thing that ever talks to this package, and it is the only hop in the
whole chain that would otherwise need a credential nobody can commit.

## Conventions & gotchas

- **The URL shape is load-bearing, not decoration.** The platform derives Google's native listing by stripping a
  trailing `/openai` from the configured base. A stand-in served at some flat `/v1` would silently take the
  "upstream will not say what its models can do" branch, and the discovery path this exists to cover would never
  run. So the base is `/v1beta/openai` and the native listing sits one segment up, exactly as at Google.
- **Each surface refuses the other's credential.** The compatibility shim wants `Authorization: Bearer`;
  Google's own surface refuses a bearer outright and wants `x-goog-api-key`. A fake that accepted either would
  go green on precisely the mix-up that once emptied the trial's picker in the field.
- **Model ids come back `models/`-prefixed**, because the real ones do. An unprefixed id here would let a broken
  strip on the platform side ship.
- **No dependencies and no build, and that binds everything under `src/`.** Node 24 runs TypeScript by erasing
  its types, so the image is the stock node base with `package.json` and `src` copied in — no install, no
  `node_modules`. That is why relative imports here name `.ts` rather than the `.js` every other package
  writes: node resolves the specifier literally and will not rewrite one extension into the other. It is also
  why [src/http.ts](src/http.ts) keeps its own copy of the two helpers every other fake in the repo imports
  from `@intentic/testing/http-fake`. A workspace import in `src/` type-checks, passes this package's suite and
  resolves fine from the checkout; it then dies in the container on `ERR_MODULE_NOT_FOUND` the moment the
  onboarding journey stands the world up, which is how the nightly `onboarding` job failed for a night. The
  tests and `vitest.config.ts` import freely — they never enter the image.
- `refuseKeys` makes named keys answer 429, which is what drives the platform's pool walk without a real quota.

## Key files

- [src/server.ts](src/server.ts), the server: both surfaces, the two dialects, streamed and plain replies.
- [src/http.ts](src/http.ts): the request-body read and the JSON reply, owned here rather than imported, for the
  reason the convention above gives.
- [src/main.ts](src/main.ts): the container entrypoint, configured entirely from the environment.
- [src/server.test.ts](src/server.test.ts): what the platform sends, and every refusal that matters.
- [Dockerfile](Dockerfile): the image the journey harness stands up beside the platform.
