import { kindsWhere } from "@intentic/sandbox-contract/policy/capabilities/capability-kinds";
import { CapabilityKindSchema } from "@intentic/sandbox-contract/schemas/capabilities";
import { CAPABILITY_CATALOG } from "./index.js";

// The built-in tiles are exactly the kinds whose row says `tile: "catalog"`; the rest are cards an extension contributes
// (the contract's own test holds those to the manifest's arms), so between them every kind has a tile.
test("the catalog's kinds are the kinds whose tile is the catalog's", () => {
    const catalog = [...new Set(CAPABILITY_CATALOG.map((entry) => entry.kind))].toSorted();
    expect(catalog).toEqual([...kindsWhere((traits) => traits.tile === "catalog")].toSorted());
    const cards = kindsWhere((traits) => traits.tile === "card");
    expect([...catalog, ...cards].toSorted()).toEqual([...CapabilityKindSchema.options].toSorted());
});
