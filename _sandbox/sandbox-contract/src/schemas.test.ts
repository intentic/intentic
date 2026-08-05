import { expect, test } from "vitest";
import { CapabilitiesListSchema, DeployOverviewResponseSchema, IpsecVpnConfigSchema, SandboxSettingsSchema } from "./schemas.js";

/* The settings shape spans a version seam that really moves: the browser ships with the platform, the daemon
 * ships inside the user's sandbox image, so a web build routinely parses a payload from an OLDER daemon. These
 * tests pin the property that makes that survivable — an absent key is that flag's default, not a parse
 * failure — because failing instead reaches the user as a settings page whose switches silently do nothing. */

test("a payload from a build that predates a toggle parses, with the new toggle at its default", () => {
    // What a daemon built before the output-cleaner backend switch answers with: every key it knew, and
    // nothing for the one added after it shipped.
    const older = {
        stableSystemPrompt: false,
        skills: [],
        hashlineEdits: false,
        terseOutput: true,
        iqSearch: true,
        outputCleaners: "-cap",
        outputHoldout: 0.1,
    };
    // The defaults come from the schema, not from a copy of it written here. Transcribing them made every
    // setting the product gained land as a failure in this file — a diff that only ever said "the list moved",
    // never "tolerance broke", and whose fix was always to paste the new default in. What this test is about
    // is the seam: what the old build sent survives verbatim, and what it never heard of arrives at default.
    expect(SandboxSettingsSchema.parse(older)).toEqual({ ...SandboxSettingsSchema.parse({}), ...older });
});

/* The invariant a fresh sandbox depends on: NO field is required. A settings object is written for the first
 * time only when the user changes something, so until then the daemon parses `{}` — one field without a
 * `.default()` turns that into a throw at boot, and the version tolerance above is built on the same property.
 *
 * Asserted by shape rather than by value: what each default IS belongs next to the field in schemas.ts, where
 * the reason it holds is written down. A second copy here proved nothing the schema didn't already say and
 * failed on every field the product added. */
test("no field is required — a workspace that has never written settings parses", () => {
    const defaults = SandboxSettingsSchema.parse({});
    expect(Object.keys(defaults).sort()).toEqual(Object.keys(SandboxSettingsSchema.shape).sort());
});

test("a key of the wrong type is still a parse failure — tolerance is for absence, not for garbage", () => {
    expect(SandboxSettingsSchema.safeParse({ iqSearch: "yes" }).success).toBe(false);
    expect(SandboxSettingsSchema.safeParse({ outputHoldout: 4 }).success).toBe(false);
    // The prompt cap is a real bound, not advice: the text IS the system prompt, and every turn pays for it.
    expect(SandboxSettingsSchema.safeParse({ systemPrompt: "x".repeat(20001) }).success).toBe(false);
});

/* The capability list crosses the same seam, and its failure mode is worse than a dead switch: the browser
 * parses ONE object for the whole page, so a required key the older daemon never sends takes the Capabilities
 * page down entirely — to hide an advisory badge. */

test("a capability list from a daemon that predates recommendations parses, with none recommended", () => {
    const older = { capabilities: [{ id: "github", kind: "cli", status: { state: "active" }, config: { provider: "github" } }] };
    expect(CapabilitiesListSchema.parse(older).recommendations).toEqual([]);
});

/* The deployments board crosses the same seam and learned it the hard way. `repos` (workspace repo → Komodo
 * stack links) shipped REQUIRED, and the first sandbox whose daemon predated it rendered
 * `Invalid input: expected array, received undefined at repos` instead of the board — a dead page, on the one
 * surface whose job is to say whether production is up, to hide a band of suggestions.
 *
 * `viewer` is the deliberate contrast: also added later, also absent from an older daemon, but OPTIONAL rather
 * than defaulted, because its absence is information. The empty state tells "the key can see nothing" apart
 * from "we could not tell", and defaulting it would have collapsed the two. */

test("an overview from a daemon that predates repo links parses, with no links rather than no board", () => {
    const older = { komodoUrl: "https://komodo.example.com", reachable: true, resources: [], servers: [], alerts: [] };
    const parsed = DeployOverviewResponseSchema.parse(older);
    expect(parsed.repos).toEqual([]);
    // Absent, NOT defaulted: the empty state reads this to avoid claiming an empty Komodo it cannot vouch for.
    expect(parsed.viewer).toBeUndefined();
});

test("a board that did carry links keeps them, and garbage in them is still a failure", () => {
    const current = {
        komodoUrl: "https://komodo.example.com",
        reachable: true,
        viewer: { username: "intentic", admin: false },
        repos: [{ repo: "app", projectName: "app", composePath: "app/compose.yaml", suggestions: ["app-prod"] }],
        resources: [],
        servers: [],
        alerts: [],
    };
    expect(DeployOverviewResponseSchema.parse(current).repos[0]?.suggestions).toEqual(["app-prod"]);
    // Tolerance is for absence, not for the wrong shape — a `repos` that is present and wrong is real drift.
    expect(DeployOverviewResponseSchema.safeParse({ ...current, repos: "none" }).success).toBe(false);
});

/* An ipsec tunnel's routed networks decide whether it is split or full, and both ends of that are load-bearing:
 * a value the daemon splices into rightsubnet unchecked reaches charon as a config it refuses WHOLESALE (every
 * tunnel on the sandbox stops loading, and the error names the file rather than the field), while a default that
 * stopped being 0.0.0.0/0 would silently narrow tunnels that reach those networks today. */
const ipsec = { provider: "ipsec", server: "gw.example.com", presharedKey: "group-secret" };

test("an ipsec tunnel is a full tunnel unless it says otherwise", () => {
    expect(IpsecVpnConfigSchema.parse(ipsec).routedNetworks).toBe("0.0.0.0/0");
});

test("routed networks take a CIDR list and reject what charon could not load", () => {
    expect(IpsecVpnConfigSchema.parse({ ...ipsec, routedNetworks: "10.0.0.0/8, 192.168.0.0/16" }).routedNetworks).toBe("10.0.0.0/8, 192.168.0.0/16");
    expect(IpsecVpnConfigSchema.parse({ ...ipsec, routedNetworks: "fd00::/8" }).routedNetworks).toBe("fd00::/8");
    // A bare host address is the easy mistake — strongSwan wants the prefix, and the message says so.
    expect(IpsecVpnConfigSchema.safeParse({ ...ipsec, routedNetworks: "192.168.0.168" }).success).toBe(false);
    expect(IpsecVpnConfigSchema.safeParse({ ...ipsec, routedNetworks: "10.0.0.0/8,nonsense" }).success).toBe(false);
    expect(IpsecVpnConfigSchema.safeParse({ ...ipsec, routedNetworks: "" }).success).toBe(false);
});
