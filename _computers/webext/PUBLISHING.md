# Publishing the browser extension

What it takes to get this from `dist/` into somebody's browser, in the order the work actually has to happen.
Store review is the long pole and everything else can be done while it runs.

## 0. What is already true

- The build produces a loadable, unpacked MV3 extension: `pnpm --filter @intentic/webext build` → `dist/`.
- Four permissions (`storage`, `scripting`, `alarms`, `cookies`), one optional host pattern, one content script
  scoped to `*://*.intentic.dev/*`. No `tabs`, no `debugger`, no remote code.
- The store id is not baked into anything. Pairing works through a window message and a pasted code, so an
  unlisted build and a store build pair identically. Nothing below is blocked on an approved listing.

## 1. Before submitting (half a day)

| Thing | Why it blocks | Notes |
| --- | --- | --- |
| **Icons** (16/32/48/128 PNG) | The manifest has none; the store requires them and Chrome shows a puzzle piece meanwhile | Not committed as placeholders on purpose — a fake binary in a repo is worse than a missing one |
| **A publisher account** | $5 one-time, and the account that owns the listing forever | Use the org account, not a person's |
| **Privacy policy URL** | Required for any extension handling "web browsing activity" or "authentication information" — this handles both | One page on intentic.dev, linked from the listing |
| **A `key` in the manifest for the unlisted build** | Otherwise the dev id changes on every reload and a paired browser looks like a different one | Only needed for the pre-listing beta |
| **Version discipline** | The store rejects a re-upload of the same version | `version` in `static/manifest.json` is the source; wire it to the package's release like `@intentic/host`'s |

## 2. The single-purpose statement, written before the form asks for it

Chrome's review turns on ONE question: does everything the extension asks for serve one narrow purpose a user
would recognise? Ours, in the words the listing should use:

> Lets your Intentic sandbox work in this browser, on sites you explicitly allow, while you watch.

Each permission then justifies itself against that sentence — this is the table to paste into the review form:

| Permission | Justification |
| --- | --- |
| `scripting` | Reading the page and clicking in it IS the feature; injection happens only into origins the user granted |
| `storage` | The sandbox pairing, the per-site read/act modes, the pause switch, the local activity log |
| `alarms` | Reconnecting the socket after the MV3 worker is evicted; nothing periodic otherwise |
| `cookies` | One user-initiated action ("hand this site's session to my sandbox"), confirmed in the page every time, off by default |
| `optional_host_permissions: *://*/*` | Requested per site at runtime, never at install: the user picks the sites |
| content script on `*://*.intentic.dev/*` | Receives a pairing code the user's own sandbox page offers, so they don't copy-paste it |

**`cookies` is the one that draws scrutiny**, and it is worth pre-empting in the notes: it reads only the
current site's jar, only after an in-page confirmation, only when the sandbox's `cookies` switch is on, and the
data goes to the user's own sandbox — a host they paired themselves — never to us. If review pushes back,
shipping v1 with the `cookies` permission removed entirely is a two-line change (`static/manifest.json`, and
the `connect_site` tool refuses with "this build cannot hand sessions over"); land it as v1.1 once the listing
has a track record.

## 3. Submission

1. `pnpm --filter @intentic/webext build`, zip `dist/`, upload.
2. Category **Developer Tools**. Distribution **Public**, or **Unlisted** for the first weeks — unlisted is
   reviewed too, but a rejection costs nothing publicly.
3. Fill the permission justifications from the table above; attach the privacy policy; declare data handling as
   *authentication information* + *website content*, **not sold, not used for anything but the stated feature*.
4. Expect **3–10 business days**, longer for the first submission from a new publisher, and longer again
   whenever `cookies` is in the manifest.

## 4. Edge, and then the rest

- **Edge Add-ons** takes the same package with no code changes (`static/manifest.json` as-is). Its review is
  usually faster. The `edge` capability card already points at an Edge listing URL.
- **Firefox** needs real work, not a re-upload: `browser.*` promises, a different background model
  (`background.scripts` / event pages), and no `chrome.scripting.executeScript({func})` serialization semantics
  to rely on. Worth doing only if asked for — the card system is ready for it (one manifest entry plus a skill).
- **Safari** needs an Xcode wrapper and an Apple developer account. Same answer: only on demand.

## 5. What to fix before the listing is public

- **Trim the background bundle.** 755 kB minified, ~200 kB of which is the daemon's entire schema surface
  reached through the contract's barrel import. Giving the webext schemas their own contract entry point (as
  `@intentic/sandbox-contract/webext-links` already does for the zero-dependency half) is the fix. A reviewer
  reading a bundle full of unrelated API shapes is a reviewer asking why.
- **Ship a source map** or point the review notes at the public repo and the exact commit. Minified code with
  no provenance is the most common cause of a slow first review.
- **A `docs/your-browser` page on the site**, the twin of `your-machine`, since the listing has to link
  somewhere that explains the model: sites you allow, a banner on every action, pause in one click.
- **The platform-brokered pairing** (sign in with Google in the popup → pick a sandbox → connect). The current
  flow assumes the person has their sandbox open, which is true when they connect from the card and false when
  they arrive from the store listing. That is the funnel the listing will actually deliver, so it is the next
  real feature rather than a nicety.

## 6. After it ships

- **Update cadence.** A store release is days, not minutes. Anything that can live in the daemon should: the
  extension's tool surface is deliberately opaque to the daemon so the two release independently, but that cuts
  both ways — a bug in a tool description is a store round trip.
- **Watch for the MV3 worker eviction bugs.** They present as "the browser shows offline until I click the
  extension". The alarm covers a minute; if reports say otherwise, the next lever is an offscreen document.
- **Do not add permissions casually.** Every added permission re-triggers full review AND disables the
  extension for existing users until they accept it. `tabs` and `debugger` are the two that would be tempting
  and are the two to keep out.
