import { expect, test } from "vitest";
import { responseDetail } from "./response-detail.js";

// A trimmed-down real Cloudflare tunnel error page: the "Cloudflare" title plus the feedback beacon that
// embeds the numeric code.
const cfPage = (code: number): string =>
    `<!doctype html><html><head><title>Cloudflare Tunnel error | deploy.example.com | Cloudflare</title>
<script>(function(){a={event:"feedback clicked",properties:{errorCode: ${code} },helpful:a,version: 1 };})();</script>
</head><body><h1>Error</h1></body></html>`;

test("classifies the tunnel-down page (1033) with the actionable hint", async () => {
    const code = 1033;
    const detail = await responseDetail(new Response(cfPage(code), { status: 530 }));
    expect(detail).toContain(String(code));
    expect(detail).toContain("connector");
});

test("classifies other Cloudflare edge errors by code alone", async () => {
    const hinted = await responseDetail(new Response(cfPage(1033), { status: 530 }));
    const codeOnly = await responseDetail(new Response(cfPage(1016), { status: 530 }));
    expect(codeOnly).toContain("1016");
    expect(codeOnly).not.toContain("connector");
    expect(codeOnly).not.toBe(hinted);
});

test("passes short plain-text bodies through unchanged", async () => {
    expect(await responseDetail(new Response("wrong credentials", { status: 401 }))).toBe("wrong credentials");
});

test("a body that mentions an errorCode without a Cloudflare page is not misclassified", async () => {
    expect(await responseDetail(new Response("upstream said errorCode: 1033", { status: 500 }))).toBe("upstream said errorCode: 1033");
});

test("strips markup, collapses whitespace, and bounds long bodies", async () => {
    const long = `<html><body><p>${"boom ".repeat(200)}</p></body></html>`;
    const detail = await responseDetail(new Response(long, { status: 500 }));
    expect(detail.length).toBe(301);
    expect(detail.endsWith("…")).toBe(true);
    expect(detail).not.toContain("<");
});
