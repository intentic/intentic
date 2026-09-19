import { expect, test } from "vitest";

import type { ContractRouterClient } from "@orpc/contract";
import type { MemberRole, sandboxContract } from "@intentic/sandbox-contract";

import { createApp } from "../app.js";
import { clientFor, errorCode, proven, rejectForbidden } from "../harness/route-client.testing.js";
import { services } from "../harness/route-services.testing.js";
import { runAgentTurn } from "../harness/route-turns.testing.js";

// Ownership over the daemon's own HTTP surface: who a conversation is attributed to on its first turn, and who may
// move it. The verdict table itself is ownership.test.ts; what is pinned here is that the route reads the verified
// caller and the members file, never the body.

const board = (): {
    readonly client: ContractRouterClient<typeof sandboxContract>;
    readonly actAs: (email: string, role?: MemberRole, name?: string) => void;
} => {
    let caller = proven(`ada@example.com`, `owner`);
    const app = createApp(
        services({
            auth: { authorize: async () => caller, authorizeOwner: rejectForbidden },
            ownerEmail: async () => `ada@example.com`,
            members: {
                list: async () => [
                    { email: `bob@example.com`, role: `collaborator` },
                    { email: `cy@example.com`, role: `maintainer` },
                ],
                add: async () => {},
                remove: async () => {},
            },
        }),
    );
    return {
        client: clientFor(app, { bearer: `member` }),
        actAs: (email, role = `owner`, name) => {
            caller = { ...proven(email, role), ...(name === undefined ? {} : { name }) };
        },
    };
};

test("the member who starts a conversation owns it, by the identity the daemon verified", async () => {
    const { client, actAs } = board();
    actAs(`bob@example.com`, `collaborator`, `Bob`);
    await runAgentTurn(client, { prompt: "fix it", conversationId: "conv1", isolated: true });
    const { agents } = await client.agents.list();
    expect(agents[0]?.startedBy).toBe(`bob@example.com`);
    expect(agents[0]?.owner).toEqual({ email: `bob@example.com`, name: `Bob`, since: expect.any(Number) });
});

test("its owner hands it over, a collaborator cannot take another's, a maintainer can", async () => {
    const { client, actAs } = board();
    actAs(`bob@example.com`, `collaborator`, `Bob`);
    await runAgentTurn(client, { prompt: "fix it", conversationId: "conv1", isolated: true });

    // A colleague named by address: no name is known for them, so none is invented.
    const handed = await client.agents.assign({ id: "conv1", to: "Cy@Example.com" });
    expect(handed.owner).toEqual({ email: `cy@example.com`, since: expect.any(Number) });

    // Bob no longer owns it, and his tier does not reach past that.
    expect(await errorCode(client.agents.assign({ id: "conv1", to: "bob@example.com" }))).toBe("FORBIDDEN");

    actAs(`ada@example.com`, `owner`, `Ada`);
    const taken = await client.agents.assign({ id: "conv1", to: "ada@example.com" });
    expect(taken.owner).toEqual({ email: `ada@example.com`, name: `Ada`, since: expect.any(Number) });
});

test("refuses an address that cannot sign in here, and an unknown conversation", async () => {
    const { client, actAs } = board();
    actAs(`bob@example.com`, `collaborator`);
    await runAgentTurn(client, { prompt: "fix it", conversationId: "conv1", isolated: true });
    expect(await errorCode(client.agents.assign({ id: "conv1", to: "stranger@example.com" }))).toBe("BAD_REQUEST");
    expect(await errorCode(client.agents.assign({ id: "conv1", to: "not an address" }))).toBe("BAD_REQUEST");
    expect(await errorCode(client.agents.assign({ id: "missing", to: "bob@example.com" }))).toBe("NOT_FOUND");
});
