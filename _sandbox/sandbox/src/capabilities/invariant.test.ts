import { type Capability, VAULTED } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import type { CapabilitiesStore } from "./capabilities-store.js";
import { checks } from "./invariant.js";

/* The repository's own words, made checkable: the vault sweep is "an invariant rather than a one-time
 * conversion", and it runs at one moment. These pin what the standing check sees between two of them. */

const fail = (message: string): never => {
    throw new Error(message);
};

const manifestOf = (entries: readonly Capability[]): CapabilitiesStore => ({
    list: async () => [...entries],
    get: async (id) => entries.find((entry) => entry.id === id),
    upsert: async () => {},
    remove: async () => false,
});

const run = async (entries: readonly Capability[]): Promise<void> => {
    const [check] = checks({ manifest: manifestOf(entries), connectors: async () => new Map() });
    await check?.run({ moment: "sweep", fail });
};

test("a properly vaulted manifest reports nothing", async () => {
    await expect(run([{ id: "linear", kind: "mcp", config: { url: "https://a/mcp", token: VAULTED } }])).resolves.toBeUndefined();
});

test("a credential sitting in the readable manifest is named: the capability and the field", async () => {
    await expect(run([{ id: "linear", kind: "mcp", config: { url: "https://a/mcp", token: "mcp_live_token" } }])).rejects.toThrow(
        /1 capabilit\(ies\).*linear \(token\)/,
    );
});

test("the value is never in the message: a diagnostic that prints the token has copied it into the log", async () => {
    // Asserted on the caught message rather than through `rejects.toThrow`, which takes a substring to REQUIRE
    // and has no negative form: a test that cannot fail here is worse than no test, since this is the one thing
    // the check must never do.
    const caught = await run([{ id: "linear", kind: "mcp", config: { url: "https://a/mcp", token: "mcp_live_token" } }]).then(
        () => undefined,
        (error: unknown) => (error as Error).message,
    );
    expect(caught).toEqual(expect.any(String));
    expect(caught).not.toContain("mcp_live_token");
    expect(caught).toContain("token");
});

test("an entry with no credential fields at all is not a finding", async () => {
    await expect(run([{ id: "stripe", kind: "integration", config: { provider: "stripe" } }])).resolves.toBeUndefined();
});
