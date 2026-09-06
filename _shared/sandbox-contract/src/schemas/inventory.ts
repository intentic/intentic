// inventory: the i.have.* / i.want.service entries in deploy.config.ts's managed region
import { z } from "zod";
// The daemon renders/parses these; the browser edits them through the inventory routes. Moved here from the
// daemon's deploy-config.ts so the daemon and the browser validate against ONE schema (no cross-repo dupes).

export const InventoryProviderSchema = z.enum(["host", "cloudflare", "github", "gitlab", "stripe"]);
export type InventoryProvider = z.infer<typeof InventoryProviderSchema>;
export const ServiceKindSchema = z.enum(["signoz", "outline", "paperless", "openproject", "invoiceninja", "infisical"]);
export type ServiceKind = z.infer<typeof ServiceKindSchema>;
// Non-secret option values the user provides; secret options (sshKey, apiToken, apiKey) are emitted as env()
// references and never travel over the wire.
export const InventoryValuesSchema = z.record(z.string(), z.union([z.string(), z.number()]));
// `const <name>` binding in deploy.config.ts, so it must be a valid identifier.
const inventoryName = z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/);
export const BackendEntrySchema = z.object({
    kind: z.literal("backend").describe("Something you already have: a machine, an account with a hosting provider."),
    provider: InventoryProviderSchema.describe("Which provider it is with."),
    name: z.string().describe("What to call it, which is also how everything else refers to it."),
    values: InventoryValuesSchema.describe("Its settings. Anything secret is stored separately and referred to here, never written in."),
});
export const ServiceEntrySchema = z.object({
    kind: z.literal("service").describe("Something you want provisioned."),
    service: ServiceKindSchema.describe("Which service."),
    name: z.string().describe("What to call it."),
    values: InventoryValuesSchema.describe("Its settings."),
    on: z.string().describe("Which of your machines to put it on."),
    expose: z.string().describe("How it should be reachable."),
});
// i.want.app, a deployable app built from source. Single production environment on `main`; `values.domain` is
// where it's exposed. Multi-env/teams/use wiring is hand-authored outside the managed region.
export const AppEntrySchema = z.object({
    kind: z.literal("app").describe("An app of your own, built from source and deployed."),
    name: z.string().describe("What to call it."),
    values: InventoryValuesSchema.describe("Its settings, including the address it should answer on."),
    on: z.string().describe("Which of your machines to put it on."),
    expose: z.string().describe("How it should be reachable."),
});
export const InventoryEntrySchema = z.discriminatedUnion("kind", [BackendEntrySchema, ServiceEntrySchema, AppEntrySchema]);
export type InventoryEntry = z.infer<typeof InventoryEntrySchema>;
export const AddInventoryInputSchema = z.discriminatedUnion("kind", [
    BackendEntrySchema.extend({ name: inventoryName }),
    ServiceEntrySchema.extend({ name: inventoryName }),
    AppEntrySchema.extend({ name: inventoryName }),
]);
export type AddInventoryInput = z.infer<typeof AddInventoryInputSchema>;
export const InventoryNameParamSchema = z.object({ name: z.string().describe("Which entry, by name.") });
export const InventoryListSchema = z.object({
    entries: z.array(InventoryEntrySchema).describe("Everything declared: what you have, and what you want provisioned."),
});
// A deploy-target host self-registering via the connect-host script's POST /enroll (connect-token auth). The SSH
// key (+ optional Cloudflare token) is written to desired-state/.env; the host (+ cf) is upserted into inventory.
export const EnrollHostInputSchema = z.object({
    name: inventoryName,
    user: z.string().min(1),
    address: z.string().min(1),
    port: z.coerce.number().default(22),
    via: z.enum(["direct", "cloudflared"]).default("cloudflared"),
    sshKey: z.string().min(1),
    cfToken: z.string().optional(),
    // The zone the connect script resolved alongside cfToken, recorded on the i.have.cloudflare entry so
    // resolve validates against it (no re-discovery) and the Add-service dialog offers `<subdomain>.<zone>`.
    cfZone: z.string().optional(),
});
export type EnrollHostInput = z.infer<typeof EnrollHostInputSchema>;
