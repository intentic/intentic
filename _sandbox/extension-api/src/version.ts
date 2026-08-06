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
export const extensionApiVersion = "2.0.0";
