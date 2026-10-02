import { networkCallOf, networkCallRefusal, redactNetworkAnswer } from "./network-redaction.js";

// The edges of the redaction the router integration test does not walk: which calls count as network calls, URL
// userinfo, a form-encoded token exchange, a header nobody listed, and blocks that are not text.

const answerOf = (text: string) => ({ jsonrpc: "2.0" as const, id: 1, result: { content: [{ type: "text", text }] } });

const textOf = (call: Parameters<typeof redactNetworkAnswer>[0], text: string): string =>
    JSON.stringify(redactNetworkAnswer(call, answerOf(text)).result);

const details = networkCallOf({ name: "browser_network_request", arguments: { index: 1 } });
const requestBody = networkCallOf({ name: "browser_network_request", arguments: { index: 1, part: "request-body" } });

test("only the two network tools are network calls; every other tool passes the router untouched", () => {
    expect(networkCallOf({ name: "browser_snapshot", arguments: {} })).toBeUndefined();
    expect(networkCallOf({ name: "browser_network_requests", arguments: { static: true } })).toEqual({
        name: "browser_network_requests",
        arguments: { static: true },
    });
    // A part upstream does not know is upstream's to reject; the router does not guess which redaction it would need.
    expect(networkCallOf({ name: "browser_network_request", arguments: { index: 1, part: "cookies" } })).toBeUndefined();
});

test("asking for a file is refused on both network tools, and nothing else is", () => {
    const list = networkCallOf({ name: "browser_network_requests", arguments: { filename: "net.log" } });
    expect(list === undefined ? undefined : networkCallRefusal(list)).toContain("without `filename`");
    expect(details === undefined ? undefined : networkCallRefusal(details)).toBeUndefined();
});

test("a URL loses its userinfo, fragment and query values but keeps host, path and parameter names", () => {
    if (details === undefined) {
        throw new Error("the details call did not parse");
    }
    expect(textOf(details, "### Result\n#1 [GET] https://user:pa55word@example.com/a/b?x=1&flag&empty=#frag => [302] Found")).toBe(
        JSON.stringify({ content: [{ type: "text", text: "### Result\n#1 [GET] https://example.com/a/b?x=***&flag&empty= => [302] Found" }] }),
    );
});

test("a header off the safe list keeps its name and loses its value; General's lines are not headers", () => {
    if (details === undefined) {
        throw new Error("the details call did not parse");
    }
    const text = "### Result\n  General\n    status:    [200] OK\n\n  Response headers\n    x-guest-token: 1234567890123\n    server: nginx\n";
    expect(textOf(details, text)).toBe(
        JSON.stringify({ content: [{ type: "text", text: "### Result\n  General\n    status:    [200] OK\n\n  Response headers\n    x-guest-token: ***\n    server: nginx\n" }] }),
    );
});

test("a form-encoded request body has every value masked; a JSON one only its credential-shaped values", () => {
    if (requestBody === undefined) {
        throw new Error("the request-body call did not parse");
    }
    expect(textOf(requestBody, "### Result\ngrant_type=authorization_code&code=SplxlOBeZQQYbYS6WxSbIA&code_verifier=dBjftJeZ4CVP")).toBe(
        JSON.stringify({ content: [{ type: "text", text: "### Result\ngrant_type=***&code=***&code_verifier=***" }] }),
    );
    expect(textOf(requestBody, '### Result\n{"client_secret":"9f8e7d6c5b4a","page":2}')).toBe(
        JSON.stringify({ content: [{ type: "text", text: '### Result\n{"client_secret":"***","page":2}' }] }),
    );
});

test("a block that is not text, and an error answer, pass as they came", () => {
    if (details === undefined) {
        throw new Error("the details call did not parse");
    }
    const image = { jsonrpc: "2.0" as const, id: 2, result: { content: [{ type: "image", data: "aGk=", mimeType: "image/png" }] } };
    expect(redactNetworkAnswer(details, image)).toEqual(image);
    const failed = { jsonrpc: "2.0" as const, id: 3, error: { code: -32603, message: "browser exited" } };
    expect(redactNetworkAnswer(details, failed)).toBe(failed);
});
