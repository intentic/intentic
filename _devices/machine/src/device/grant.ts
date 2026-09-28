import { DeviceScopesSchema, type DeviceScopes, deviceContract } from "@intentic/sandbox-contract";
import { z } from "zod";

// THE GRANT A SANDBOX PUSHES, read so that a newer sandbox cannot knock an older agent off the line. A switch this
// agent does not know is a permission for something it has no tool for: dropping it leaves that something off, which
// is the fail-closed answer, and keeps the link up. Every switch it DOES know is still read strictly, so a value it has
// no meaning for is still refused, and every other input a device is sent (flows, agent ops) stays strict.

// The contract's own grant, plus whatever else a newer sandbox sends beside it. The card's `platform` rides along as
// it always has.
export const GrantInputSchema = DeviceScopesSchema.extend({ platform: z.string().optional() }).loose();
export type GrantInput = z.infer<typeof GrantInputSchema>;

const KNOWN: ReadonlySet<string> = new Set<string>([...DeviceScopesSchema.keyof().options, "platform"]);

// What a pushed grant comes to here: the switches this agent enforces, and the names of those it was sent and does
// not know, sorted.
export interface Grant {
    readonly scopes: DeviceScopes;
    readonly unknown: readonly string[];
}

export const readGrant = (input: GrantInput): Grant => ({
    scopes: DeviceScopesSchema.parse(input),
    unknown: Object.keys(input)
        .filter((key) => !KNOWN.has(key))
        .toSorted(),
});

// The device contract with `setScopes` reading GrantInputSchema instead of the contract's strict one: the only input
// this agent reads tolerantly. Structurally the contract's own procedure, its route, meta and errors untouched.
export const tolerantDeviceContract = {
    ...deviceContract,
    setScopes: { "~orpc": { ...deviceContract.setScopes["~orpc"], inputSchema: GrantInputSchema } },
};
