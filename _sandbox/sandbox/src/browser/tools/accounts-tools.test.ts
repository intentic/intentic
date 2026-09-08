import type { BrowserConfig } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { generatePassword, siteLabel } from "./accounts-tools.js";

// Every character class present, since a generated password must never fail a site's complexity check without the agent
// seeing why.
test("a generated password satisfies the strictest common site policy", () => {
    for (let round = 0; round < 50; round += 1) {
        const password = generatePassword();
        expect(password).toHaveLength(20);
        expect(password).toMatch(/[a-z]/);
        expect(password).toMatch(/[A-Z]/);
        expect(password).toMatch(/[0-9]/);
        expect(password).toMatch(/[!@#$%^*\-_+=]/);
        // No characters outside the declared sets; an exotic one is a character some site rejects.
        expect(password).toMatch(/^[a-zA-Z0-9!@#$%^*\-_+=]+$/);
    }
});

test("two generated passwords are never the same credential", () => {
    const minted = new Set(Array.from({ length: 200 }, () => generatePassword()));
    expect(minted.size).toBe(200);
});

// siteLabel: which name an account is announced under. Pure string work; signed-in state is a disk marker, tested in
// accounts-tools.integration.test.ts.

// The generic card's platform is literally 'website', not a site name.
test("names an account by its site, not by the card it rides", () => {
    expect(siteLabel({ platform: "reddit" } as BrowserConfig)).toBe("reddit");
    expect(siteLabel({ platform: "website", homeUrl: "https://www.producthunt.com/" } as unknown as BrowserConfig)).toBe("www.producthunt.com");
    // Unparseable url falls back to the platform slug, not an exception.
    expect(siteLabel({ platform: "website", homeUrl: "not a url" } as unknown as BrowserConfig)).toBe("website");
});
