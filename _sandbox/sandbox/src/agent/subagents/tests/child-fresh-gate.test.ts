import type { FreshSession } from "@intentic/sandbox-contract/schemas/agent";
import { unstubbed } from "@intentic/testing";
import { childActor,supervisorOf } from "../../../auth/principal.js";
import type { Services } from "../../../composition.js";
import type { PersistedAgent } from "../../../conversations/registry/agents-store.js";
import { conversationEntry, isolatedAgent } from "../../../conversations/registry/agents-store.testing.js";
import { admit } from "../child-gates.js";

// A parent opens a review or test session only on the work of a subagent it spawned; on anybody else's work, a person
// does. Refused before anything is spent, by the spawn's own gates.

const ROOT = [{ repo: "root", base: "cut" }];

const servicesOver = (entries: Record<string, PersistedAgent>): Services =>
    unstubbed<Services>("services", {
        agents: unstubbed<Services["agents"]>("agents", { entry: (id: string) => entries[id] }),
        logger: unstubbed<Services["logger"]>("logger", { info: () => undefined }),
    });

const spec = (conversationId: string) => ({ prompt: "review it", provider: "claude", model: "opus", freshOf: { conversationId, kind: "review" } }) as const;

test("refuses a session on work that is not a subagent of this parent's", async () => {
    const services = servicesOver({
        "sub-other": isolatedAgent(ROOT, { id: "sub-other", identity: { startedBy: childActor("someone-else") } }),
        "by-hand": isolatedAgent(ROOT, { id: "by-hand", identity: { startedBy: "ada@example.com" } }),
    });
    for (const id of ["sub-other", "by-hand", "missing"]) {
        const verdict = await admit("spawn", { services, parent: "home-1", spec: spec(id) });
        expect(verdict).toMatchObject({ kind: "refuse", gate: "fresh", message: expect.stringContaining("a subagent you spawned") });
    }
});

test("refuses a session on a review it already opened, which is not work of its own", async () => {
    const services = servicesOver({
        "sub-r": isolatedAgent(ROOT, { id: "sub-r", identity: { startedBy: childActor("sub-a"), fresh: { of: "sub-a", kind: "review", at: 1, by: "home-1" } } }),
    });
    expect(await admit("spawn", { services, parent: "home-1", spec: spec("sub-r") })).toMatchObject({ kind: "refuse", gate: "fresh" });
});

test("refuses its own subagent's work when there is no copy of it to start from", async () => {
    const services = servicesOver({ "sub-a": conversationEntry({ id: "sub-a", identity: { startedBy: childActor("home-1") } }) });
    expect(await admit("spawn", { services, parent: "home-1", spec: spec("sub-a") })).toMatchObject({
        kind: "refuse",
        gate: "fresh",
        message: expect.stringContaining("shared workspace"),
    });
});

test("a session an agent opened is supervised by that agent; a person's, by nobody", () => {
    const review: FreshSession = { of: "sub-a", kind: "test", at: 1 };
    expect(supervisorOf({ startedBy: childActor("sub-a"), fresh: { ...review, by: "home-1" } })).toBe("home-1");
    expect(supervisorOf({ startedBy: childActor("sub-a"), fresh: review })).toBeUndefined();
    expect(supervisorOf({ startedBy: childActor("home-1") })).toBe("home-1");
    expect(supervisorOf({ startedBy: "ada@example.com" })).toBeUndefined();
});
