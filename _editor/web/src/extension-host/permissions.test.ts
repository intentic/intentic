import { sandboxRouteAllowed } from "@intentic/extension-manifest";
import { expect, test } from "vitest";

/* Unit tests for the sandbox-route matcher the host uses to gate api.sandbox.request/json (apiImpl.ts). The
 * matcher lives in @intentic/extension-api, which ships no test harness of its own, so its consumer (the host)
 * owns the coverage. */

const perms = ["GET /panels", "POST /panels/*/start", "GET /workspace/repos/*/apps", "POST /workspace/repos/*/apps/*/start", "GET /logs/file"];

test("allows an exact method + path", () => {
    expect(sandboxRouteAllowed(perms, "GET", "/panels")).toBe(true);
});

test("matches a single glob segment", () => {
    expect(sandboxRouteAllowed(perms, "POST", "/panels/my-repo/start")).toBe(true);
    expect(sandboxRouteAllowed(perms, "POST", "/workspace/repos/intentic/apps/web/start")).toBe(true);
});

test("ignores the query string when matching", () => {
    expect(sandboxRouteAllowed(perms, "GET", "/logs/file?name=daemon.log&bytes=4096")).toBe(true);
});

test("method is compared case-insensitively", () => {
    expect(sandboxRouteAllowed(perms, "get", "/panels")).toBe(true);
});

test("refuses an undeclared path", () => {
    expect(sandboxRouteAllowed(perms, "GET", "/secrets")).toBe(false);
    expect(sandboxRouteAllowed(perms, "GET", "/panels/my-repo/logs")).toBe(false);
});

test("refuses the right path under the wrong method", () => {
    expect(sandboxRouteAllowed(perms, "DELETE", "/panels")).toBe(false);
    expect(sandboxRouteAllowed(perms, "GET", "/panels/my-repo/start")).toBe(false);
});

test("a glob segment does not cross a slash", () => {
    expect(sandboxRouteAllowed(perms, "POST", "/panels/a/b/start")).toBe(false);
});

test("an empty permission list allows nothing", () => {
    expect(sandboxRouteAllowed([], "GET", "/panels")).toBe(false);
});

test("a malformed entry throws (fail loud on a bad manifest)", () => {
    expect(() => sandboxRouteAllowed(["/panels"], "GET", "/panels")).toThrow();
});
