import { memoryPermissionStore, withDecision } from "./permission-store.js";

/* What a profile remembers each site may do: only a standing answer is kept, "ask" is the absence of one, and a site
   with no answers left leaves the file. */

const SITE = "https://maps.example";

describe("a site's decisions", () => {
    test("an allow and a block are kept per site and permission", () => {
        const once = withDecision({ sites: {} }, SITE, "geolocation", "allow");
        const twice = withDecision(once, SITE, "notifications", "block");
        expect(twice).toEqual({ sites: { [SITE]: { geolocation: "allow", notifications: "block" } } });
    });

    test("ask forgets the answer, and a site with none left goes", () => {
        const kept = withDecision({ sites: { [SITE]: { geolocation: "allow" }, "https://other.example": { camera: "block" } } }, SITE, "geolocation", "ask");
        expect(kept).toEqual({ sites: { "https://other.example": { camera: "block" } } });
    });

    test("a changed answer replaces the old one", () => {
        expect(withDecision({ sites: { [SITE]: { notifications: "allow" } } }, SITE, "notifications", "block")).toEqual({
            sites: { [SITE]: { notifications: "block" } },
        });
    });
});

describe("the store", () => {
    test("a site never answered is asked each time", async () => {
        const store = memoryPermissionStore();
        expect(await store.settingOf(SITE, "notifications")).toBe("ask");
    });

    test("answers what was set, for that site alone", async () => {
        const store = memoryPermissionStore();
        await store.set(SITE, "clipboard-read", "allow");
        expect(await store.settingOf(SITE, "clipboard-read")).toBe("allow");
        expect(await store.settingOf("https://elsewhere.example", "clipboard-read")).toBe("ask");
        expect(await store.sites()).toEqual({ [SITE]: { "clipboard-read": "allow" } });
    });
});
