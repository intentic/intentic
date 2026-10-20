import type { ContractRouterClient } from "@orpc/contract";
import type { MemberRole } from "@intentic/sandbox-contract/schemas/shared";
import type { sandboxContract } from "@intentic/sandbox-contract";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitFor } from "@intentic/testing/bun";

import { createApp } from "../../app.js";
import { clientFor, proven, rejectForbidden } from "../../harness/route-client.testing.js";
import { services } from "../../harness/route-services.testing.js";
import { runAgentTurn } from "../../harness/route-turns.testing.js";
import { testConfig } from "../../env.config.testing.js";

// Composer drafts over the daemon's own HTTP surface, as two members' browsers write them: each person reads back only
// their own, sending clears exactly the revision the words were sent from, and a card says it holds unsent words for as
// long as anybody's draft does.

interface Board {
    readonly client: ContractRouterClient<typeof sandboxContract>;
    readonly actAs: (email: string, role?: MemberRole) => void;
}

const board = (): Board => {
    let caller = proven(`ada@example.com`, `owner`);
    const app = createApp(
        services({
            // Its own history volume: the drafts file is the state under test, and the shared default outlives every run.
            config: { ...testConfig, historyRoot: mkdtempSync(join(tmpdir(), "drafts-routes-")) },
            auth: { authorize: async () => caller, authorizeOwner: rejectForbidden },
            ownerEmail: async () => `ada@example.com`,
            members: { list: async () => [{ email: `bob@example.com`, role: `collaborator` }], add: async () => {}, remove: async () => {} },
        }),
    );
    return { client: clientFor(app, { bearer: `member` }), actAs: (email, role = `owner`) => void (caller = proven(email, role)) };
};

test("a member reads back only their own drafts, never a colleague's words for the same conversation", async () => {
    const { client, actAs } = board();
    await client.agents.writeDraft({ id: "conv-1", text: "ada's words" });
    actAs(`bob@example.com`, `collaborator`);
    expect((await client.agents.drafts()).drafts).toEqual([]);
    await client.agents.writeDraft({ id: "conv-1", text: "bob's words" });
    expect((await client.agents.drafts()).drafts.map((draft) => draft.text)).toEqual(["bob's words"]);
    actAs(`ada@example.com`);
    expect((await client.agents.drafts()).drafts.map((draft) => draft.text)).toEqual(["ada's words"]);
});

test("sending clears the draft the words were sent from, and words written since in another window survive the send", async () => {
    const { client } = board();
    const first = (await client.agents.writeDraft({ id: "conv-1", text: "fix the login" })).draft;
    await runAgentTurn(client, { prompt: "fix the login", conversationId: "conv-1", draft: first?.revision });
    expect((await client.agents.drafts()).drafts).toEqual([]);

    // Another window keeps typing while this one sends from the revision it read: the newer words stay.
    const sent = (await client.agents.writeDraft({ id: "conv-1", text: "and the logout" })).draft;
    await client.agents.writeDraft({ id: "conv-1", text: "and the logout too", base: sent?.revision });
    await runAgentTurn(client, { prompt: "and the logout", conversationId: "conv-1", draft: sent?.revision });
    expect((await client.agents.drafts()).drafts.map((draft) => draft.text)).toEqual(["and the logout too"]);
});

test("a window writing from a revision that was sent since gets a conflict, so the sent words do not come back", async () => {
    const { client } = board();
    const read = (await client.agents.writeDraft({ id: "conv-1", text: "fix it" })).draft;
    await runAgentTurn(client, { prompt: "fix it", conversationId: "conv-1", draft: read?.revision });
    expect(await client.agents.writeDraft({ id: "conv-1", text: "fix it", base: read?.revision })).toEqual({ conflict: true });
    expect((await client.agents.drafts()).drafts).toEqual([]);
});

test("a conversation's card holds unsent words while a draft for it stands, and lets go once it is sent", async () => {
    const { client } = board();
    await runAgentTurn(client, { prompt: "start", conversationId: "conv-1" });
    const draft = (await client.agents.writeDraft({ id: "conv-1", text: "next step", since: 4242 })).draft;
    await waitFor(async () => expect((await client.agents.get({ id: "conv-1" })).unsentAt).toBe(4242));
    // An older client reporting its own composer empty cannot clear what the draft here still holds.
    expect((await client.agents.unsent({ id: "conv-1", at: null })).unsentAt).toBe(4242);
    await client.agents.clearDraft({ id: "conv-1", revision: draft?.revision });
    await waitFor(async () => expect((await client.agents.get({ id: "conv-1" })).unsentAt).toBeUndefined());
});
