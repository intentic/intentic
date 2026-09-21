# @intentic/webchat-widget

**Visitor chat**: the embeddable chat bubble a website loads to talk to a sandbox agent. One IIFE bundle
(8.1 kB gzipped), no framework, served by the daemon at `/webchat/widget.js`.

```html
<script src="https://sandbox-<id>.<zone>/webchat/widget.js" data-automation="support" defer></script>
```

`data-automation` is the automation id and the only thing the snippet carries. The daemon to talk to is the
origin the script itself came from: the one thing a copy-pasted snippet cannot get wrong. `data-base`
overrides it for a site that fronts the sandbox behind its own proxy.

## Gotchas worth knowing before you edit this

- **`all: initial` on the host in `styles.ts` is load-bearing.** A shadow root blocks the page's *selectors*
  but not inherited properties: without that line the widget wears the host site's font and colour.
- **The gate container is light DOM on purpose.** Google's sign-in button and Turnstile's checkbox are
  third-party iframes that want a document-connected container, so they are created as children of the element
  and slotted into the panel. Do not "tidy" them into the shadow root.
- **The reply is SSE over POST**, which `EventSource` cannot do: hence the hand-rolled reader in
  `transport.ts`. Hono splits a payload on newlines into one `data:` line each, so rejoining with `\n` is what
  restores an agent's multi-line text.
- **A live reply is streamed; a later one is polled.** An approval-gated guest closes the stream on a `pending`
  notice, and a human writing as the agent has no stream at all, so both land in the daemon's outbox and the
  widget collects them from `/webchat/<id>/messages` against a cursor it keeps in `localStorage`. The two paths
  never both carry one reply: the live SSE does not write to the outbox, which is why a reload after a live
  answer shows nothing rather than repeating it.
- **The poll is gated on the thread having spoken.** `storedSpoke` is what keeps a visitor who only ever reads
  the page from making a request a minute forever; nothing can be queued for a thread that never wrote. The
  cadence is slower with the panel shut, and every failure doubles the wait, because an unreachable sandbox is
  this widget's ordinary weather.
- **Types come from `@intentic/sandbox-contract`, imported as types only**, and the one VALUE import is the
  contract's `embed` entry, which has no imports of its own (the three calls every embed makes, the proof-of-work
  solver, the localStorage id, the script-tag boot). That is why the contract is a *devDependency*: everything
  is bundled in or erased, so zod never reaches a visitor's browser. Keep it that way: a value import from the
  contract's barrel would multiply the bundle size.
- **`crypto.subtle` needs a secure context.** The proof-of-work check cannot run on an `http://` site, and says
  so rather than hanging.

## Commands

```sh
./node_modules/.bin/vite build     # → dist/widget.js (watch the gzip line in the output)
./node_modules/.bin/vitest run
```

The daemon takes this package as a **prod dependency** and resolves `dist/widget.js` through its export, so
`pnpm --filter @intentic/sandbox deploy --prod` carries the built bundle into the image with no Dockerfile
change. The other half of the wire is `_sandbox/sandbox/src/webchat/`.

## Key files

- [src/element.ts](src/element.ts): the custom element a site embeds.
- [src/transport.ts](src/transport.ts): the reply, SSE over POST, and the poll that collects one written after it closed; the config and challenge calls are the contract's embed helpers.
- [src/identity.ts](src/identity.ts) / [src/challenge.ts](src/challenge.ts): who a visitor is, and the Turnstile half of the abuse gate (the proof of work is every embed's, in the contract).
- [src/main.ts](src/main.ts): the entry the script tag loads.
