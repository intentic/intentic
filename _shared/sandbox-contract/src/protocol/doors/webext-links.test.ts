import { parseWebextPairingCode, webextPairingCode } from "./webext-links.js";

// The browser extension's pairing code. Since 2026-10-28 it may carry the sandbox's name, so an extension paired with
// several sandboxes lists each by what its owner calls it rather than by `sandbox-<hex>.<domain>`.

const SANDBOX_URL = "https://sandbox-82789f4106b4.example.dev";

test("a code carries the sandbox's name both ways, in any script", () => {
    expect(parseWebextPairingCode(webextPairingCode({ url: SANDBOX_URL, token: "pair-1", name: "intentic" }))).toEqual({ url: SANDBOX_URL, token: "pair-1", name: "intentic" });
    // btoa alone refuses anything outside Latin-1, which a name may well be.
    expect(parseWebextPairingCode(webextPairingCode({ url: SANDBOX_URL, token: "pair-1", name: "Zażółć — 项目" }))?.name).toBe("Zażółć — 项目");
});

test("a code without a name is still a whole code, and so is one an older sandbox made", () => {
    expect(parseWebextPairingCode(webextPairingCode({ url: SANDBOX_URL, token: "pair-1" }))).toEqual({ url: SANDBOX_URL, token: "pair-1" });
    expect(parseWebextPairingCode(webextPairingCode({ url: SANDBOX_URL, token: "pair-1", name: "  " }))).toEqual({ url: SANDBOX_URL, token: "pair-1" });
    // What a sandbox before names wrote: base64url of {url, token} alone.
    const older = `ixb1_${btoa(JSON.stringify({ url: SANDBOX_URL, token: "pair-1" })).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}`;
    expect(parseWebextPairingCode(older)).toEqual({ url: SANDBOX_URL, token: "pair-1" });
});

test("a name that is not a string is dropped and a long one is cut, while the code still pairs", () => {
    const odd = (payload: object): string => `ixb1_${btoa(JSON.stringify(payload)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}`;
    expect(parseWebextPairingCode(odd({ url: SANDBOX_URL, token: "pair-1", name: 7 }))).toEqual({ url: SANDBOX_URL, token: "pair-1" });
    expect(parseWebextPairingCode(webextPairingCode({ url: SANDBOX_URL, token: "pair-1", name: "x".repeat(200) }))?.name).toHaveLength(80);
    expect(parseWebextPairingCode(odd({ url: "ftp://nope", token: "pair-1" }))).toBeUndefined();
    expect(parseWebextPairingCode("not a code")).toBeUndefined();
});
