import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type MemberSelf, MemberSelfSchema } from "@intentic/sandbox-contract/schemas/members";
import { createApp } from "../../app.js";
import { proven } from "../../harness/route-client.testing.js";
import { services } from "../../harness/route-services.testing.js";
import { fileMembersStore } from "../auth.js";
import { accountConnectorsDocument, fileAccountConnectors } from "./account-connectors.js";

// Who connected each AI account is kept under the history root, by the account's key, in the lowercased address of the
// person who did; a disconnect forgets it. A person whose row lists only some AI accounts is told the ones they
// connected too, since those are always theirs.

test("a connector is recorded, read back by account and by person, replaced by a later sign-in, and forgotten", async () => {
    const dir = await mkdtemp(join(tmpdir(), "account-connectors-"));
    const store = fileAccountConnectors(dir);
    expect(await store.all()).toEqual(new Map());

    await store.record("claude:a", "Bob@Example.com", 1);
    await store.record("codex:b", "bob@example.com", 2);
    await store.record("claude:c", "cy@example.com", 3);
    expect(await store.all()).toEqual(new Map([["claude:a", "bob@example.com"], ["codex:b", "bob@example.com"], ["claude:c", "cy@example.com"]]));
    expect(await store.keysOf("BOB@example.com")).toEqual(["claude:a", "codex:b"]);
    // A second handle on the same root reads what the first wrote: it is the file, not the handle, that remembers.
    expect(await fileAccountConnectors(dir).keysOf("cy@example.com")).toEqual(["claude:c"]);
    expect(JSON.parse(await readFile(join(dir, accountConnectorsDocument.path), "utf8"))).toMatchObject({
        connectors: { "claude:a": { by: "bob@example.com", at: 1 } },
    });

    await store.record("claude:a", "cy@example.com", 4);
    expect(await store.keysOf("bob@example.com")).toEqual(["codex:b"]);
    await store.forget("codex:b");
    expect(await store.keysOf("bob@example.com")).toEqual([]);
    expect(await store.keysOf("cy@example.com")).toEqual(["claude:a", "claude:c"]);
});

test("a person's own answer lists the AI accounts they connected beside the ones their row gives them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "account-connectors-self-"));
    const members = fileMembersStore(join(dir, "members.json"));
    const accountConnectors = fileAccountConnectors(dir);
    await members.add("bob@example.com", { role: "collaborator", aiAccounts: ["claude:a"] });
    await members.add("cy@example.com", { role: "collaborator" });
    await accountConnectors.record("claude:b", "bob@example.com", 1);
    await accountConnectors.record("claude:c", "cy@example.com", 1);
    const selfOf = async (email: string): Promise<MemberSelf> => {
        const app = createApp(
            services({
                auth: { authorize: async () => proven(email, "collaborator"), authorizeOwner: async () => undefined },
                ownerEmail: async () => "ada@example.com",
                members,
                accountConnectors,
            }),
        );
        return MemberSelfSchema.parse(await (await app.request("/members/self", { headers: { authorization: "Bearer member" } })).json());
    };
    expect(await selfOf("bob@example.com")).toMatchObject({ aiAccounts: ["claude:a", "claude:b"] });
    // A row with no list runs on every account already: there is nothing to widen, and the answer says no list at all.
    expect(await selfOf("cy@example.com")).not.toHaveProperty("aiAccounts");
});
