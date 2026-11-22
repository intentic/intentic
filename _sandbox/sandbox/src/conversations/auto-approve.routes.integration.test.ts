import type { ContractRouterClient } from "@orpc/contract";
import type { MemberTier } from "@intentic/sandbox-contract/schemas/shared";
import type { sandboxContract } from "@intentic/sandbox-contract";

import { createApp } from "../app.js";
import { clientFor, errorCode, proven, rejectForbidden } from "../harness/route-client.testing.js";
import { services } from "../harness/route-services.testing.js";
import { runAgentTurn } from "../harness/route-turns.testing.js";

// The auto-approve mark over the daemon's own HTTP surface (POST /agents/auto-approve): several conversations at once,
// worn by their cards, listed with the other yeses, and only a maintainer's to give. What it answers, and what it never
// does, is parked-cards.test.ts and roles/standing-answer.test.ts.

const board = () => {
    let caller = proven(`ada@example.com`, `maintainer`);
    const app = createApp(services({ auth: { authorize: async () => caller, authorizeOwner: rejectForbidden } }));
    const client: ContractRouterClient<typeof sandboxContract> = clientFor(app, { bearer: `member` });
    return {
        client,
        actAs: (role: MemberTier): void => {
            caller = proven(`ada@example.com`, role);
        },
    };
};

test("marks several conversations in one press, their cards wear it, and taking one off leaves the other", async () => {
    const { client } = board();
    await runAgentTurn(client, { prompt: "fix it", conversationId: "conv1", isolated: true });
    await runAgentTurn(client, { prompt: "and this", conversationId: "conv2", isolated: true });

    const marked = await client.agents.autoApprove({ ids: ["conv1", "conv2"], on: true });
    expect(marked.agents.map((agent) => [agent.id, agent.autoApprove])).toEqual([
        ["conv1", "own"],
        ["conv2", "own"],
    ]);
    // The roster everyone else reads carries it too, and the Allowed list names who put it on.
    const listed = (await client.agents.list()).agents.filter((agent) => agent.autoApprove === "own").map((agent) => agent.id);
    expect(listed.toSorted()).toEqual(["conv1", "conv2"]);
    expect((await client.needs.grants()).conversations).toEqual(
        expect.arrayContaining([expect.objectContaining({ conversationId: "conv1", autoApprove: true, by: "ada@example.com" })]),
    );

    const unmarked = await client.agents.autoApprove({ ids: ["conv1"], on: false });
    expect(unmarked.agents[0]?.autoApprove).toBeUndefined();
    const after = await client.agents.list();
    expect(after.agents.find((agent) => agent.id === "conv2")?.autoApprove).toBe("own");
});

test("a collaborator cannot mark, and one unknown id leaves every named conversation as it was", async () => {
    const { client, actAs } = board();
    await runAgentTurn(client, { prompt: "fix it", conversationId: "conv1", isolated: true });

    expect(await errorCode(client.agents.autoApprove({ ids: ["conv1", "nope"], on: true }))).toBe("NOT_FOUND");
    expect((await client.agents.list()).agents.find((agent) => agent.id === "conv1")?.autoApprove).toBeUndefined();

    actAs(`collaborator`);
    expect(await errorCode(client.agents.autoApprove({ ids: ["conv1"], on: true }))).toBe("FORBIDDEN");
});
