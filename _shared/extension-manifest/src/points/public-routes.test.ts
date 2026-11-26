import { ExtensionManifestSchema } from "../manifest.js";
import { powersOf } from "../powers-diff.js";
import { publicRouteAutomationOf, publicRouteFor, PublicRouteContributionSchema } from "./public-routes.js";

// A public route's declaration: the grammar of its path, which protections need which others, what the owner is asked
// to approve, and which declared route a request lands on, which the daemon's door reads through `publicRouteFor`.

const LISTENER = {
    provider: "crashes",
    events: [{ type: "report", label: "Reports" }],
    automation: { label: "Crashes", channel: { label: "Site", placeholder: "every site" }, starterPrompt: "A crash arrived." },
};

const manifestWith = (fields: object) => ({ publisher: "acme", name: "doors", version: "1.0.0", engines: { intentic: "^2.53.0" }, ...fields });

const issues = (declared: object): string[] => PublicRouteContributionSchema.safeParse(declared).error?.issues.map((issue) => issue.message) ?? [];

test("a path is lowercase words or a lone `*`, never a dot segment, a slash at either end, or a glob inside a word", () => {
    expect(issues({ path: "hook", methods: ["POST"] })).toEqual([]);
    expect(issues({ path: "*/report", methods: ["POST"] })).toEqual([]);
    expect(issues({ path: "sdk.js", methods: ["GET"] })).toEqual([]);
    for (const path of ["", "/hook", "hook/", "..", "a/../b", "Hook", "a*", "**", "a/b/c/d/e/f/g/h/i"]) {
        expect(issues({ path, methods: ["POST"] })).toHaveLength(1);
    }
    expect(issues({ path: "hook", methods: [] })).toHaveLength(1);
    expect(issues({ path: "hook", methods: ["OPTIONS"] })).toHaveLength(1);
});

test("a key stands in for an unlisted browser only on a route that takes a key, and a day goes uncounted only on a GET-only route", () => {
    const keyed = { path: "*/report", methods: ["POST"], automation: true, origins: "listed", key: true };
    expect(issues({ ...keyed, keyFromBrowsers: true })).toEqual([]);
    expect(issues({ ...keyed, key: undefined, keyFromBrowsers: true })).toEqual(["`keyFromBrowsers` lets the key stand in for an unlisted browser, so it needs `key: true`"]);
    expect(issues({ path: "sdk.js", methods: ["GET"], dailyMax: "none" })).toEqual([]);
    expect(issues({ path: "hook", methods: ["GET", "POST"], dailyMax: "none" })).toEqual([
        '`dailyMax: "none"` is for a route that only serves what a page loads, so its methods must be GET alone',
    ]);
    expect(issues({ path: "sdk.js", methods: ["GET"], dailyMax: "unlimited" })).toHaveLength(1);
});

test("a Turnstile check names the sandbox secret it is verified with, never a value", () => {
    expect(issues({ path: "chat", methods: ["POST"], turnstile: { secret: "TURNSTILE_SECRET" } })).toEqual([]);
    expect(issues({ path: "chat", methods: ["POST"], turnstile: { secret: "0x4AAA-not-a-name" } })).toHaveLength(1);
    expect(issues({ path: "chat", methods: ["POST"], turnstile: {} })).toHaveLength(1);
});

test("an allowlist reads an automation's origins, and a key stands in for a listed origin only", () => {
    expect(issues({ path: "hook", methods: ["POST"], origins: "listed" })).toEqual([
        '`origins: "listed"` checks an automation\'s allowed origins, so it needs `automation: true`',
    ]);
    expect(issues({ path: "*/report", methods: ["POST"], automation: true, key: true })).toEqual([
        '`key` admits a caller in place of a listed Origin, so it needs `origins: "listed"`',
    ]);
    expect(issues({ path: "report", methods: ["POST"], automation: true })).toEqual([
        "`automation` reads the automation's id from the path's first `*`, which this path has none of",
    ]);
    expect(issues({ path: "*/report", methods: ["POST"], automation: true, origins: "listed", key: true, proofOfWork: true, dailyMax: 500 })).toEqual([]);
});

