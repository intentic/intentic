import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CredentialGate } from "@intentic/sandbox-contract";
import { expect, it } from "vitest";
import { fileCredentialGates, gateForName, gateSubjectOf, gateTargetOf } from "./credential-gates.js";

// Verifies the store tells an absent policy from an unreadable one (its one departure from the house `jsonFile`
// fallback) and resolves the right subject for a name; needs a real filesystem to tell those apart.

const dir = async (): Promise<string> => mkdtemp(join(tmpdir(), "credential-gates-"));

const gate = (over: Partial<CredentialGate> = {}): CredentialGate => ({
    subject: "DATABASE_URL",
    kind: "secret",
    approvers: ["bob@corp.com"],
    scope: "use",
    ...over,
});

it("reads an absent policy as nothing gated: that is the ordinary first state", async () => {
    const store = fileCredentialGates(join(await dir(), "credential-gates.json"));
    expect(await store.list()).toEqual([]);
});

it("REFUSES a policy that exists and cannot be read, rather than reading it as nothing gated", async () => {
    const path = join(await dir(), "credential-gates.json");
    await writeFile(path, "{not json");
    await expect(store(path).list()).rejects.toThrow(/could not be read/);
    await writeFile(path, JSON.stringify({ gates: [{ subject: 7 }] }));
    await expect(store(path).list()).rejects.toThrow(/not readable as a policy/);
});

const store = (path: string) => fileCredentialGates(path);

it("upserts by subject, so a re-gated subject has exactly one answer to who may release it", async () => {
    const path = join(await dir(), "credential-gates.json");
    const gates = store(path);
    await gates.set(gate());
    await gates.set(gate({ approvers: ["alice@corp.com"], scope: "conversation" }));
    expect(await gates.list()).toEqual([gate({ approvers: ["alice@corp.com"], scope: "conversation" })]);
    await gates.set(gate({ subject: "reddit", kind: "capability" }));
    expect((await gates.list()).map((entry) => entry.subject)).toEqual(["DATABASE_URL", "reddit"]);
    await gates.remove("DATABASE_URL");
    expect((await gates.list()).map((entry) => entry.subject)).toEqual(["reddit"]);
});

it("writes the policy 0600, beside the vault it guards", async () => {
    const path = join(await dir(), "credential-gates.json");
    await store(path).set(gate());
    const { mode } = await (await import("node:fs/promises")).stat(path);
    // eslint-disable-next-line no-bitwise -- the permission bits are the assertion
    expect(mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ gates: [gate()] });
});

it("a name's subject is its capability when it carries a slash, and itself otherwise", () => {
    expect(gateSubjectOf("reddit/password")).toBe("reddit");
    expect(gateSubjectOf("DATABASE_URL")).toBe("DATABASE_URL");
    expect(gateTargetOf("reddit/password")).toEqual({ subject: "reddit", kind: "capability" });
    expect(gateTargetOf("DATABASE_URL")).toEqual({ subject: "DATABASE_URL", kind: "secret" });
});

it("matches a name to a gate by kind as well as subject", () => {
    const gates = [gate(), gate({ subject: "reddit", kind: "capability" })];
    expect(gateForName(gates, "reddit/password")).toEqual(gates[1]);
    expect(gateForName(gates, "reddit/totp")).toEqual(gates[1]);
    expect(gateForName(gates, "DATABASE_URL")).toEqual(gates[0]);
    expect(gateForName([gate({ subject: "reddit", kind: "capability" })], "reddit")).toBeUndefined();
    expect(gateForName([gate({ subject: "reddit" })], "reddit/password")).toBeUndefined();
    expect(gateForName(gates, "OTHER")).toBeUndefined();
});
