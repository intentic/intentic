import { expect, test } from "vitest";

import type { ContractRouterClient } from "@orpc/contract";
import type { MemberRole, sandboxContract } from "@intentic/sandbox-contract";

import { createApp } from "../app.js";
import { clientFor, errorCode, proven, rejectForbidden } from "../harness/route-client.testing.js";
import { services } from "../harness/route-services.testing.js";
import { runAgentTurn } from "../harness/route-turns.testing.js";

// A desk over the daemon's own HTTP surface: it drives its own conversations through the cards it holds and is shown
// nothing else. The rules are fleet-scope.test.ts; what is pinned here is that every route a desk may reach applies
// them, reading the verified caller and never the body.

const board = (): {
    readonly client: ContractRouterClient<typeof sandboxContract>;
    readonly actAs: (email: string, role?: MemberRole, desks?: readonly string[]) => void;
} => {
    let caller = proven(`ada@example.com`, `owner`);
    const app = createApp(
        services({
            auth: { authorize: async () => caller, authorizeOwner: rejectForbidden },
            ownerEmail: async () => `ada@example.com`,
            members: {
                list: async () => [{ email: `dee@example.com`, role: `desk`, desks: [`support`] }],
                add: async () => {},
                remove: async () => {},
            },
        }),
    );
    return {
        client: clientFor(app, { bearer: `member` }),
        actAs: (email, role = `owner`, desks) => {
            caller = proven(email, role, [`google`], desks);
        },
    };
};

// The owner writes two cards and opens a conversation; the desk holds one card and none of the owner's work.
const seeded = async (): Promise<ReturnType<typeof board>> => {
    const b = board();
    await b.client.personas.save({ id: `support`, capabilities: [] });
    await b.client.personas.save({ id: `sales`, capabilities: [] });
    await runAgentTurn(b.client, { prompt: "owner's work", conversationId: "owners", isolated: true });
    b.actAs(`dee@example.com`, `desk`, [`support`]);
    return b;
};

test("a desk's roster is its own conversations, with no held wakes; the owner's stays out of get and transcript", async () => {
    const { client } = await seeded();
    expect(await client.agents.list()).toMatchObject({ agents: [], held: [] });
    expect(await errorCode(client.agents.get({ id: "owners" }))).toBe("FORBIDDEN");
    expect(await errorCode(client.agents.transcript({ id: "owners" }))).toBe("FORBIDDEN");
    expect(await errorCode(client.agents.rename({ id: "owners", title: "mine now" }))).toBe("FORBIDDEN");
    expect(await errorCode(client.agents.archive({ ids: ["owners"] }))).toBe("FORBIDDEN");
});

test("a desk speaks only through a card it holds, and then owns what it starts", async () => {
    const { client } = await seeded();
    expect(await errorCode(client.agent.run({ prompt: "hi", conversationId: "d1", isolated: true }))).toBe("FORBIDDEN");
    expect(await errorCode(client.agent.run({ prompt: "hi", conversationId: "d1", isolated: true, actsAs: "sales" }))).toBe("FORBIDDEN");
    // The owner's conversation is not the desk's to continue, whatever card it wears.
    expect(await errorCode(client.agent.run({ prompt: "hi", conversationId: "owners", isolated: true, actsAs: "support" }))).toBe("FORBIDDEN");

    await runAgentTurn(client, { prompt: "hi", conversationId: "d1", isolated: true, actsAs: "support" });
    const { agents } = await client.agents.list();
    expect(agents.map((agent) => agent.id)).toEqual(["d1"]);
    expect(agents[0]?.owner).toMatchObject({ email: "dee@example.com" });
    expect(await client.agents.get({ id: "d1" })).toMatchObject({ id: "d1" });
    expect(await client.agents.transcript({ id: "d1" })).toMatchObject({ messages: expect.any(Array) });
});

test("a desk is shown the cards it holds and no other", async () => {
    const { client, actAs } = await seeded();
    expect((await client.personas.list()).personas.map((card) => card.id)).toEqual(["support"]);
    actAs(`ada@example.com`, `owner`);
    expect((await client.personas.list()).personas.map((card) => card.id)).toEqual(["support", "sales"]);
});

test("marking everything read, for a desk, marks only its own", async () => {
    const { client } = await seeded();
    await runAgentTurn(client, { prompt: "hi", conversationId: "d1", isolated: true, actsAs: "support" });
    const { agents } = await client.agents.seenAll();
    expect(agents.map((agent) => agent.id)).toEqual(["d1"]);
});
