import { createDomainEvents, type DomainEventName } from "./domain-events.js";

const failures = (): { readonly seen: [DomainEventName, unknown][]; readonly failed: (name: DomainEventName, error: unknown) => void } => {
    const seen: [DomainEventName, unknown][] = [];
    return { seen, failed: (name, error) => void seen.push([name, error]) };
};

describe("the domain events bus", () => {
    test("delivers before publish returns, to every subscriber in the order it subscribed, across events", () => {
        const { failed } = failures();
        const events = createDomainEvents(failed);
        const heard: string[] = [];
        events.subscribe("tree.changed", (event) => void heard.push(`history:${event.label}`));
        events.subscribe("workspace", (event) => void heard.push(`chores:${event.event}`));
        events.subscribe("tree.changed", (event) => void heard.push(`second:${event.label}`));

        events.publish("tree.changed", { label: "ship it" });
        events.publish("workspace", { event: "agent.landed", agentId: "a1", branch: "agent/a1", outcome: "landed", repos: [] });

        expect(heard).toEqual(["history:ship it", "second:ship it", "chores:agent.landed"]);
    });

    test("a throwing or rejecting subscriber is reported and costs neither the publisher nor the rest", async () => {
        const { seen, failed } = failures();
        const events = createDomainEvents(failed);
        const heard: string[] = [];
        const thrown = new Error("sync");
        const rejected = new Error("async");
        events.subscribe("run.settled", () => {
            throw thrown;
        });
        events.subscribe("run.settled", async () => {
            throw rejected;
        });
        events.subscribe("run.settled", (event) => void heard.push(event.conversationId));

        events.publish("run.settled", { conversationId: "c1", actor: undefined, failure: undefined, closing: "" });
        await Promise.resolve();

        expect(heard).toEqual(["c1"]);
        expect(seen).toEqual([
            ["run.settled", thrown],
            ["run.settled", rejected],
        ]);
    });

    test("an unsubscribed listener hears nothing more, and one subscribed mid-delivery waits for the next event", () => {
        const { failed } = failures();
        const events = createDomainEvents(failed);
        const heard: string[] = [];
        const late = (event: { readonly label: string }): void => void heard.push(`late:${event.label}`);
        const unsubscribe = events.subscribe("tree.changed", (event) => {
            heard.push(`first:${event.label}`);
            events.subscribe("tree.changed", late);
        });

        events.publish("tree.changed", { label: "one" });
        unsubscribe();
        events.publish("tree.changed", { label: "two" });

        expect(heard).toEqual(["first:one", "late:two"]);
    });
});
