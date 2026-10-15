import { CapabilityContributionSchema } from "@intentic/extension-manifest";
import type { Capability } from "@intentic/sandbox-contract";
import type { InstalledExtension } from "../../extensions/installed-extensions.js";
import { contributionKey, type ResolvedContribution } from "../contributions.js";
import { storeRefreshToken } from "../refresh-token.js";

const spec = CapabilityContributionSchema.parse({
    id: "microsoft365",
    kind: "cli",
    catalog: { name: "Microsoft 365", description: "Mail", category: "communication" },
    fields: [
        { key: "tenantId", label: "Tenant" },
        { key: "clientId", label: "Client" },
        { key: "authority", label: "Cloud", default: "login.microsoftonline.com" },
        { key: "refreshToken", label: "Refresh token", secret: true, optional: true },
        { key: "access", label: "Access", default: "write" },
    ],
    env: { M365_TENANT_ID: "${tenantId}" },
    skill: "skills/microsoft365/SKILL.md",
    refreshToken: { field: "refreshToken", boundTo: ["tenantId", "clientId", "authority", "access"] },
});
// SAFETY: the store only reads `extension.id`; the rest of an installed extension never reaches this code path.
const extension = { id: "intentic.microsoft-365" } as InstalledExtension;
const registry: ReadonlyMap<string, ResolvedContribution> = new Map([[contributionKey("cli", "microsoft365"), { spec, extension }]]);

const card: Capability = {
    id: "office-mail",
    kind: "cli",
    config: { provider: "microsoft365", tenantId: "tenant", clientId: "client", refreshToken: "old-secret" },
};
const binding = { tenantId: "tenant", clientId: "client", authority: "login.microsoftonline.com", access: "write" };
const input = { id: "office_mail", binding, previous: "old-secret", refreshToken: "new-secret" };

const storeOf = (stored: Capability, saved: Capability[]) => ({
    get: async (id: string) => (id === stored.id ? stored : undefined),
    list: async () => [stored],
    upsert: async (value: Capability) => {
        saved.push(value);
    },
});

test("a rotation replaces only the declared field, found by the CLI's env-suffix id, and returns nothing", async () => {
    const saved: Capability[] = [];
    expect(await storeRefreshToken(storeOf(card, saved), registry, input, undefined)).toBeUndefined();
    expect(saved).toEqual([{ ...card, config: { ...card.config, refreshToken: "new-secret" } }]);
});

test("an interactive sign-in also moves signedInAt, which a listener keys its connection on", async () => {
    const saved: Capability[] = [];
    await storeRefreshToken(storeOf(card, saved), registry, { ...input, login: true }, "intentic.microsoft-365");
    expect(saved[0]?.config).toMatchObject({ refreshToken: "new-secret", signedInAt: expect.stringMatching(/^\d+$/) });
});

test("a changed card, an unknown predecessor, another extension or an undeclared card is refused unwritten", async () => {
    const saved: Capability[] = [];
    const store = storeOf(card, saved);
    await expect(storeRefreshToken(store, registry, { ...input, binding: { ...binding, clientId: "another" } }, undefined)).rejects.toThrow(
        "clientId changed",
    );
    await expect(storeRefreshToken(store, registry, { ...input, binding: { ...binding, access: "read" } }, undefined)).rejects.toThrow(
        "access changed",
    );
    await expect(storeRefreshToken(store, registry, { ...input, previous: "guessed" }, undefined)).rejects.toThrow("already changed");
    await expect(storeRefreshToken(store, registry, input, "intentic.imap")).rejects.toThrow("not a connection");
    const sharepoint: Capability = { id: "sp", kind: "cli", config: { provider: "sharepoint", refreshToken: "old-secret" } };
    await expect(storeRefreshToken(storeOf(sharepoint, saved), registry, { ...input, id: "sp" }, undefined)).rejects.toThrow(
        "takes a delegated sign-in",
    );
    expect(saved).toEqual([]);
});

test("the first sign-in presents an empty predecessor", async () => {
    const saved: Capability[] = [];
    const fresh: Capability = { id: "office-mail", kind: "cli", config: { provider: "microsoft365", tenantId: "tenant", clientId: "client" } };
    await storeRefreshToken(storeOf(fresh, saved), registry, { ...input, previous: "" }, undefined);
    expect(saved[0]?.config).toMatchObject({ refreshToken: "new-secret" });
});
