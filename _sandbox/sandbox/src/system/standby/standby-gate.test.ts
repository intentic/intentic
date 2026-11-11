import { unstubbed } from "@intentic/testing";
import type { Services } from "../../composition.js";
import { collect } from "../../harness/route-client.testing.js";
import type { TurnInput } from "../../seams/turn-starter.js";
import { streamAgent } from "../../agent/run/stream-agent.js";
import { holdStandby, refusalCodeOf, standbyInfo, standbyRefusal } from "./standby.js";

// A copy on standby starts no turn (standby.ts): every turn passes streamAgent's one gate, a person's send, a released
// queue item and a resumed turn alike, and is refused there before any service is touched (each one throws if reached).

const record = { v: 1 as const, since: Date.UTC(2026, 10, 11, 12), activeHost: { host: "z440", os: "linux", manager: "compose" as const, since: "x" } };

afterEach(() => holdStandby(undefined));

const turns: readonly TurnInput[] = [
    { prompt: "go" },
    { prompt: "go", conversationId: "queued" },
    { prompt: "go", conversationId: "resumed", isolated: true },
    { prompt: "go", conversationId: "remote", placement: { kind: "runner", id: "paired-runner" } },
];

test.each(turns.map((turn) => [turn] as const))("a standby copy refuses the turn, naming the machine that runs the sandbox: %j", async (turn) => {
    holdStandby(record);
    const frames = await collect(streamAgent(unstubbed<Services>("services", {}), turn, undefined));
    expect(frames).toStrictEqual([{ kind: "error", code: "standby", message: standbyRefusal(record) }, { kind: "done" }]);
    expect(standbyRefusal(record)).toContain("This copy is on standby: z440 (linux) runs this sandbox");
});

test("the active copy is admitted as the execution domain says", async () => {
    const admit = jest.fn(() => Promise.reject(new Error("protected policy is corrupt")));
    const services = unstubbed<Services>("services", { agentExecution: unstubbed<Services["agentExecution"]>("agentExecution", { admit }) });
    expect(await collect(streamAgent(services, { prompt: "go" }, undefined))).toStrictEqual([
        { kind: "error", code: "agent-domain-refused", message: "protected policy is corrupt" },
        { kind: "done" },
    ]);
    expect(admit).toHaveBeenCalledTimes(1);
});

test("/info names the active host and since when, only while on standby", () => {
    expect(standbyInfo(undefined)).toBeUndefined();
    expect(standbyInfo(record)).toEqual({ host: "z440 (linux)", since: "2026-11-11T12:00:00.000Z" });
    expect(refusalCodeOf(standbyRefusal(record))).toBe("standby");
    expect(refusalCodeOf("protected policy is corrupt")).toBe("agent-domain-refused");
});
