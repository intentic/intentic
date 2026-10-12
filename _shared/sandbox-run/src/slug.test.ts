import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { sandboxIdOfToken, sandboxSlugOf, slugOfDaemonUrl, slugOfHostname } from "./slug.js";

test("slugOfDaemonUrl reads the hostname's first label, lowercased", () => {
    expect(slugOfDaemonUrl("https://Sandbox-ab12.intentic.dev:8443/x")).toBe("sandbox-ab12");
    expect(slugOfDaemonUrl("http://localhost:4000")).toBe("localhost");
});

test("slugOfDaemonUrl answers undefined rather than throwing for no address or a broken one", () => {
    expect([slugOfDaemonUrl(undefined), slugOfDaemonUrl(null), slugOfDaemonUrl(""), slugOfDaemonUrl("not a url"), slugOfDaemonUrl("https://")]).toEqual([
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
    ]);
});

test("slugOfHostname is the first label, and nothing for an empty name", () => {
    expect([slugOfHostname("My-Box.example.com"), slugOfHostname("bare"), slugOfHostname(""), slugOfHostname(".x")]).toEqual(["my-box", "bare", undefined, undefined]);
});

test("sandboxSlugOf never guesses a slug from a name that is not a sandbox container", () => {
    expect([sandboxSlugOf("intentic-sandbox-abc"), sandboxSlugOf("intentic-sandbox-"), sandboxSlugOf("postgres"), sandboxSlugOf(undefined)]).toEqual([
        "abc",
        undefined,
        undefined,
        undefined,
    ]);
});

test("sandboxIdOfToken is the node digest's first 12 hex, and undefined for an empty token", async () => {
    expect(await sandboxIdOfToken("tok_123")).toBe(createHash("sha256").update("tok_123").digest("hex").slice(0, 12));
    expect(await sandboxIdOfToken("")).toBe(undefined);
});

// SAFETY: the fixture is this package's own file; the assertions below fail on any field it lacks.
const SHARED = JSON.parse(readFileSync(new URL("./names.fixture.json", import.meta.url), "utf8")) as {
    readonly sandboxIds: { readonly vectors: { readonly token: string; readonly id: string }[] };
    readonly hostnameSlugs: { readonly vectors: { readonly hostname: string; readonly slug: string | null }[] };
};

// The same vectors ic's util.rs and the contract's sandboxIdFromToken are held to: three implementations, one digest.
test.each(SHARED.sandboxIds.vectors)("sandboxIdOfToken of $token is $id", async ({ token, id }) => {
    expect(await sandboxIdOfToken(token)).toBe(id);
});

test.each(SHARED.hostnameSlugs.vectors)("slugOfHostname reads '$hostname' the way ic names a container by it", ({ hostname, slug }) => {
    expect(slugOfHostname(hostname)).toBe(slug ?? undefined);
});
