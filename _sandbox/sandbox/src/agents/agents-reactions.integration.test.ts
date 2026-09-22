import { test, expect } from "bun:test";

import type { ContractRouterClient } from "@orpc/contract";
import type { MemberRole, sandboxContract } from "@intentic/sandbox-contract";

import { createApp } from "../app.js";
import { clientFor, errorCode, proven, rejectForbidden } from "../harness/route-client.testing.js";
import { services } from "../harness/route-services.testing.js";
import { runAgentTurn } from "../harness/route-turns.testing.js";
import { MAX_REACTION_KINDS } from "./registry/agents-registry.js";

// Reactions over the daemon's own HTTP surface, where the thing worth pinning is the part the browser cannot be
// trusted with: who a mark is attributed to. Everything about how marks group and toggle is agents-registry.test.ts.

// One daemon whose verified caller this suite can change between calls, which is how two people mark one card.
const board = (): {
    readonly client: ContractRouterClient<typeof sandboxContract>;
    readonly actAs: (email: string, role?: MemberRole, name?: string) => void;
} => {
    let caller = proven(`ada@example.com`, `maintainer`);
    const app = createApp(
        services({
            auth: { authorize: async () => caller, authorizeOwner: rejectForbidden },
        }),
    );
    return {
        client: clientFor(app, { bearer: `member` }),
        actAs: (email, role = `maintainer`, name) => {
            caller = { ...proven(email, role), ...(name === undefined ? {} : { name }) };
        },
    };
};

test("a mark is attributed to the verified caller, and a second person's press joins the same chip", async () => {
    const { client, actAs } = board();
    actAs(`ada@example.com`, `maintainer`, `Ada Lovelace`);
    await runAgentTurn(client, { prompt: "fix it", conversationId: "conv1", isolated: true });

    const marked = await client.agents.react({ id: "conv1", emoji: "👍", on: true });
    expect(marked.reactions).toEqual([{ emoji: "👍", by: [{ email: "ada@example.com", name: "Ada Lovelace", at: expect.any(Number) }] }]);

    // A viewer may leave one: the floor for this route is the lowest tier there is (auth/role-floor.ts).
    actAs(`bob@example.com`, `viewer`, `Bob`);
    const joined = await client.agents.react({ id: "conv1", emoji: "👍", on: true });
    expect(joined.reactions?.[0]?.by.map((who) => who.name)).toEqual(["Ada Lovelace", "Bob"]);

    // And takes back only their own, leaving the chip standing for whoever else wears it.
    const left = await client.agents.react({ id: "conv1", emoji: "👍", on: false });
    expect(left.reactions).toEqual([{ emoji: "👍", by: [{ email: "ada@example.com", name: "Ada Lovelace", at: expect.any(Number) }] }]);

    // The roster everyone else reads carries it too, not just the answer the presser got back.
    const { agents } = await client.agents.list();
    expect(agents[0]?.reactions?.[0]?.emoji).toBe("👍");
});

test("refuses anything that is not one emoji, and an unknown conversation", async () => {
    const { client } = board();
    await runAgentTurn(client, { prompt: "fix it", conversationId: "conv1", isolated: true });
    expect(await errorCode(client.agents.react({ id: "conv1", emoji: "lgtm", on: true }))).toBe("BAD_REQUEST");
    expect(await errorCode(client.agents.react({ id: "conv1", emoji: "👍👎", on: true }))).toBe("BAD_REQUEST");
    expect(await errorCode(client.agents.react({ id: "nope", emoji: "👍", on: true }))).toBe("NOT_FOUND");
});

// Bounded by kinds rather than by presses: a card everyone agrees with is one chip, and a card with a hundred
// different emoji on it is a row nothing can draw.
test("stops at the kinds cap, while the marks already there still take presses", async () => {
    const { client } = board();
    await runAgentTurn(client, { prompt: "fix it", conversationId: "conv1", isolated: true });
    // Distinct marks, drawn from a range that is entirely emoji (U+1F600 upward).
    const filled = Array.from({ length: MAX_REACTION_KINDS }, (_, index) => String.fromCodePoint(0x1_f600 + index));
    for (const emoji of filled) {
        await client.agents.react({ id: "conv1", emoji, on: true });
    }
    expect(await errorCode(client.agents.react({ id: "conv1", emoji: "🚀", on: true }))).toBe("BAD_REQUEST");
    // Not a freeze on the card: one already there can still be taken back, which is also how room is made.
    const room = await client.agents.react({ id: "conv1", emoji: filled[0]!, on: false });
    expect(room.reactions).toHaveLength(MAX_REACTION_KINDS - 1);
    expect((await client.agents.react({ id: "conv1", emoji: "🚀", on: true })).reactions).toHaveLength(MAX_REACTION_KINDS);
});
