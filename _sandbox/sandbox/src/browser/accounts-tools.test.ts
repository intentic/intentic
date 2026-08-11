import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserConfig, Capability } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { accountLine, generatePassword, siteLabel } from "./accounts-tools.js";
import { markConnected } from "./session-store.js";

/* The generator is the one pure piece of the accounts tools (the rest is SDK-tool wiring over the stores, the
 * hashline precedent), and it mints REAL credentials — so what is worth holding is the policy: long enough,
 * every class present (sites that demand "one uppercase, one digit, one symbol" must never bounce a generated
 * password into a retry loop the agent cannot see the reason for), and drawn from the conservative symbol set
 * virtually every policy accepts. */
test("a generated password satisfies the strictest common site policy", () => {
    for (let round = 0; round < 50; round += 1) {
        const password = generatePassword();
        expect(password).toHaveLength(20);
        expect(password).toMatch(/[a-z]/);
        expect(password).toMatch(/[A-Z]/);
        expect(password).toMatch(/[0-9]/);
        expect(password).toMatch(/[!@#$%^*\-_+=]/);
        // Nothing outside the declared sets — an exotic character is a character some site rejects.
        expect(password).toMatch(/^[a-zA-Z0-9!@#$%^*\-_+=]+$/);
    }
});

test("two generated passwords are never the same credential", () => {
    const minted = new Set(Array.from({ length: 200 }, () => generatePassword()));
    expect(minted.size).toBe(200);
});

/* THE ROSTER'S JUDGEMENT — the other piece here that is a decision rather than wiring. This is what the agent
 * reads instead of a hand-kept table, so what it says about an account has to be worth acting on: which site,
 * whether the session is live, and the two facts that answer "reuse this one or open another". */

// An account on the generic card would otherwise print "website", which is the card and not the site.
test("names an account by its site, not by the card it rides", () => {
    expect(siteLabel({ platform: "reddit" } as BrowserConfig)).toBe("reddit");
    expect(siteLabel({ platform: "website", homeUrl: "https://www.producthunt.com/" } as unknown as BrowserConfig)).toBe("www.producthunt.com");
    // Nothing usable to parse ⇒ the slug, rather than an exception in the middle of the roster.
    expect(siteLabel({ platform: "website", homeUrl: "not a url" } as unknown as BrowserConfig)).toBe("website");
});

test("an account's line carries whether it is signed in, what it is for, and when it was opened", async () => {
    const root = mkdtempSync(join(tmpdir(), "roster-"));
    const account = {
        id: "producthunt-scout",
        kind: "browser",
        config: { platform: "website", homeUrl: "https://www.producthunt.com/", purpose: "launch listings", openedAt: "2026-08-11" },
    } as Capability;

    // Before the login lands, the roster must not imply the account is usable.
    expect(accountLine(root, account)).toBe("  producthunt-scout · www.producthunt.com · not signed in yet · launch listings · opened 2026-08-11");

    await markConnected(root, account.id);
    expect(accountLine(root, account)).toContain("· signed in ·");
});

// An account the owner connected by hand has no signup story — the line still has to read as a sentence.
test("an account with no recorded story still reads cleanly", () => {
    const root = mkdtempSync(join(tmpdir(), "roster-"));
    expect(accountLine(root, { id: "npmjs", kind: "browser", config: { platform: "npmjs" } } as Capability)).toBe(
        "  npmjs · npmjs · not signed in yet",
    );
});
