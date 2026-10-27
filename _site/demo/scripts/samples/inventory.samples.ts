import type { GroupSamples } from "./context.ts";

// A service declared and taken back out, leaving the inventory as it was.
export const inventorySamples: GroupSamples<`inventory`> = () => ({
    list: undefined,
    add: { kind: `service`, service: `outline`, name: `wiki`, values: { domain: `wiki.acme.dev` }, on: `fsn1`, expose: `acme_dev` },
    remove: { name: `wiki` },
});
