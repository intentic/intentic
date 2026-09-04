import { type Capability, type CredentialGate, envSuffix } from "@intentic/sandbox-contract";
import { expect, it } from "vitest";
import { createCredentialGrants } from "./credential-grants.js";
import { gatedCapabilities, gatedCliEnv, gatedCredentialsNote, gatedSkills } from "./credential-gating.js";

/* ENFORCEMENT BY ABSENCE. What these assert is that a gated MOUNT is not in the list the arms build from and
 * a gated CONNECTOR's variables are not in the environment — because for these three kinds there is no later
 * moment to refuse at, the credential is signed in, exported or running before the turn starts.
 *
 * The note gets its own tests because it is load-bearing rather than decorative: without it the model reads
 * the absence as "not connected", which is the failure the whole filter would otherwise cause. */

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
    // The connector stays: its credential is a value at an exit, so it is gated where it resolves instead.
    expect(capabilities.map((entry) => entry.id)).toEqual(["komodo"]);
    expect(withheld.map((entry) => entry.subject)).toEqual(["reddit", "identity", "notion"]);
});

it("keeps a capability this conversation already holds a release for", () => {
    const grants = createCredentialGrants();
    grants.grant("conv-1", "reddit", { approvedBy: "bob@corp.com", at: 1 });
    const { capabilities, withheld } = gatedCapabilities(manifest, [gate()], grants, "conv-1");
    expect(capabilities.map((entry) => entry.id)).toContain("reddit");
    expect(withheld).toEqual([]);
    // The release belongs to the conversation it was given in, and nothing else.
    expect(gatedCapabilities(manifest, [gate()], grants, "conv-2").withheld.map((entry) => entry.subject)).toEqual(["reddit"]);
    // A turn with no conversation at all cannot hold a release, so it is withheld.
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
    // A gate on a capability that is not mounted-shaped withholds nothing here.
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
    // The token is OUT of the environment rather than left there with an instruction not to use it.
    expect(cliEnv).toEqual({ GITHUB_TOKEN_GITHUB: "g", PATH: "/usr/local/bin" });
    expect(withheld.map((entry) => entry.subject)).toEqual(["komodo"]);
    // A released connector keeps its variables for the rest of the conversation.
    grants.grant("conv-1", "komodo", { approvedBy: "bob@corp.com", at: 1 });
    expect(gatedCliEnv(env, [capability("komodo", "cli")], [gate({ subject: "komodo" })], grants, "conv-1", envSuffix).cliEnv).toEqual(env);
});

it("tells the model the door exists, names who opens it, and says the account is not broken", () => {
    const note = gatedCredentialsNote([gate(), gate({ subject: "komodo", approvers: ["bob@corp.com", "alice@corp.com"] })]);
    expect(note?.title).toBe("Some connected accounts need a person's approval");
    // The command, so the model asks instead of reporting the obstacle and stopping.
    expect(note?.text).toContain('`secrets request reddit --why "…"`');
    expect(note?.text).toContain("bob@corp.com or alice@corp.com");
    // The wrong conclusion, ruled out in words: this is the exact failure the note exists to prevent.
    expect(note?.text).toContain("NOT missing or broken");
    // And the honest timing, because a profile cannot be mounted into a turn that is already running.
    expect(note?.text).toContain("NEXT turn");
    expect(gatedCredentialsNote([])).toBeUndefined();
});

it("says each withheld subject once, however many filters took it", () => {
    // The mount filter and the environment filter are independent, and the note must not say the same
    // credential twice just because both of them reported it.
    const note = gatedCredentialsNote([gate({ subject: "komodo" }), gate({ subject: "komodo" })]);
    expect(note?.text.match(/`komodo`/g)).toHaveLength(1);
});

it(`takes a withheld credential's skill out of the turn along with the credential`, () => {
    /* A cheatsheet whose tools are absent reads as an OFFER: the model follows it, calls a tool that is not
     * there, and reports the sandbox as broken. Both halves of the withholding feed this, because a
     * connector's cheatsheet without its token fails the same way as an account's without its browser. */
    expect(gatedSkills([gate(), gate({ subject: `komodo` })])).toEqual([`Skill(reddit)`, `Skill(komodo)`]);
    // One entry per subject: the mount filter and the environment filter are independent and can both report
    // the same capability, and naming a tool twice in a disallow list is noise.
    expect(gatedSkills([gate({ subject: `komodo` }), gate({ subject: `komodo` })])).toEqual([`Skill(komodo)`]);
    expect(gatedSkills([])).toEqual([]);
});
