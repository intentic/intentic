import { WebExtScopesSchema } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { decide, needsConfirm, originPattern, sandboxOwnOrigin, siteOf } from "./policy.js";

/* The decisions this extension makes on its own, tested away from the browser that supplies the inputs.
 *
 * Every one of these is a refusal somebody will read in a chat window, so the assertions are on the SENTENCE
 * as much as on the verdict: "not allowed on github.com — call ask_access" is the difference between an agent
 * that tells its user which switch to flip and one that reports a broken sandbox. */

const scopes = WebExtScopesSchema.parse({});

test("an origin becomes the match pattern Chrome itself shows the person", () => {
    expect(originPattern("https://github.com/intentic/intentic/pull/1")).toBe("https://github.com/*");
    expect(originPattern("http://localhost:3000/x")).toBe("http://localhost:3000/*");
    // Not an ordinary page: no extension may touch these, so there is no pattern to grant.
    expect(originPattern("chrome://settings")).toBeUndefined();
    expect(originPattern("file:///etc/passwd")).toBeUndefined();
    expect(originPattern(undefined)).toBeUndefined();
    expect(siteOf("https://mail.google.com/*")).toBe("mail.google.com");
});

test("a site nobody allowed is refused by name, with the way to ask", () => {
    const verdict = decide({ url: "https://bank.example/accounts", granted: false, mode: undefined, need: "read", scopes, paused: false });
    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.message).toContain("bank.example");
    expect(verdict.allowed === false && verdict.message).toContain("ask_access");
});

test("a read-only site can be read and not driven", () => {
    const shared = { url: "https://docs.example/page", granted: true, scopes, paused: false } as const;
    expect(decide({ ...shared, mode: "read", need: "read" }).allowed).toBe(true);
    const acting = decide({ ...shared, mode: "read", need: "act" });
    expect(acting.allowed).toBe(false);
    expect(acting.allowed === false && acting.message).toContain("reading only");
});

test("the card's switches refuse even where the site is granted", () => {
    const shared = { url: "https://docs.example/page", granted: true, mode: "act", paused: false } as const;
    const noActing = decide({ ...shared, need: "act", scopes: { ...scopes, act: "off" } });
    expect(noActing.allowed === false && noActing.message).toContain("Click and type");
    const noReading = decide({ ...shared, need: "read", scopes: { ...scopes, read: "off" } });
    expect(noReading.allowed === false && noReading.message).toContain("Read the page");
});

test("paused beats everything, and says who paused it", () => {
    const verdict = decide({ url: "https://docs.example/page", granted: true, mode: "act", need: "read", scopes, paused: true });
    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.message).toContain("paused");
});

test("a browser-internal page is refused before the grant question is even asked", () => {
    const verdict = decide({ url: "chrome://extensions", granted: true, mode: "act", need: "read", scopes, paused: false });
    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.message).toContain("not an ordinary web page");
});

test("confirmation follows the switch, and 'sensitive' is what the page said", () => {
    expect(needsConfirm({ ...scopes, confirm: "sensitive" }, true)).toBe(true);
    expect(needsConfirm({ ...scopes, confirm: "sensitive" }, false)).toBe(false);
    expect(needsConfirm({ ...scopes, confirm: "always" }, false)).toBe(true);
    // "never" is the owner saying they will watch instead — which they can, because they are looking at the tab.
    expect(needsConfirm({ ...scopes, confirm: "never" }, true)).toBe(false);
});

/* The permission that exists so the extension can REACH its sandbox must not double as permission to browse
 * the sandbox's own app — which would let an agent click its own approval dialogs and read other
 * conversations. It is the one origin that is granted and still refused. */
test("the sandbox's own app is never a site the agent may work on", () => {
    const own = sandboxOwnOrigin("https://sandbox-abc123.intentic.dev");
    expect(own).toBe("https://sandbox-abc123.intentic.dev/*");
    const verdict = decide({
        url: "https://sandbox-abc123.intentic.dev/capabilities",
        granted: true,
        mode: "act",
        need: "read",
        scopes,
        paused: false,
        own,
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.message).toContain("sandbox's own app");
    // A different sandbox-shaped host is an ordinary site: only THIS browser's own sandbox is subtracted.
    expect(
        decide({ url: "https://sandbox-other.intentic.dev/x", granted: true, mode: "act", need: "read", scopes, paused: false, own }).allowed,
    ).toBe(true);
});

test("an unpaired browser has no own origin to subtract", () => {
    expect(sandboxOwnOrigin(undefined)).toBeUndefined();
    expect(sandboxOwnOrigin("not a url")).toBeUndefined();
});
