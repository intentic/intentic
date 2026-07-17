import type { Capability } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import type { AutomationRecord } from "../automations/automations-store.js";
import type { Services } from "../composition.js";
import { listenerProcessesDesired, listenerState } from "./listener-state.js";

const services = (automations: AutomationRecord[], capabilities: Capability[]): Pick<Services, "automations" | "capabilities"> =>
    ({
        automations: { list: async () => automations },
        capabilities: { list: async () => capabilities },
    }) as unknown as Pick<Services, "automations" | "capabilities">;

const listenerAutomation = (id: string, extra: Partial<AutomationRecord> = {}): AutomationRecord => ({
    id,
    trigger: { kind: "listener", provider: "discord" },
    prompt: `wake:${id}`,
    enabled: true,
    runs: [],
    ...extra,
});

test("listenerState returns the provider's enabled listener automations and its connector configs", async () => {
    const state = await listenerState(
        services(
            [
                listenerAutomation("live"),
                listenerAutomation("off", { enabled: false }),
                listenerAutomation("other", { trigger: { kind: "listener", provider: "slack" } }),
                { id: "cron", trigger: { kind: "schedule", cron: "* * * * *" }, prompt: "p", enabled: true, runs: [] },
            ],
            [
                { id: "discord", kind: "cli", config: { provider: "discord", botToken: "SECRET" } },
                { id: "pg", kind: "cli", config: { provider: "postgres", url: "u" } },
                { id: "dock", kind: "docker", config: { enabled: "on" } },
            ],
        ),
        "discord",
    );
    expect(state.automations.map((automation) => automation.id)).toEqual(["live"]);
    expect(state.connectors).toEqual([{ id: "discord", config: { provider: "discord", botToken: "SECRET" } }]);
});

test("listenerProcessesDesired wants the gateway for a connector alone, an automation alone, and neither for empty state", async () => {
    expect(listenerProcessesDesired(await listenerState(services([], []), "discord"))).toBe(false);
    expect(
        listenerProcessesDesired(
            await listenerState(services([], [{ id: "discord", kind: "cli", config: { provider: "discord", botToken: "" } }]), "discord"),
        ),
    ).toBe(true);
    expect(listenerProcessesDesired(await listenerState(services([listenerAutomation("a")], []), "discord"))).toBe(true);
});
