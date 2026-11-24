// The facts line's per-kind table sits beside connectionRows.ts rather than in the editor's slot registry
// (kinds/kindSlots.ts), which imports every pairing dialog and form part: the Sandbox map reads these lines through
// connectionRows.ts, and must not pull the Capabilities page's components in with them.
jest.mock(`../kinds/kindSlots`, () => {
    throw new Error(`connectionRows.ts must not import the slot registry`);
});

import { CapabilityKindSchema, type CapabilitySummary } from "@intentic/sandbox-contract/schemas/capabilities";
import { tileRowFacts } from "./connectionRows";
import { type ConnectionSources, ROW_FACTS } from "./rowFacts";

it(`reads a row's facts without the slot registry, for the kinds a live source knows more of`, () => {
    expect([...ROW_FACTS.keys()]).toEqual(CapabilityKindSchema.options.filter((kind) => ROW_FACTS.has(kind)));
    expect([...ROW_FACTS.keys()]).toEqual([`vpn`, `netdisk`, `device`, `webext`, `phone`]);

    const box = { id: `box`, kind: `ssh`, status: { state: `active` }, config: { host: `ops.acme.dev`, user: `ada` }, secrets: [] } satisfies CapabilitySummary;
    const none: ConnectionSources = { host: () => undefined, browser: () => undefined, phone: () => undefined, vpn: [], netdisk: [], devices: [] };
    expect(tileRowFacts(`ssh`, box, none)).toBe(`ops.acme.dev · ada`);
});
