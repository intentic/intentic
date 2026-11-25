// Pins which lock entries a lagging door owns and when its shrink against the last release passes: never on a door
// with no floor, and on one with a floor only for a retired surface that floor has reached.
import assert from "node:assert/strict";
import { test } from "node:test";
import { doorEntries, uncoveredShrinks } from "./lib/release-doors.mjs";

const PHONE = { id: "phone app", routes: "/system/phones/" };
const NETD = { id: "sandbox netd", peer: "daemon", wires: ["wire:tunnel"] };
const FLOORS = new Map([["daemon", "1.249.0"]]);

const base = {
    PhoneFactsSchema: { properties: { sdk: { type: "number" }, build: { type: "string" } } },
    EditorOnlySchema: { type: "string" },
    PhonePasswordsFillSchema: { type: "object" },
    "access:GET /system/phones/connect": { auth: "door", floor: "viewer" },
    "access:DELETE /system/phones/{id}": { auth: "session", floor: "maintainer" },
    "wire:tunnel": { path: "/tunnel/v2" },
};

test("a door owns the schemas its modules and its raw routes name, its far end's routes and its wires", () => {
    const rawJsonTexts = [`    "POST /system/phones/passwords/fill": { input: PhonePasswordsFillSchema },\n    "GET /system/other": { output: EditorOnlySchema },`];
    const head = { ...base, "access:POST /system/phones/passwords/fill": { auth: "door" } };
    assert.deepEqual(doorEntries(PHONE, { moduleTexts: ["describe: oc.output(PhoneFactsSchema)"], rawJsonTexts, base, head }), [
        "PhoneFactsSchema",
        "PhonePasswordsFillSchema",
        "access:GET /system/phones/connect",
        "access:POST /system/phones/passwords/fill",
    ]);
    assert.deepEqual(doorEntries(NETD, { moduleTexts: [], rawJsonTexts: [], base, head: base }), ["wire:tunnel"]);
});

test("a door with no floor cannot shrink, whatever is retired", () => {
    const head = { ...base, PhoneFactsSchema: { properties: { sdk: { type: "number" } } } };
    const entries = ["PhoneFactsSchema", "EditorOnlySchema"];
    const retired = [{ door: "phone app", surface: "PhoneFactsSchema.properties.build", unusedSince: "1.0.0" }];
    assert.deepEqual(uncoveredShrinks({ door: PHONE, base, head, entries, floors: FLOORS, retired }), ["PhoneFactsSchema.properties.build"]);
    assert.deepEqual(uncoveredShrinks({ door: PHONE, base, head: { ...base, EditorOnlySchema: {} }, entries: ["PhoneFactsSchema"], floors: FLOORS }), []);
});

test("a golden file shrinks like the lock, and one gone is a shrink", () => {
    const goldens = [
        ["golden/phone-wire.json", `{"hello":{"version":"1.0.0","token":"x"}}`, `{"hello":{"version":"1.0.0"}}`],
        ["golden/gone.json", `{}`, undefined],
    ];
    assert.deepEqual(uncoveredShrinks({ door: PHONE, base, head: base, entries: [], goldens, floors: FLOORS }), ["golden/phone-wire.json:hello.token", "golden/gone.json:"]);
});

test("a retirement passes only once the floor reaches the release that stopped using it", () => {
    const head = { ...base, "wire:tunnel": { path: "/tunnel/v3" } };
    const shrinks = (unusedSince, surface = "wire:tunnel.") =>
        uncoveredShrinks({ door: NETD, base, head, entries: ["wire:tunnel"], floors: FLOORS, retired: [{ door: "sandbox netd", surface, unusedSince }] });
    assert.deepEqual(shrinks("1.249.0"), []);
    assert.deepEqual(shrinks("1.200.0"), []);
    assert.deepEqual(shrinks("1.250.0"), ["wire:tunnel.path"]);
    assert.deepEqual(shrinks("1.200.0", "wire:tunnel.other"), ["wire:tunnel.path"]);
});
