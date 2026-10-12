// Pins what daemon-doors reads as reaching the daemon around sandboxRaw: a path spelled to the bare client in any of the
// ways it is called, and a fetch of a route-table path, and never a comment quoting the shape, a path held in a variable
// or a site that says why it must stay.
import assert from "node:assert/strict";
import { test } from "node:test";
import { daemonDoorCalls } from "./lib/daemon-door-calls.mjs";

const lines = (text) => daemonDoorCalls(text).map(({ line }) => line);

test("a path spelled to sandboxJson or sandboxRequest is judged however the call is written", () => {
    assert.deepEqual(
        lines(
            [
                "await sandboxJson(`/system/runners`);",
                "const { ticket } = await sandboxJson<{ ticket: string }>(`/bundles/ticket?name=${name}`, { method: `POST` });",
                "const response = await sandboxRequest(\"/system/sync\");",
                "await (deps.post ?? sandboxRequest)(`/system/phones/${id}/wake`, { method: `POST` });",
                "return deps.sandboxJson<SpeechStatus>(`/speech/status?${query}`, { signal });",
            ].join("\n"),
        ),
        [1, 2, 3, 4, 5],
    );
});

test("a path in a variable, an imported name, sandboxRaw by its key and the typed client are not spellings", () => {
    assert.deepEqual(lines("await sandboxJson(call.path);\nconst path = `/system/runners`;\nawait sandboxRequest(backendPath(path), init);"), []);
    assert.deepEqual(lines("import { sandboxJson, sandboxRequest } from \"./sandboxClient\";\nawait sandboxRaw(`GET /system/runners`);"), []);
    assert.deepEqual(lines("await sandboxRpc.system.devices();\nawait sandboxBlob(`/workspace/raw?path=a`);"), []);
});

test("a fetch of a route-table path goes around the door, and a rawRouteUrl for a navigation does not", () => {
    assert.deepEqual(lines("return fetch(`${base}${rawRouteUrl(route)}`, { method });"), [1]);
    assert.deepEqual(lines("const health = await probeFetch(`${daemonUrl}${rawRouteUrl(`GET /health`)}`);"), [1]);
    assert.deepEqual(lines("return `${base}${rawRouteUrl(`GET /bundles/download`)}?${query}`;"), []);
    assert.deepEqual(lines("const response = await fetch(url);\nconst path = rawRouteUrl(`GET /health`);"), []);
});

test("a comment quoting the shape is not a site, and a site that says why is excused only with a reason", () => {
    assert.deepEqual(lines("// never sandboxJson(`/members`)\n/*\n * sandboxRequest(`/system/sync`)\n */"), []);
    assert.deepEqual(lines("// allow(daemon-doors): reaches a daemon this page has no session on yet\nreturn fetch(`${base}${rawRouteUrl(route)}`);"), []);
    assert.deepEqual(lines("await sandboxJson(`/system/runners`); // allow(daemon-doors): the one raw read"), []);
    assert.deepEqual(lines("// allow(daemon-doors):\nawait sandboxJson(`/system/runners`);"), [2]);
});
