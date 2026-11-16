import type { DeviceSandbox } from "@intentic/sandbox-contract/schemas/devices";

// Which container a name means, or the machine's own answer that it means none: one lookup for every op, so a wrong
// name gets the same sentence whichever button sent it, and so a flow that will take minutes is refused now. A name is
// what list_sandboxes shows for a sandbox, whichever column it was copied from: its slug, its 12-hex sandbox id (a
// sandbox set up from the platform runs as `sandbox-<id>`), its container name, or the owner's name for it, each matched
// whatever its case (agents were refused all but the first, 2026-11). A name two sandboxes share names neither and says
// which to pick from. A sandbox an interrupted swap left parked is listed under its own slug, not running, and is found
// like any other: start, rollback and update are exactly what bring it back. Pure.
export const findIn = (boxes: readonly DeviceSandbox[], given: string): DeviceSandbox => {
    const exact = boxes.find((box) => box.slug === given);
    if (exact !== undefined) {
        return exact;
    }
    const wanted = given.trim().toLowerCase();
    const byKey = (key: (box: DeviceSandbox) => readonly (string | undefined)[]): DeviceSandbox[] => {
        const found = boxes.filter((box) => wanted !== "" && key(box).some((name) => name?.trim().toLowerCase() === wanted));
        return found.filter((box, index) => found.findIndex((other) => other.slug === box.slug) === index);
    };
    const shown = (box: DeviceSandbox): string =>
        `${box.slug}${box.name === undefined ? "" : ` ("${box.name}")`}${box.parked === true ? " (parked mid-swap)" : ""}`;
    for (const matches of [
        byKey((box) => [box.slug, `sandbox-${wanted}` === box.slug.toLowerCase() ? wanted : undefined]),
        byKey((box) => [box.container, box.container.replace(/\.previous$/, "")]),
        byKey((box) => [box.name]),
    ]) {
        const [first, ...rest] = matches;
        if (first !== undefined && rest.length === 0) {
            return first;
        }
        if (first !== undefined) {
            throw new Error(`${matches.length} sandboxes on this device are named "${given}": ${matches.map(shown).join(", ")}. Name one by its slug.`);
        }
    }
    const known = boxes.map(shown).join(", ");
    throw new Error(`No sandbox "${given}" on this device. ${known === "" ? "It runs none." : `It has: ${known}.`}`);
};
