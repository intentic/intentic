// The extension API's protocol version — the value `engines.intentic` ranges are matched against at load, and
// the value the host reports as IntenticApi.apiVersion. Bumped ONLY with the published package: additive
// surface = minor, breaking = major. This package is the one deliberate exception to the repo's no-legacy rule.
//
// 1.0.0 rather than 0.5.0, and the reason is the drift that forced this bump. While the major was 0 the caret
// matcher treats the MINOR as breaking (engines.ts), so every addition invalidated every declared range — which
// made bumping expensive enough that two surface changes (connectors → capabilities, api.documents.open) shipped
// without one, and the number stopped being true. At 1.x an addition is 1.1.0 and costs authors nothing, so the
// bump that keeps this honest is the cheap one. surface-guard.test.ts is what makes it non-optional.
export const extensionApiVersion = "1.0.0";
