import { ENGINE_IDS } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { ENGINE_DESCRIPTORS, engineDescriptor } from "./engine-descriptors.js";

/* THE TABLE HAS TO BE TOTAL, and the floors in it have to be the versions the image really carries. Both are
 * guarded by DISCOVERY rather than by a second list: an engine added to the contract and forgotten here would
 * otherwise ship as a card row whose store, channel and floor silently do not exist. */

test("every engine the contract names has a descriptor, and no descriptor names an engine it does not", () => {
    expect(ENGINE_DESCRIPTORS.map((descriptor) => descriptor.id).toSorted()).toEqual([...ENGINE_IDS].toSorted());
});

/* The floor is READ from the pack the image builds with (or, for Claude, from the daemon's own dependency), so
 * a pin that moves in one place cannot leave the other describing a version nobody installed. A pack that stops
 * naming exactly one version reads as no floor, which this would catch as an undefined. */
test("each engine's floor is the version this build actually pins", async () => {
    for (const descriptor of ENGINE_DESCRIPTORS) {
        expect(await descriptor.baked(), `${descriptor.id} floor`).toMatch(/^\d+\.\d+\.\d+/);
    }
});

/* CLAUDE'S TWO VOCABULARIES. npm publishes 0.3.N, the program calls itself Claude Code 2.1.N, and the API
 * states its floors in the second. Comparing them the ordinary way answers "no version has ever satisfied
 * this", which would turn the one failure this whole mechanism exists for into an unfixable one. */
test("a Claude floor in CLI numbers is read by the component the two share", () => {
    const claude = engineDescriptor("claude");
    expect(claude.satisfiesFloor?.("0.3.257", "2.1.251")).toBe(true);
    expect(claude.satisfiesFloor?.("0.3.233", "2.1.251")).toBe(false);
    expect(claude.satisfiesFloor?.("0.3.251", "2.1.251")).toBe(true);
});

test("a Claude floor in the package's own numbers compares as versions", () => {
    const claude = engineDescriptor("claude");
    expect(claude.satisfiesFloor?.("0.3.257", "0.3.251")).toBe(true);
    expect(claude.satisfiesFloor?.("0.3.251", "0.3.251")).toBe(true);
    expect(claude.satisfiesFloor?.("0.3.240", "0.3.251")).toBe(false);
});

// Only the engine loaded IN this process has two vocabularies to reconcile; the rest are what they are called.
test("the spawned engines report the version they are published under", () => {
    for (const descriptor of ENGINE_DESCRIPTORS.filter((candidate) => candidate.id !== "claude")) {
        expect(descriptor.satisfiesFloor, `${descriptor.id}`).toBeUndefined();
        expect(descriptor.reportedVersion, `${descriptor.id}`).toBeUndefined();
    }
});
