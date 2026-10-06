import { createHeldCards, type HeldCard, type HeldOutcome } from "./held-cards.js";

// A held card the test settles by hand, recording what the hold did with it.
const card = (command: string, options: { readonly typed?: boolean } = {}) => {
    const settled = Promise.withResolvers<HeldOutcome>();
    const did: string[] = [];
    const held: HeldCard = {
        machine: "omen",
        command,
        typed: options.typed === true,
        settled: settled.promise,
        cancel: () => {
            did.push("cancel");
            settled.resolve({ decision: "unanswered" });
        },
        carry: () => did.push("carry"),
    };
    return { held, settle: settled.resolve, did };
};

const wakes = () => {
    const said: { readonly conversationId: string; readonly prompt: string }[] = [];
    return { said, wake: async (conversationId: string, prompt: string) => void said.push({ conversationId, prompt }) };
};

it("returns at once and wakes nobody when the conversation holds no card", async () => {
    const { said, wake } = wakes();
    await createHeldCards(wake).hold("c", undefined);
    expect(said).toEqual([]);
});

it("keeps an approval for the same call and wakes the conversation to make it, naming the machine and the exact command", async () => {
    const { said, wake } = wakes();
    const cards = createHeldCards(wake);
    const rm = card("rm -rf /run/podman && echo `done`");
    cards.add("c", rm.held);
    const holding = cards.hold("c", undefined);
    rm.settle({ decision: "approved" });
    await holding;

    expect(rm.did).toEqual(["carry"]);
    expect(said).toEqual([
        {
            conversationId: "c",
            prompt:
                'The owner allowed running this on "omen" after your turn ended. It has not run yet:\n\n```\nrm -rf /run/podman && echo `done`\n```\n\n' +
                "Run it now with exactly the same call: the same tool, the same command and the same arguments. The approval is kept for " +
                "that exact call and used once; anything different is asked about afresh.\n\nThen continue the task.",
        },
    ]);
    expect(cards.open("c")).toEqual([]);
});

it("wakes the conversation with the owner's note on a decline that gave one", async () => {
    const { said, wake } = wakes();
    const cards = createHeldCards(wake);
    const typed = card("rm -rf ~", { typed: true });
    cards.add("c", typed.held);
    const holding = cards.hold("c", undefined);
    typed.settle({ decision: "declined", feedback: "Not my home directory." });
    await holding;

    expect(typed.did).toEqual([]);
    expect(said.map((one) => one.prompt)).toEqual([
        'The owner declined typing this on "omen" after your turn ended, so it did not get typed:\n\n```\nrm -rf ~\n```\n\n' +
            "Their note: Not my home directory.\n\nDo not run it or anything that does the same thing.\n\nThen continue the task.",
    ]);
});

it("wakes nobody on a bare decline or a card nobody answered", async () => {
    const { said, wake } = wakes();
    const cards = createHeldCards(wake);
    const declined = card("rm -rf a");
    const unanswered = card("rm -rf b");
    cards.add("c", declined.held);
    cards.add("c", unanswered.held);
    const holding = cards.hold("c", undefined);
    declined.settle({ decision: "declined", feedback: "  " });
    unanswered.settle({ decision: "unanswered" });
    await holding;

    expect(said).toEqual([]);
    expect([...declined.did, ...unanswered.did]).toEqual([]);
});

it("waits for every card before it wakes, in one message", async () => {
    const { said, wake } = wakes();
    const cards = createHeldCards(wake);
    const one = card("rm -rf a");
    const two = card("rm -rf b");
    cards.add("c", one.held);
    cards.add("c", two.held);
    const holding = cards.hold("c", undefined);
    one.settle({ decision: "approved" });
    await Promise.resolve();
    expect(said).toEqual([]);
    two.settle({ decision: "approved" });
    await holding;

    expect(said).toHaveLength(1);
    expect(said[0]?.prompt).toContain("rm -rf a");
    expect(said[0]?.prompt).toContain("rm -rf b");
});

it("cancels every held card and wakes nobody when the turn is stopped", async () => {
    const { said, wake } = wakes();
    const cards = createHeldCards(wake);
    const rm = card("rm -rf a");
    cards.add("c", rm.held);
    const stop = new AbortController();
    const holding = cards.hold("c", stop.signal);
    stop.abort();
    await holding;

    expect(rm.did).toEqual(["cancel"]);
    expect(said).toEqual([]);
    expect(cards.open("c")).toEqual([]);
});

it("holds nothing for a card its call already collected, nor another conversation's", async () => {
    const { said, wake } = wakes();
    const cards = createHeldCards(wake);
    const collected = card("rm -rf a");
    const elsewhere = card("rm -rf b");
    const release = cards.add("c", collected.held);
    cards.add("other", elsewhere.held);
    release();

    await cards.hold("c", undefined);
    expect(said).toEqual([]);
    expect(cards.open("other")).toEqual([elsewhere.held]);
});
