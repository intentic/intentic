import { type Capability, type CredentialGate, envSuffix } from "@intentic/sandbox-contract";
import { expect, it } from "vitest";
import { createCredentialGrants } from "./credential-grants.js";
import { gatedCapabilities, gatedCliEnv, gatedCredentialsNote, gatedSkills } from "./credential-gating.js";

// Gated capabilities and connector env vars are asserted absent, since browser/identity/mcp mounts and cli env are
// fixed before a turn starts, leaving no later moment to refuse. The note keeps that absence from reading as "not
// connected".

const gate = (over: Partial<CredentialGate> = {}): CredentialGate => ({
    subject: "reddit",
    kind: "capability",
    approvers: ["bob@corp.com"],
    scope: "conversation",
    ...over,
});

const capability = (id: string, kind: Capability["kind"]): Capability => ({ id, kind, config: {} }) as Capability;

const manifest: Capability[] = [
    capability("reddit", "browser"),
    capability("identity", "identity"),
    capability("notion", "mcp"),
    capability("komodo", "cli"),
];

it("withholds a gated browser, identity and mcp capability, and reports what it took", () => {
    const grants = createCredentialGrants();
    const gates = [gate(), gate({ subject: "identity" }), gate({ subject: "notion" })];
    const { capabilities, withheld } = gatedCapabilities(manifest, gates, grants, "conv-1");
    expect(capabilities.map((entry) => entry.id)).toEqual(["komodo"]);
    expect(withheld.map((entry) => entry.subject)).toEqual(["reddit", "identity", "notion"]);
});

it("keeps a capability this conversation already holds a release for", () => {
    const grants = createCredentialGrants();
    grants.grant("conv-1", "reddit", { approvedBy: "bob@corp.com", at: 1 });
    const { capabilities, withheld } = gatedCapabilities(manifest, [gate()], grants, "conv-1");
    expect(capabilities.map((entry) => entry.id)).toContain("reddit");
    expect(withheld).toEqual([]);
    expect(gatedCapabilities(manifest, [gate()], grants, "conv-2").withheld.map((entry) => entry.subject)).toEqual(["reddit"]);
    expect(gatedCapabilities(manifest, [gate()], grants, undefined).withheld.map((entry) => entry.subject)).toEqual(["reddit"]);
});

it("leaves an ungated manifest exactly as it was", () => {
    const grants = createCredentialGrants();
    expect(gatedCapabilities(manifest, [], grants, "conv-1").capabilities.map((entry) => entry.id)).toEqual([
        "reddit",
        "identity",
        "notion",
        "komodo",
    ]);
    expect(gatedCapabilities(manifest, [gate({ subject: "komodo" })], grants, "conv-1").withheld).toEqual([]);
});

it("strips every variable carrying a gated connector's suffix, and leaves the rest of the environment alone", () => {
    const grants = createCredentialGrants();
    const env = {
        KOMODO_API_KEY_KOMODO: "k",
        KOMODO_URL_KOMODO: "https://komodo",
        GITHUB_TOKEN_GITHUB: "g",
        PATH: "/usr/local/bin",
    };
    const { cliEnv, withheld } = gatedCliEnv(env, [capability("komodo", "cli"), capability("github", "cli")], [gate({ subject: "komodo" })], grants, "conv-1", envSuffix);
    expect(cliEnv).toEqual({ GITHUB_TOKEN_GITHUB: "g", PATH: "/usr/local/bin" });
    expect(withheld.map((entry) => entry.subject)).toEqual(["komodo"]);
    grants.grant("conv-1", "komodo", { approvedBy: "bob@corp.com", at: 1 });
    expect(gatedCliEnv(env, [capability("komodo", "cli")], [gate({ subject: "komodo" })], grants, "conv-1", envSuffix).cliEnv).toEqual(env);
});

it("tells the model the door exists, names who opens it, and says the account is not broken", () => {
    const note = gatedCredentialsNote([gate(), gate({ subject: "komodo", approvers: ["bob@corp.com", "alice@corp.com"] })]);
    expect(note?.title).toBe("Some connected accounts need a person's approval");
    expect(note?.text).toContain('`secrets request reddit --why "…"`');
    expect(note?.text).toContain("bob@corp.com or alice@corp.com");
    expect(note?.text).toContain("NOT missing or broken");
    expect(note?.text).toContain("NEXT turn");
    expect(gatedCredentialsNote([])).toBeUndefined();
});

it("says each withheld subject once, however many filters took it", () => {
    const note = gatedCredentialsNote([gate({ subject: "komodo" }), gate({ subject: "komodo" })]);
    expect(note?.text.match(/`komodo`/g)).toHaveLength(1);
});

it(`takes a withheld credential's skill out of the turn along with the credential`, () => {
    expect(gatedSkills([gate(), gate({ subject: `komodo` })])).toEqual([`Skill(reddit)`, `Skill(komodo)`]);
    expect(gatedSkills([gate({ subject: `komodo` }), gate({ subject: `komodo` })])).toEqual([`Skill(komodo)`]);
    expect(gatedSkills([])).toEqual([]);
});
