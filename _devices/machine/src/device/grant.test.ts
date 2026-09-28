import { DeviceScopesSchema } from "@intentic/sandbox-contract";
import { GrantInputSchema, readGrant } from "./grant.js";

/* A newer sandbox may push a switch this agent has never heard of. Refusing it dropped the link, which the sandbox
   redialled forever; the switch is left off instead, and every switch this agent knows is read as strictly as before. */

// Derived rather than transcribed: the switches the contract fills in when a push leaves them out.
const DEFAULTS = DeviceScopesSchema.parse({});

test("a switch this agent does not know is left off and named, and the rest of the grant holds", () => {
    const input = GrantInputSchema.parse({ shell: "off", sandboxes: "on", network: "on", "gpu-share": "on" });
    expect(readGrant(input)).toEqual({ scopes: { ...DEFAULTS, shell: "off", sandboxes: "on" }, unknown: ["gpu-share", "network"] });
});

// The card sends its whole config, `platform` included, and always has: that is not a switch anybody added.
test("the card's platform rides along without being called unknown", () => {
    expect(readGrant(GrantInputSchema.parse({ platform: "linux", write: "on" }))).toEqual({ scopes: { ...DEFAULTS, write: "on" }, unknown: [] });
});

// Tolerance is for switches that did not exist when this agent was built, not for values it has no meaning for.
test("a switch this agent knows, set to a value it does not, is still refused", () => {
    expect(GrantInputSchema.safeParse({ shell: "maybe" }).success).toBe(false);
    expect(GrantInputSchema.safeParse({ roots: 3 }).success).toBe(false);
});
