import { SandboxHostedSchema } from "./schemas.js";

test("hosted state crosses the wire, with older platforms still readable", () => {
    for (const state of ["awake", "asleep", "starting", "down", "unknown"] as const) {
        expect(SandboxHostedSchema.parse({ region: "iad", warm: false, state })).toEqual({ region: "iad", warm: false, state });
    }
    expect(SandboxHostedSchema.parse({ region: "iad", warm: false })).toEqual({ region: "iad", warm: false });
    expect(SandboxHostedSchema.safeParse({ region: "iad", warm: false, state: "oops" }).success).toBe(false);
});
