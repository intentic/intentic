import { accessAsked } from "./webext-peer.js";

// Which of the messages bound for a person's browser is its agent asking for a site, and what the chat's card says.

test("an ask_access call names its site and reason", () => {
    expect(
        accessAsked({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "ask_access", arguments: { origin: "https://github.com", reason: "to read the PR checks" } } }),
    ).toEqual({ origin: "https://github.com", reason: "to read the PR checks" });
});

test("every other message is not one, and neither is an ask with no site", () => {
    expect(accessAsked({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "read", arguments: { tab: 1 } } })).toBeUndefined();
    expect(accessAsked({ jsonrpc: "2.0", id: 6, method: "tools/list" })).toBeUndefined();
    expect(accessAsked({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "ask_access", arguments: { reason: "no site" } } })).toBeUndefined();
    expect(accessAsked(undefined)).toBeUndefined();
});
