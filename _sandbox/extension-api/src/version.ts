// The extension API's protocol version — the value `engines.intentic` ranges are matched against at load, and
// the value the host reports as IntenticApi.apiVersion. Bumped ONLY with the published package: additive
// surface = minor, breaking = major. This package is the one deliberate exception to the repo's no-legacy rule.
//
// 1.0.0 rather than 0.5.0, and the reason is the drift that forced that bump. While the major was 0 the caret
// matcher treats the MINOR as breaking (engines.ts), so every addition invalidated every declared range — which
// made bumping expensive enough that two surface changes (connectors → capabilities, api.documents.open) shipped
// without one, and the number stopped being true. At 1.x an addition is 1.1.0 and costs authors nothing, so the
// bump that keeps this honest is the cheap one. surface-guard.test.ts is what makes it non-optional.
// 2.0.0 makes listener contributions self-describing: the former `eventTypes` array became labelled `events`
// plus the automation-editor vocabulary the provider owns. That is intentionally breaking — a 1.x listener
// manifest cannot honestly promise that a generic host can configure it.
// 2.1.0 adds the backend half: a manifest `server` bundle (activateServer, run by the daemon's backend host
// under /x/<id>/…) and `permissions.daemon` beside `permissions.sandbox`. Additive — a 2.0 manifest is a 2.1
// manifest that ships no backend.
// 2.2.0 opens the automation composer: `contributes.automationTemplates` lets a pack ship the starting points
// for its own service, and a `listener` may declare a second narrowing field (`automation.branchField`) for a
// source whose events carry one. Both fold into the daemon's trigger catalogue, so a pack that knows something
// worth waking on says so itself instead of being written into the automations surface. Additive.
// 2.3.0 adds `api.sandbox.role()` — the signed-in user's trust tier, for affordance gating (the daemon floors
// every route regardless). Surfaced when the drafts queue moved out of the app: approve/reject are
// maintainer-and-up, and no extension could say so. Additive. The surface guard grew a `sandboxApi` member
// list with this release, so additions below the top-level grain are recorded from here on.
// 2.4.0 gives the manifest an authoring schema: `$schema` is a declared field, and every contribution point now
// carries the sentence that explains it, generated out to intentic-extension.schema.json. An editor pointed at
// that URL completes the fields, shows what each one does, and marks a key nothing declares — which used to be
// the one class of mistake nothing caught, because zod strips what it does not know rather than refusing it.
// Additive: a manifest that names no schema is unchanged.
// 2.5.0 lets an extension bring its own picture: `art` carries a complete SVG document inline, above the
// simple-icons `logo` and the host's `icon` in the same ladder. The two tiers before it could say "this is
// Slack" or "this is a server", and nothing could say "this is mine" — so a page listing seven unfamiliar
// extensions drew seven near-identical glyphs, which is the shape of a directory rather than of a shelf. Inline
// rather than a URL because the row is drawn before any code is cloned: a link would put a stranger's server in
// the render path, track who is browsing, and rot after approval. Additive — a manifest that ships no drawing
// falls to exactly the mark it had before.
export const extensionApiVersion = "2.5.0";
