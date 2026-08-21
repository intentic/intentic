// The extension API's protocol version, the value `engines.intentic` ranges are matched against at load, and
// the value the host reports as IntenticApi.apiVersion. Bumped ONLY with the published package: additive
// surface = minor, breaking = major. This package is the one deliberate exception to the repo's no-legacy rule.
//
// 1.0.0 rather than 0.5.0, and the reason is the drift that forced that bump. While the major was 0 the caret
// matcher treats the MINOR as breaking (engines.ts), so every addition invalidated every declared range, which
// made bumping expensive enough that two surface changes (connectors → capabilities, api.documents.open) shipped
// without one, and the number stopped being true. At 1.x an addition is 1.1.0 and costs authors nothing, so the
// bump that keeps this honest is the cheap one. surface-guard.test.ts is what makes it non-optional.
// 2.0.0 makes listener contributions self-describing: the former `eventTypes` array became labelled `events`
// plus the automation-editor vocabulary the provider owns. That is intentionally breaking, a 1.x listener
// manifest cannot honestly promise that a generic host can configure it.
// 2.1.0 adds the backend half: a manifest `server` bundle (activateServer, run by the daemon's backend host
// under /x/<id>/…) and `permissions.daemon` beside `permissions.sandbox`. Additive, a 2.0 manifest is a 2.1
// manifest that ships no backend.
// 2.2.0 opens the automation composer: `contributes.automationTemplates` lets a pack ship the starting points
// for its own service, and a `listener` may declare a second narrowing field (`automation.branchField`) for a
// source whose events carry one. Both fold into the daemon's trigger catalogue, so a pack that knows something
// worth waking on says so itself instead of being written into the automations surface. Additive.
// 2.3.0 adds `api.sandbox.role()`, the signed-in user's trust tier, for affordance gating (the daemon floors
// every route regardless). Surfaced when the drafts queue moved out of the app: approve/reject are
// maintainer-and-up, and no extension could say so. Additive. The surface guard grew a `sandboxApi` member
// list with this release, so additions below the top-level grain are recorded from here on.
// 2.4.0 gives the manifest an authoring schema: `$schema` is a declared field, and every contribution point now
// carries the sentence that explains it, generated out to intentic-extension.schema.json. An editor pointed at
// that URL completes the fields, shows what each one does, and marks a key nothing declares, which used to be
// the one class of mistake nothing caught, because zod strips what it does not know rather than refusing it.
// Additive: a manifest that names no schema is unchanged.
// 2.5.0 lets an extension bring its own picture: `art` carries a complete SVG document inline, above the
// simple-icons `logo` and the host's `icon` in the same ladder. The two tiers before it could say "this is
// Slack" or "this is a server", and nothing could say "this is mine", so a page listing seven unfamiliar
// extensions drew seven near-identical glyphs, which is the shape of a directory rather than of a shelf. Inline
// rather than a URL because the row is drawn before any code is cloned: a link would put a stranger's server in
// the render path, track who is browsing, and rot after approval. Additive, a manifest that ships no drawing
// falls to exactly the mark it had before.
// 2.6.0 gives module state an owner across a sandbox switch: `sandboxRef` declares state that belongs to ONE
// sandbox and `sandboxScopeGuard` protects the write of a read that was already in flight when the switch
// happened (scope.ts). The tier existed and nothing cleared it, every extension that badges a rail tile from a
// timer kept the previous sandbox's count under the new sandbox's name, which is the one thing a badge must
// never do. Additive: an extension that keeps no module state is unchanged, and the host resets the scope
// whether or not anything registered.
// 2.7.0 adds the two halves of work an extension does while none of it is on screen (background.ts):
// `sandboxPoll`, the timer behind a rail badge, and `sandboxLedger`, the file recording what the owner has
// already seen. Seven modules across six extensions had hand-written the same poller, five invisible rules
// each, and six of the seven had the sandbox-switch one wrong, and three had hand-written the same tolerant
// reader and careful write over the same shape of file. Additive: nothing is removed, and an extension that
// keeps polling by hand still runs.
// 2.8.0 splits sandbox-scoped module state by AUDIENCE: `sandboxValue` is `sandboxRef`'s lifetime without its
// reactivity, for what a background poll remembers for itself (which connections to ask about next round, the
// cursor a fetch resumes from) rather than what a tile shows. `detect()` and `badge()` both run inside the
// host's render computed, so a `Ref` written from either is a computed mutating its own dependency. Vue
// re-runs it, it writes again, and the rail recurses until the flush is abandoned mid-frame, dropping every
// unrelated update queued behind it. The symptom is a window that stops answering, blamed on whichever
// component the loop was noticed in, so the fix has to be a box nothing observes rather than a rule to
// remember. Additive: `sandboxRef` is unchanged, and both are emptied on a switch by the same door.
// 2.9.0 adds `api.href`: the same app path the host would navigate to, as a browser address. A view that can
// only call `navigate` has to draw every destination it offers as a <button>, and a button is not a link: no
// address under the pointer, nothing in the browser's own right-click menu, nothing to copy, and Ctrl/⌘-click
// moving the tab the reader is in instead of opening a second one. Six views across three packs had each drawn
// a place that way, so the fix has to be reachable from the API rather than repeated per pack. Additive:
// `navigate` is unchanged, and it is still what a plain click calls.
// 2.10.0 adds `api.workspace.onDidChangeFiles`: the extension's own `contributes.files` being written, as an
// EVENT rather than only as a cache eviction, and `sandboxPoll` wakes on it. The declaration already reached the
// host and the host already invalidated the query keys it named, but an eviction only reaches a query something
// is observing, and a rail badge is read with nothing mounted by definition. So every tile in the workspace was
// exactly as fresh as its own interval: a drafts queue the owner had just emptied kept claiming six items, and
// the slowest tile sat ten minutes behind the file it described. Additive, and the recorded surface grew a
// `workspaceApi` member list with this release, the same grain `sandboxApi` got at 2.3.0 and for the same
// reason: this is where the addition happened, and nothing could see it.
export const extensionApiVersion = "2.10.0";
