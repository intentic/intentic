import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../../composition.js";
import { beginTurn } from "../actor/conversation-actors.testing.js";
import { memoryFleet } from "../registry/agents-registry.testing.js";
import { messageConversation } from "./fleet-message.js";

// The hourly ceiling on turns one conversation's `agents message` may start elsewhere, across a restart: a second daemon
// on the same history volume, with nothing of the first one's memory, still counts the turns the first one started.

// One daemon: its own registry and actors, the turn port answering every start, on the history volume it is handed.
const daemon = async (historyRoot: string) => {
    const fleet = memoryFleet();
    await fleet.agents.init();
    await beginTurn(fleet.conversations, { conversationId: "target", isolated: false, prompt: "earlier", profile: { agent: "claude", harness: "native" } }, 1);
    await fleet.conversations.send("target", { kind: "settle" }, 2).settled;
    let started = 0;
    const services = unstubbed<Services>("services", {
        agents: fleet.agents,
        conversations: fleet.conversations,
        config: unstubbed<Services["config"]>("config", { historyRoot }),
        turns: unstubbed<Services["turns"]>("turns", {
            steer: async () => false,
            start: async () => {
                started += 1;
                return { id: `run-${started}`, async *frames() {} };
            },
        }),
        logger: unstubbed<Services["logger"]>("logger", { info: () => {} }),
    });
    return { services, started: () => started };
};

test("a sender's hourly budget still counts the turns it started before the daemon restarted", async () => {
    const historyRoot = mkdtempSync(join(tmpdir(), "fleet-cap-"));
    const before = await daemon(historyRoot);
    for (let turn = 0; turn < 20; turn += 1) {
        expect(await messageConversation(before.services, "sender", "target", `ping ${turn}`)).toMatchObject({ ok: true, delivery: "turn" });
    }
    expect(before.started()).toBe(20);

    const after = await daemon(historyRoot);
    expect(await messageConversation(after.services, "sender", "target", "ping again")).toMatchObject({ ok: false, status: 429 });
    expect(after.started()).toBe(0);
    // Another sender's budget is its own.
    expect(await messageConversation(after.services, "other", "target", "hello")).toMatchObject({ ok: true, delivery: "turn" });
});
