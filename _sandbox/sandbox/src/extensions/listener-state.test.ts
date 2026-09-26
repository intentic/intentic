import { ExtensionManifestSchema } from "@intentic/extension-manifest";
import type { Capability } from "@intentic/sandbox-contract";
import type { AutomationRecord } from "../automations/automations-store.js";
import type { Services } from "../composition.js";
import { automationRecord } from "../harness/route-stores.testing.js";
import { listenerContribution } from "../testing.js";
import type { InstalledExtension } from "./installed-extensions.js";
import { listenerProcessesDesired, listenerState, resolveListenerOwners } from "./listener-state.js";

const services = (automations: AutomationRecord[], capabilities: Capability[]): Pick<Services, "automations" | "capabilities"> =>
    ({
        automations: { list: async () => automations },
        capabilities: { list: async () => capabilities },
    }) as unknown as Pick<Services, "automations" | "capabilities">;

const listenerAutomation = (id: string, extra: Partial<AutomationRecord> = {}): AutomationRecord =>
    automationRecord(id, { trigger: { kind: "listener", provider: "discord" }, ...extra });

test("listenerState returns the provider's enabled listener automations and its connector configs", async () => {
    const state = await listenerState(
        services(
            [
                listenerAutomation("live"),
                listenerAutomation("off", { enabled: false }),
                listenerAutomation("other", { trigger: { kind: "listener", provider: "slack" } }),
                automationRecord("cron", { prompt: "p" }),
            ],
            [
                { id: "discord", kind: "cli", config: { provider: "discord", botToken: "SECRET" } },
                { id: "pg", kind: "cli", config: { provider: "postgres", url: "u" } },
                { id: "reddit", kind: "browser", config: { platform: "reddit" } },
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

const declaring = (id: string, provider: string): InstalledExtension => {
    const [publisher = "acme", name = id] = id.split(".");
    return {
        id,
        dir: `/extensions/${id}`,
        source: "workspace",
        enabled: true,
        manifest: ExtensionManifestSchema.parse({
            publisher,
            name,
            version: "1.0.0",
            engines: { intentic: "^0.2.0" },
            contributes: { listener: listenerContribution(provider, ["message"]) },
        }),
    };
};

// A provider has one listener: two extensions declaring it are settled by one rule, and the loser is told why.
test("the declarer that contributes the provider's card owns its listener, whatever the enumeration order", () => {
    const impostor = declaring("evil.discord-lookalike", "discord");
    const real = declaring("intentic.discord", "discord");
    const { owners, refused } = resolveListenerOwners([impostor, real], (provider) => (provider === "discord" ? "intentic.discord" : undefined));
    expect(owners).toEqual(new Map([["discord", "intentic.discord"]]));
    expect([...refused.keys()]).toEqual(["evil.discord-lookalike"]);
    expect(refused.get("evil.discord-lookalike")).toContain("intentic.discord already owns");
});

test("with no card to decide, the first declarer owns it, and a provider declared once is simply its declarer's", () => {
    const first = declaring("acme.first", "matrix");
    const second = declaring("acme.second", "matrix");
    const lone = declaring("acme.lone", "irc");
    const { owners, refused } = resolveListenerOwners([first, second, lone], () => undefined);
    expect(owners).toEqual(
        new Map([
            ["matrix", "acme.first"],
            ["irc", "acme.lone"],
        ]),
    );
    expect(refused.get("acme.second")).toContain("installed first");
    expect(refused.has("acme.first") || refused.has("acme.lone")).toBe(false);
    // A card owned by an extension that does not declare the listener decides nothing.
    expect(resolveListenerOwners([first, second], () => "acme.cards-only").owners.get("matrix")).toBe("acme.first");
});
