import { ExtensionManifestSchema } from "./manifest.js";
import { extensionRouteReach, permissionProblem, sandboxRouteAllowed } from "./permissions.js";

// The glob grammar: each segment of the declared path is literal or a lone `*`, and a `*` matches one whole segment
// that the URL layer would route rather than resolve away.

describe("sandboxRouteAllowed", () => {
    test.each([
        ["an exact route", "GET /panels", "GET", "/panels", true],
        ["the root", "GET /", "GET", "/", true],
        ["a trailing slash is its own route", "GET /panels", "GET", "/panels/", false],
        ["a `*` matches one segment", "POST /panels/*/start", "POST", "/panels/my-repo/start", true],
        ["two `*`s, two segments", "POST /workspace/repos/*/apps/*/start", "POST", "/workspace/repos/intentic/apps/web/start", true],
        ["a `*` matches an encoded slash, which stays inside its segment", "GET /git/*/log", "GET", "/git/a%2Fb/log", true],
        ["a `*` matches a segment holding dots", "GET /git/*/log", "GET", "/git/.config/log", true],
        ["a `*` matches a segment of dots beyond two", "GET /git/*/log", "GET", "/git/.../log", true],
        ["a `*` never matches an empty segment", "POST /panels/*/start", "POST", "/panels//start", false],
        ["a `*` never crosses a slash", "POST /panels/*/start", "POST", "/panels/a/b/start", false],
        ["a `*` never matches `..`, which resolves to /start", "POST /panels/*/start", "POST", "/panels/../start", false],
        ["a `*` never matches `.`", "POST /panels/*/start", "POST", "/panels/./start", false],
        ["a `*` never matches an encoded `..`", "DELETE /approvals/*", "DELETE", "/approvals/%2e%2E", false],
        ["a `*` never matches a half-encoded `..`", "DELETE /approvals/*", "DELETE", "/approvals/.%2e", false],
        ["a `*` never matches a backslash, which a URL reads as a slash", "POST /panels/*/start", "POST", "/panels/..\\..\\secrets/start", false],
        ["the query string is ignored", "GET /logs/file", "GET", "/logs/file?name=daemon.log&bytes=4096", true],
        ["the method is case-insensitive", "get /panels", "GET", "/panels", true],
        ["the asked method is case-insensitive", "GET /panels", "get", "/panels", true],
        ["the wrong method", "GET /panels/*/start", "POST", "/panels/a/start", false],
        ["an undeclared path", "GET /panels", "GET", "/secrets", false],
        ["a relative path", "GET /panels", "GET", "panels", false],
    ] as const)("%s", (_name, entry, method, path, allowed) => {
        expect(sandboxRouteAllowed([entry], method, path)).toBe(allowed);
    });

    test("any declared entry covering the call is enough", () => {
        expect(sandboxRouteAllowed(["GET /panels", "POST /panels/*/start"], "POST", "/panels/a/start")).toBe(true);
    });

    test("an empty permission list allows nothing", () => {
        expect(sandboxRouteAllowed([], "GET", "/panels")).toBe(false);
    });

    test("a malformed entry throws, naming itself", () => {
        expect(() => sandboxRouteAllowed(["/panels"], "GET", "/panels")).toThrow(
            `invalid permission "/panels": expected "<METHOD> <path-glob>", e.g. "GET /panels"`,
        );
    });
});

describe("permissionProblem", () => {
    test.each(["GET /panels", "post /panels/*/start", "  DELETE   /approvals/*  ", "PUT /secrets/*", "GET /", "HEAD /panels/"])("%s is well formed", (entry) => {
        expect(permissionProblem(entry)).toBe(undefined);
    });

    test.each([
        ["/panels", `expected "<METHOD> <path-glob>", e.g. "GET /panels"`],
        ["GET", `expected "<METHOD> <path-glob>", e.g. "GET /panels"`],
        ["GET /panels extra", `expected "<METHOD> <path-glob>", e.g. "GET /panels"`],
        ["FETCH /panels", `"FETCH" is not one of GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS`],
        ["GET panels", `the path must start with "/"`],
        ["GET /logs/file?name=x", `the path may not hold "?", "#" or "\\": routes are matched on the path alone`],
        ["GET /panels#top", `the path may not hold "?", "#" or "\\": routes are matched on the path alone`],
        ["GET /panels\\x", `the path may not hold "?", "#" or "\\": routes are matched on the path alone`],
        [
            "GET /files/**",
            `"**" is not a segment glob: a \`*\` stands alone between slashes and matches one whole segment, so \`**\` and a \`*\` inside a segment are not supported`,
        ],
        [
            "GET /files/*.json",
            `"*.json" is not a segment glob: a \`*\` stands alone between slashes and matches one whole segment, so \`**\` and a \`*\` inside a segment are not supported`,
        ],
        ["GET /panels/../secrets", `".." is not a route segment: the URL resolves it away before any route sees it`],
        ["GET /panels/%2E/x", `"%2E" is not a route segment: the URL resolves it away before any route sees it`],
    ])("%s is refused", (entry, problem) => {
        expect(permissionProblem(entry)).toBe(`invalid permission "${entry}": ${problem}`);
    });
});

describe("a manifest's permissions", () => {
    const parse = (permissions: object) =>
        ExtensionManifestSchema.safeParse({ publisher: "acme", name: "demo", version: "1.0.0", engines: { intentic: "^1.0.0" }, permissions });

    test("well-formed entries parse", () => {
        expect(parse({ sandbox: ["GET /panels"], daemon: ["POST /panels/*/start"] }).data?.permissions).toEqual({
            sandbox: ["GET /panels"],
            daemon: ["POST /panels/*/start"],
        });
    });

    test.each(["sandbox", "daemon"])("a malformed %s entry fails the parse, at the entry, with the reason", (half) => {
        expect(parse({ [half]: ["GET /panels", "GET /files/**"] }).error?.issues).toEqual([
            {
                code: "custom",
                path: ["permissions", half, 1],
                message: `invalid permission "GET /files/**": "**" is not a segment glob: a \`*\` stands alone between slashes and matches one whole segment, so \`**\` and a \`*\` inside a segment are not supported`,
            },
        ]);
    });
});

describe("extensionRouteReach", () => {
    const gateway = { permissions: ["GET /ports"], listener: "slack" };
    test.each([
        ["its own settings, undeclared", "GET", "/extension/settings", true],
        ["its own event stream, undeclared", "GET", "/extension/events", true],
        ["no write through its own routes", "POST", "/extension/settings", false],
        ["what it declared", "GET", "/ports", true],
        ["what it did not declare", "GET", "/agents", false],
        ["its own provider's listener route", "GET", "/listeners/slack/state", true],
        ["another provider's listener route, however it is declared", "GET", "/listeners/discord/state", false],
        ["a provider spelled to decode into its own", "GET", "/listeners/sl%61ck/state", false],
    ])("%s", (_name, method, path, expected) => {
        expect(extensionRouteReach(gateway, method, path)).toBe(expected);
    });

    test("an extension without a listener reaches no listener route, even one it globbed", () => {
        expect(extensionRouteReach({ permissions: ["GET /listeners/*/state"] }, "GET", "/listeners/slack/state")).toBe(false);
    });
});
