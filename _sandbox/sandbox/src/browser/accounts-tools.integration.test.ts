import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capability } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { accountLine } from "./accounts-tools.js";
import { markConnected } from "./session-store.js";

/* THE ROSTER'S JUDGEMENT: the line the agent reads instead of a hand-kept table, so what it says about an
 * account has to be worth acting on: which site, whether the session is live, and the two facts that answer
 * "reuse this one or open another".
 *
 * Whether an account is signed in is a MARKER ON DISK (session-store.ts), so these drive real temp trees and
 * the real writer rather than a fake: a stub of the marker would only assert that the stub was called. That
 * is what puts them under the integration budget; the module's pure half (the password policy, the site label)
 * stays beside them under the hang detector. */

test("an account's line carries whether it is signed in, what it is for, and when it was opened", async () => {
    const root = mkdtempSync(join(tmpdir(), "roster-"));
    const purpose = "launch listings";
    const openedAt = "2026-08-11";
    const account = {
        id: "producthunt-scout",
        kind: "browser",
        config: { platform: "website", homeUrl: "https://www.producthunt.com/", purpose, openedAt },
    } as Capability;

    // Before the login lands, the roster must not imply the account is usable.
    const unsigned = accountLine(root, account);
    expect(unsigned).toContain(account.id);
    expect(unsigned).toContain("www.producthunt.com");
    expect(unsigned).toContain(purpose);
    expect(unsigned).toContain(openedAt);
    expect(unsigned).toContain("not signed in yet");

    await markConnected(root, account.id);
    const signed = accountLine(root, account);
    expect(signed).toContain(account.id);
    expect(signed).toContain("· signed in ·");
    expect(signed).not.toContain("not signed in yet");
    expect(unsigned).not.toBe(signed);
});

// An account the owner connected by hand has no signup story: the line still has to read as a sentence.
test("an account with no recorded story still reads cleanly", () => {
    const root = mkdtempSync(join(tmpdir(), "roster-"));
    const account = { id: "npmjs", kind: "browser", config: { platform: "npmjs" } } as Capability;
    const line = accountLine(root, account);
    expect(line).toContain(account.id);
    expect(line).toContain("npmjs");
    expect(line).toContain("not signed in yet");
});
