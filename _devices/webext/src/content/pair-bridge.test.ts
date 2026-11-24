import { fromAppWindow, isAppOrigin, senderOrigin } from "./app-origins.js";

// Who may offer this browser a pairing. Sandboxes publish pages on `*.sbx.intentic.dev`, so a bridge on every
// intentic.dev page let anyone's page offer this browser to their own sandbox; only the editor's own origin may. The
// manifest's side of it (the bridge declared on those origins alone) is store-listing.test.ts's, which reads the manifest.

test("a sandbox's published page, a look-alike host or plain http is no app origin", () => {
    expect(isAppOrigin("https://app.intentic.dev")).toBe(true);
    for (const origin of [
        "https://sandbox-abc.sbx.intentic.dev",
        "https://public-x.sbx.intentic.dev",
        "https://intentic.dev",
        "http://app.intentic.dev",
    ]) {
        expect(isAppOrigin(origin)).toBe(false);
    }
    expect(isAppOrigin("https://app.intentic.dev.evil.example")).toBe(false);
    expect(isAppOrigin(undefined)).toBe(false);
});

test("only a message the editor's own window posted to itself is relayed", () => {
    const self = {};
    const here = { window: self, origin: "https://app.intentic.dev" };
    expect(fromAppWindow({ source: self, origin: "https://app.intentic.dev" }, here)).toBe(true);
    // From a frame the page embeds, or an opener.
    expect(fromAppWindow({ source: {}, origin: "https://app.intentic.dev" }, here)).toBe(false);
    expect(fromAppWindow({ source: self, origin: "https://sandbox-abc.sbx.intentic.dev" }, here)).toBe(false);
    // The bridge somehow running on a sandbox's page relays nothing.
    const sandboxPage = { window: self, origin: "https://sandbox-abc.sbx.intentic.dev" };
    expect(fromAppWindow({ source: self, origin: "https://sandbox-abc.sbx.intentic.dev" }, sandboxPage)).toBe(false);
});

test("a sender's origin is Chrome's word for it, else its address's", () => {
    expect(senderOrigin({ origin: "https://app.intentic.dev", url: "https://elsewhere.example/" })).toBe("https://app.intentic.dev");
    expect(senderOrigin({ url: "https://app.intentic.dev/sandboxes/x" })).toBe("https://app.intentic.dev");
    expect(senderOrigin({ url: "not a url" })).toBeUndefined();
    expect(senderOrigin({})).toBeUndefined();
});