test("ceilings are bounded: no body past a mebibyte, no window past 600 a minute", () => {
    expect(issues({ path: "hook", methods: ["POST"], bodyMax: 1024 * 1024 + 1 })).toHaveLength(1);
    expect(issues({ path: "hook", methods: ["POST"], rate: 601 })).toHaveLength(1);
    expect(issues({ path: "hook", methods: ["POST"], rate: 0 })).toHaveLength(1);
    expect(issues({ path: "hook", methods: ["POST"], signature: { scheme: "github", secret: "not a name" } })).toHaveLength(1);
    expect(issues({ path: "hook", methods: ["POST"], signature: { scheme: "gitlab", secret: "HOOK" } })).toHaveLength(1);
});

test("a manifest's public routes need a backend, unique paths, and its own listener for an automation's route", () => {
    const routes = [{ path: "*/report", methods: ["POST"], automation: true }];
    const messages = (manifest: object): string[] => ExtensionManifestSchema.safeParse(manifest).error?.issues.map((issue) => issue.message) ?? [];
    expect(messages(manifestWith({ contributes: { publicRoutes: routes, listener: LISTENER } }))).toEqual(["public routes need a `server` bundle to answer them"]);
    expect(messages(manifestWith({ server: "dist/server.js", contributes: { publicRoutes: routes } }))).toEqual([
        "a route scoped to an automation reads it from this extension's own `contributes.listener`, which it does not declare",
    ]);
    expect(messages(manifestWith({ server: "dist/server.js", contributes: { publicRoutes: [...routes, ...routes], listener: LISTENER } }))).toEqual([
        "public route paths must be unique",
    ]);
    expect(messages(manifestWith({ server: "dist/server.js", contributes: { publicRoutes: routes, listener: LISTENER } }))).toEqual([]);
});

test("each route is a power the owner approves, naming the secret a signed one is checked against", () => {
    const manifest = ExtensionManifestSchema.parse(
        manifestWith({
            server: "dist/server.js",
            contributes: {
                publicRoutes: [
                    { path: "stripe", methods: ["POST"], signature: { scheme: "stripe", secret: "STRIPE_WEBHOOK_SECRET" } },
                    { path: "ping", methods: ["GET", "POST"] },
                ],
                listener: { ...LISTENER, strangers: "report" },
            },
        }),
    );
    const sentences = [...powersOf(manifest).values()];
    expect(sentences).toContain("anyone on the internet can call its backend at POST /stripe when signed with your secret STRIPE_WEBHOOK_SECRET");
    expect(sentences).toContain("anyone on the internet can call its backend at GET, POST /ping");
    expect(sentences).toContain('anyone on the internet can wake an agent through its "crashes" listener');
});

test("a request lands on the first declared route its method and every segment match, and an automation is read from the first `*`", () => {
    const routes = [
        { path: "hook", methods: ["POST" as const] },
        { path: "*/report", methods: ["POST" as const], automation: true as const },
        { path: "*/config", methods: ["GET" as const] },
    ];
    expect(publicRouteFor(routes, "post", ["hook"])?.path).toBe("hook");
    expect(publicRouteFor(routes, "GET", ["hook"])).toBeUndefined();
    expect(publicRouteFor(routes, "POST", ["bugs-1", "report"])?.path).toBe("*/report");
    expect(publicRouteFor(routes, "POST", ["hook", "extra"])).toBeUndefined();
    expect(publicRouteFor(routes, "POST", ["..", "report"])).toBeUndefined();
    expect(publicRouteFor(routes, "POST", ["", "report"])).toBeUndefined();
    const report = routes[1];
    expect(report === undefined ? undefined : publicRouteAutomationOf(report, ["bugs-1", "report"])).toBe("bugs-1");
    expect(publicRouteAutomationOf({ path: "*/config" }, ["bugs-1", "config"])).toBeUndefined();
});
