import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileConversationGrants } from "../personas/conversation-grants.js";
import { createCredentialGrants } from "../secrets/credential-grants.js";
import { revokeGrant, standingGrants } from "./standing-grants.js";
import { standingDeps } from "./standing-grants.testing.js";

// A credential gateway card's "Allow requests like this with <name> in this conversation" is a person's yes like any
// other: kept on disk, so a restart does not ask again, listed where it can be taken back, and gone with its conversation.

const grantsFile = async (): Promise<string> => join(await mkdtemp(join(tmpdir(), "conversation-grants-")), "conversation-grants.json");

const github = { capability: "github", rule: '{"method":"GET","path":"/repos/*"}', said: "GET api.github.com/repos/x with GitHub" };

test("a rule's pass outlasts the store that heard it, is listed, and taken back by capability and rule", async () => {
    const path = await grantsFile();
    const before = fileConversationGrants(path, () => 100);
    await before.allowRule("conv-1", github, "ada@acme.dev");

    // A fresh store over the same file is how a restart reads it.
    const after = fileConversationGrants(path, () => 200);
    const deps = standingDeps({ conversationGrants: after, credentialGrants: createCredentialGrants() });
    expect(await after.ruleAllowed("conv-1", "github", github.rule)).toBe(true);
    // The same rule under another capability, or another conversation, was never allowed.
    expect(await after.ruleAllowed("conv-1", "linear", github.rule)).toBe(false);
    expect(await after.ruleAllowed("conv-2", "github", github.rule)).toBe(false);
    expect((await standingGrants(deps)).conversations).toEqual([
        {
            conversationId: "conv-1",
            capabilities: [],
            folders: [],
            shelves: [],
            installs: false,
            secrets: [],
            everything: false,
            rules: [github],
            by: "ada@acme.dev",
            updatedAt: 100,
            releases: [],
        },
    ]);

    // Without the capability there is no telling whose rule it is, so nothing is taken.
    expect(await revokeGrant(deps, { conversationId: "conv-1", kind: "rule", what: github.rule })).toBe(false);
    expect(await revokeGrant(deps, { conversationId: "conv-1", kind: "rule", what: github.rule, capability: "github" })).toBe(true);
    expect(await revokeGrant(deps, { conversationId: "conv-1", kind: "rule", what: github.rule, capability: "github" })).toBe(false);
    // Its only yes gone, the conversation drops out, and stays out across another restart.
    expect((await standingGrants(deps)).conversations).toEqual([]);
    expect(await fileConversationGrants(path).ruleAllowed("conv-1", "github", github.rule)).toBe(false);
});

test("forgetting a conversation takes its rule passes with the rest of its grants", async () => {
    const path = await grantsFile();
    const grants = fileConversationGrants(path, () => 100);
    await grants.allowRule("conv-1", github, undefined);
    await grants.add("conv-1", { subject: "folder", what: "docs" }, undefined);
    await grants.allowRule("conv-2", github, undefined);

    await grants.forget("conv-1");
    const after = fileConversationGrants(path);
    expect(await after.ruleAllowed("conv-1", "github", github.rule)).toBe(false);
    expect(await after.of("conv-1")).toBeUndefined();
    expect(await after.ruleAllowed("conv-2", "github", github.rule)).toBe(true);
});

test("a file written before rule passes existed still reads, with none", async () => {
    const path = await grantsFile();
    await writeFile(path, JSON.stringify({ "conv-1": { capabilities: ["github"], folders: [], shelves: [], updatedAt: 5 } }));
    const grants = fileConversationGrants(path);
    expect(await grants.of("conv-1")).toEqual({
        capabilities: ["github"],
        folders: [],
        shelves: [],
        installs: false,
        secrets: [],
        everything: false,
        rules: [],
        updatedAt: 5,
    });
});

test("each write that changed something is announced once, with its conversation, and one that changed nothing is not", async () => {
    const grants = fileConversationGrants(await grantsFile(), () => 100);
    const heard: string[] = [];
    const stop = grants.onChange((conversationId) => heard.push(conversationId));
    // A listener that throws neither fails the write nor keeps the others from hearing it.
    grants.onChange(() => {
        throw new Error("a broken view");
    });

    await grants.allowRule("conv-1", github, undefined);
    await grants.allowRule("conv-1", github, undefined);
    await grants.allowInstalls("conv-2", undefined);
    expect(await grants.revokeRule("conv-1", "github", github.rule)).toBe(true);
    expect(await grants.revokeRule("conv-1", "github", github.rule)).toBe(false);
    await grants.forget("conv-2");
    await grants.forget("conv-2");
    expect(heard).toEqual(["conv-1", "conv-2", "conv-1", "conv-2"]);

    stop();
    await grants.allowEverything("conv-3", undefined);
    expect(heard).toEqual(["conv-1", "conv-2", "conv-1", "conv-2"]);
    expect(await grants.everythingAllowed("conv-3")).toBe(true);
});
