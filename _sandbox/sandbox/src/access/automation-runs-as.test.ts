import type { Automation } from "@intentic/sandbox-contract/schemas/automations";
import {
    automationConfig,
    memoryAccessProfiles,
    memoryMembersStore,
    memoryPersonasStore,
    memoryServicesStore,
} from "../harness/route-stores.testing.js";
import { refuseServiceMismatch } from "./automation-runs-as.js";

// An automation's service is checked as it is saved: it must exist, and what it pairs with it (a persona's accounts, the
// models it may run on) must be something the service could ever use.

const deps = {
    services: memoryServicesStore([
        { id: "bot", label: "Marketing bot", steward: "ada@example.com", profile: "marketing" },
        { id: "free", steward: "ada@example.com" },
    ]),
    accessProfiles: memoryAccessProfiles([{ id: "marketing", credentials: { capabilities: ["reddit-work"], secrets: [] }, aiAccounts: ["claude:work"] }]),
    members: memoryMembersStore([]),
    ownerEmail: async () => "ada@example.com",
    personas: memoryPersonasStore([
        { id: "poster", label: "Poster", capabilities: ["reddit-work"] },
        { id: "tweeter", label: "Tweeter", capabilities: ["x-main"] },
    ]),
};

const MODELS: Automation["models"] = [{ provider: "claude", model: "claude-sonnet-5-5" }];

test("an automation acting for the owner, or as a service that limits nothing it pairs, saves", async () => {
    await expect(refuseServiceMismatch(deps, automationConfig("plain", { actsAs: "tweeter" }))).resolves.toBeUndefined();
    await expect(refuseServiceMismatch(deps, automationConfig("free", { runAs: "free", actsAs: "tweeter" }))).resolves.toBeUndefined();
    await expect(refuseServiceMismatch(deps, automationConfig("fits", { runAs: "bot", actsAs: "poster", models: MODELS }))).resolves.toBeUndefined();
});

test("a service nobody wrote is refused, a sender rule's included", async () => {
    await expect(refuseServiceMismatch(deps, automationConfig("ghost", { runAs: "ghost" }))).rejects.toThrow(
        `no service is called "ghost": pick one that exists, or leave it acting for the owner`,
    );
    const rule = automationConfig("rule", {
        trigger: { kind: "listener", provider: "discord" },
        senders: { rules: [{ ids: ["1"], runAs: "ghost" }], others: "ignore" },
    });
    await expect(refuseServiceMismatch(deps, rule)).rejects.toThrow(`no service is called "ghost"`);
});

test("a persona speaking through an account the service may not use is refused", async () => {
    await expect(refuseServiceMismatch(deps, automationConfig("x", { runAs: "bot", actsAs: "tweeter" }))).rejects.toThrow(
        `the persona "Tweeter" speaks through "x-main", which the service "Marketing bot" may not use, so it could never use it there`,
    );
});

test("models outside the service's AI accounts, or a pinned account outside them, are refused", async () => {
    await expect(
        refuseServiceMismatch(deps, automationConfig("codex", { runAs: "bot", models: [{ provider: "codex", model: "gpt-6.1-sol" }] })),
    ).rejects.toThrow(`none of the models it may run on is an AI account the service "Marketing bot" may use; pick a model on one it may`);
    await expect(refuseServiceMismatch(deps, automationConfig("pinned", { runAs: "bot", models: MODELS, account: "personal" }))).rejects.toThrow(
        `the account it pays with is not one the service "Marketing bot" may use`,
    );
});
