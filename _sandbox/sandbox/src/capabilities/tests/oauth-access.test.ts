import { CapabilityContributionSchema } from "@intentic/extension-manifest";
import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import type { InstalledExtension } from "../extension-inventory/installed-extensions.js";
import { contributionKey, type ResolvedContribution } from "../contributions.js";
import { type AccessDoor, mintPlatformAccess } from "../oauth-access.js";

// A card signed in through the platform's own client refreshes there: the daemon hands the platform the card's own
// token, the caller only names the card, and Google's refusal comes back as its code for the CLI to put into words.

const spec = CapabilityContributionSchema.parse({
    id: "google",
    kind: "cli",
    catalog: { name: "Google Workspace", description: "Mail", category: "communication" },
    fields: [
        { key: "mode", label: "Connect as", default: "user" },
        { key: "clientId", label: "Client", optional: true },
        { key: "refreshToken", label: "Google account", secret: true, optional: true, signIn: "google" },
    ],
    env: { GOOGLE_MODE: "${mode}" },
    skill: "skills/google/SKILL.md",
    refreshToken: { field: "refreshToken", boundTo: ["mode", "clientId"] },
});
// SAFETY: the mint only reads `extension.id`; the rest of an installed extension never reaches this code path.
const extension = { id: "intentic.google-workspace" } as InstalledExtension;
const registry: ReadonlyMap<string, ResolvedContribution> = new Map([[contributionKey("cli", "google"), { spec, extension }]]);

const card: Capability = { id: "work-gmail", kind: "cli", config: { provider: "google", mode: "user", refreshToken: "rt-card" } };
const storeOf = (stored: Capability) => ({
    get: async (id: string) => (id === stored.id ? stored : undefined),
    list: async () => [stored],
});

const answering = (status: number, data?: { accessToken: string; expiresIn: number }, refusal?: string) =>
    jest.fn<AccessDoor>().mockResolvedValue({ status, data, refusal, body: "" });

test("trades the card's own refresh token, found by the CLI's env-suffix id", async () => {
    const door = answering(200, { accessToken: "at-1", expiresIn: 3599 });
    expect(await mintPlatformAccess(storeOf(card), registry, door, "work_gmail", undefined)).toEqual({ accessToken: "at-1", expiresIn: 3599 });
    expect(door).toHaveBeenCalledWith("rt-card");
});

test("relays Google's refusal code, and refuses a card never signed in without asking the platform", async () => {
    await expect(mintPlatformAccess(storeOf(card), registry, answering(400, undefined, "invalid_grant"), "work-gmail", undefined)).rejects.toMatchObject({
        status: 400,
        message: "invalid_grant",
    });
    const door = answering(200, { accessToken: "at", expiresIn: 1 });
    const unsigned: Capability = { ...card, config: { provider: "google", mode: "user" } };
    await expect(mintPlatformAccess(storeOf(unsigned), registry, door, "work-gmail", undefined)).rejects.toThrow("not been signed in");
    expect(door).not.toHaveBeenCalled();
});

test("another extension's process is refused", async () => {
    const door = answering(200, { accessToken: "at", expiresIn: 1 });
    await expect(mintPlatformAccess(storeOf(card), registry, door, "work-gmail", "intentic.imap")).rejects.toThrow("not a connection");
    await expect(mintPlatformAccess(storeOf(card), registry, door, "work-gmail", "intentic.google-workspace")).resolves.toBeDefined();
});
