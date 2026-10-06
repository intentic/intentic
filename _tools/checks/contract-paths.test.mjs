// Pins which literals contract-paths reads as a spelled route: an absolute path, a path joined to a base, and neither
// once it is a screen of the app's own or excused at its site.
import assert from "node:assert/strict";
import { test } from "node:test";
import { spelledRoutes } from "./lib/route-literals.mjs";

const table = { routes: ["/system/session", "/secrets/{key}", "/agents/{id}"], appRoutes: ["/agents/:id?"] };
const spelled = (code) => spelledRoutes(code, table);

test("an absolute path is judged, and so is one joined to a base", () => {
    assert.deepEqual(spelled("fetch(`/system/session`);"), [{ line: 1, route: "/system/session" }]);
    assert.deepEqual(spelled("const a = 1;\nfetch(`${target.base}/system/session`, { method: `POST` });"), [{ line: 2, route: "/system/session" }]);
    assert.deepEqual(spelled("fetch(`${base}/secrets/${key}?reveal=1`);"), [{ line: 1, route: "/secrets/{key}" }]);
});

test("only a leading substitution is a base: text before it, a second one, or no slash after it is not a route", () => {
    assert.deepEqual(spelled("const a = `v1${x}/system/session`;"), []);
    assert.deepEqual(spelled("const a = `${host}${port}/system/session`;"), []);
    assert.deepEqual(spelled("const a = `${base}system/session`;"), []);
    assert.deepEqual(spelled("const a = `${base}/system/session/extra`;"), []);
});

test("a based path to one of the app's screens is navigation unless its line calls the daemon", () => {
    assert.deepEqual(spelled("const link = `${location.origin}/agents/${id}`;"), []);
    assert.deepEqual(spelled("await sandboxJson(`${base}/agents/${id}`);"), [{ line: 1, route: "/agents/{id}" }]);
});

test("a based path inside a code sample shipped as a string keeps the file's line", () => {
    assert.deepEqual(spelled('const one = 1;\nconst sample = "await fetch(`${base}/system/session`)";'), [{ line: 2, route: "/system/session" }]);
});

test("a site that says why it spells the route is excused, on its line or in the comment block above it", () => {
    assert.deepEqual(spelled("fetch(`${base}/system/session`); // allow(contract-paths): mints the session the client needs"), []);
    assert.deepEqual(spelled("// allow(contract-paths): a directory under the state dir, not a route\nconst dir = `${STATE_DIR}/secrets/auth`;"), []);
    assert.deepEqual(spelled("// allow(contract-paths):\nconst dir = `${STATE_DIR}/secrets/auth`;"), [{ line: 2, route: "/secrets/{key}" }]);
});

test("a platform route spelled in the daemon is judged against the ingress table the same way", () => {
    const platform = { routes: ["/sandbox/announce", "/host-report", "/api/reachability/{sandboxId}"], appRoutes: [] };
    assert.deepEqual(spelledRoutes('await post("/sandbox/announce", body);', platform), [{ line: 1, route: "/sandbox/announce" }]);
    assert.deepEqual(spelledRoutes("fetch(`${config.platform.url}/api/reachability/${id}`);", platform), [
        { line: 1, route: "/api/reachability/{sandboxId}" },
    ]);
    assert.deepEqual(spelledRoutes('await post("/sandbox/announce", body); // allow(contract-paths): a stand-in platform', platform), []);
});

test("a segment built around punctuation alone spells no route, one carrying a word still does", () => {
    const platform = { routes: ["/host-report"], appRoutes: [] };
    assert.deepEqual(spelledRoutes("const file = `${SHARE_FILES_DIR}/${count}-${base}`;", platform), []);
    assert.deepEqual(spelledRoutes("const url = `${platform}/host-${kind}`;", platform), [{ line: 1, route: "/host-report" }]);
});
