import type { BrowserConfig, Capability } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import type { Keyboard, Page } from "playwright";
import { accountSites, type AccountsDeps, generatePassword, siteLabel, typeCredential } from "./accounts-tools.js";

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

// type_credential: the stored value reaches a page only on the account's own site. The page is a fake whose url, focus
// check and keyboard are all the tool touches; the site comes from the sign-in URLs the account's card resolves to.

const REDDIT_URLS = ["https://www.reddit.com/login/", "https://www.reddit.com/"];
const X_URLS = ["https://x.com/i/flow/login", "https://x.com/home"];

interface Typing {
    readonly deps: AccountsDeps;
    readonly page: Page;
    readonly typed: string[];
    readonly releases: string[];
    // Where the page is, movable mid-call to stand for a navigation while the release is decided.
    at: string;
}

const typing = (capability: Capability, signInUrls: readonly string[], at: string, onRelease?: (state: Typing) => void): Typing => {
    const typed: string[] = [];
    const releases: string[] = [];
    const state: Typing = {
        typed,
        releases,
        at,
        page: unstubbed<Page>("page", {
            url: () => state.at,
            // focusedEditable's probe: a text field has focus.
            // SAFETY: the tool reads evaluate's answer only as focusedEditable's boolean, which this fake always gives.
            evaluate: (async () => true) as Page["evaluate"],
            keyboard: unstubbed<Keyboard>("keyboard", {
                type: async (text) => {
                    typed.push(text);
                },
            }),
        }),
        deps: unstubbed<AccountsDeps>("accounts", {
            accounts: [capability.id],
            capabilities: unstubbed<AccountsDeps["capabilities"]>("capabilities", {
                get: async (id) => (id === capability.id ? capability : undefined),
            }),
            signInUrls: async () => signInUrls,
            release: async (_account, _lane, detail) => {
                releases.push(detail);
                onRelease?.(state);
                return { ok: true };
            },
        }),
    };
    return state;
};

const reddit: Capability = { id: "reddit-main", kind: "browser", config: { platform: "reddit", username: "radar", password: "Xk4!mQ2pRt7@wZ9aBc1_" } };

test("types the stored password on the account's own sign-in page", async () => {
    const state = typing(reddit, REDDIT_URLS, "https://www.reddit.com/login/");
    const result = await typeCredential(state.deps, "reddit-main", "password", () => state.page);
    expect(result).toEqual({ content: [{ type: "text", text: "typed the stored password on reddit.com (not shown)" }] });
    expect(state.typed).toEqual(["Xk4!mQ2pRt7@wZ9aBc1_"]);
    expect(state.releases).toEqual(["type the stored password for reddit-main on reddit.com"]);
});

test("a subdomain of the account's site is the account's site", async () => {
    const state = typing(reddit, REDDIT_URLS, "https://old.reddit.com/login");
    const result = await typeCredential(state.deps, "reddit-main", "username", () => state.page);
    expect(result).toEqual({ content: [{ type: "text", text: "typed the stored username on old.reddit.com: radar" }] });
    expect(state.typed).toEqual(["radar"]);
});

test("a lookalike page gets nothing, and raises no approval card", async () => {
    const lookalikes = [
        ["https://reddit-login.example/login", "reddit-login.example"],
        ["https://www.reddit.com.evil.example/login", "reddit.com.evil.example"],
        // Userinfo reads as the site to a person, not to the browser, which goes to the host after the "@".
        ["https://www.reddit.com@evil.example/login", "evil.example"],
    ] as const;
    for (const [url, host] of lookalikes) {
        for (const field of ["username", "password"] as const) {
            const state = typing(reddit, REDDIT_URLS, url);
            const result = await typeCredential(state.deps, "reddit-main", field, () => state.page);
            expect(result).toEqual({
                content: [
                    {
                        type: "text",
                        text: `this page is on ${host}, but "reddit-main" signs in on reddit.com; open the real sign-in page first. Nothing was typed`,
                    },
                ],
                isError: true,
            });
            expect(state.typed).toEqual([]);
            expect(state.releases).toEqual([]);
        }
    }
});

test("a platform's other sign-in domain is its site too", async () => {
    const x: Capability = { id: "x-main", kind: "browser", config: { platform: "x", password: "pw-x-0011" } };
    const state = typing(x, X_URLS, "https://twitter.com/i/flow/login");
    const result = await typeCredential(state.deps, "x-main", "password", () => state.page);
    expect(result).toEqual({ content: [{ type: "text", text: "typed the stored password on twitter.com (not shown)" }] });
    expect(state.typed).toEqual(["pw-x-0011"]);
});

test("an account with no known site names the page's host to whoever approves, and in the result", async () => {
    const orphan: Capability = { id: "shop", kind: "browser", config: { platform: "shopsite", password: "pw-shop-77" } };
    const state = typing(orphan, [], "https://checkout.shop.example/signin");
    const result = await typeCredential(state.deps, "shop", "password", () => state.page);
    expect(state.releases).toEqual(["type the stored password for shop on checkout.shop.example, a site nothing on record ties shop to"]);
    expect(result).toEqual({ content: [{ type: "text", text: "typed the stored password on checkout.shop.example (not shown)" }] });
    expect(state.typed).toEqual(["pw-shop-77"]);
});

test("a page that moves while the release is decided gets nothing", async () => {
    const state = typing(reddit, REDDIT_URLS, "https://www.reddit.com/login/", (moving) => {
        moving.at = "https://reddit-login.example/login";
    });
    const result = await typeCredential(state.deps, "reddit-main", "password", () => state.page);
    expect(result).toEqual({
        content: [
            { type: "text", text: "the page moved to reddit-login.example while the release was decided; nothing was typed: call this again" },
        ],
        isError: true,
    });
    expect(state.typed).toEqual([]);
});

test("an email provider's sign-in host stands for the provider's whole domain family", () => {
    expect(accountSites(["https://accounts.google.com/"])).toEqual(["google.com", "youtube.com"]);
    expect(accountSites(["https://login.live.com/"])).toEqual(["live.com", "microsoft.com", "microsoftonline.com", "outlook.com"]);
    // A site no family names stays itself, "www." dropped; one a card wrote bare reads as a site grant does.
    expect(accountSites(["https://saldeo.brainshare.pl/app/uruchamianie.html", "npmjs.com"])).toEqual(["saldeo.brainshare.pl", "npmjs.com"]);
});
