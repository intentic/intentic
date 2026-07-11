import { capabilitiesContract, CapabilitySchema } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import { composeEnvironment } from "../environment/environment.js";
import { capabilityCtx, echoConfig, secretField } from "./capability.js";
import { browseMarketplace } from "./marketplace.js";
import { registry } from "./registry.js";

// The unified capability manifest routes. `add` streams its apply (mirroring /intentic): the handler yields
// progress frames, then the manifest entry is recorded, then a terminal `result`. A `requires` precondition
// (service/integration → devops) is checked before apply. `list` fans each handler's status() concurrently.
export const createCapabilitiesRoutes = (services: Services) => {
    const i = implement(capabilitiesContract).$context<OrpcContext>();
    const ctx = capabilityCtx(services);
    // One add per id at a time: a concurrent same-id add would interleave two handler runs in the same visible
    // job session (and race the manifest upsert) — reject the second instead.
    const adding = new Set<string>();
    return {
        list: i.list.handler(async () => {
            const capabilities = await services.capabilities.list();
            const rows = await Promise.all(
                capabilities.map(async (capability) => ({
                    id: capability.id,
                    kind: capability.kind,
                    status: await registry[capability.kind].status(ctx, capability.id, capability.config),
                    config: echoConfig(capability),
                })),
            );
            return { capabilities: rows };
        }),
        add: i.add.handler(async function* ({ input }) {
            const handler = registry[input.kind];
            if (adding.has(input.id)) {
                throw new ORPCError("CONFLICT", { message: `"${input.id}" is already being added — wait for it to finish` });
            }
            const active = await services.capabilities.list();
            for (const required of handler.requires ?? []) {
                if (!active.some((capability) => capability.kind === required)) {
                    throw new ORPCError("PRECONDITION_FAILED", { message: `activate ${required} first` });
                }
            }
            adding.add(input.id);
            try {
                yield* handler.apply(ctx, input.id, input.config);
                await services.capabilities.upsert(input);
                // Fold this entry's image fragment into the composed overlay (upsert first, so compose sees it).
                const composedHash = await composeEnvironment(services);
                if (
                    handler.fragment?.(input.config) !== undefined &&
                    composedHash !== undefined &&
                    composedHash !== services.config.sandbox.environmentHash
                ) {
                    yield {
                        kind: "log",
                        message:
                            "This capability extends the sandbox image — a one-time rebuild is needed. Open the Sandbox page's Environment card for the command.",
                    };
                }
                yield { kind: "result", ok: true };
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                yield { kind: "error", message };
                throw new ORPCError("INTERNAL_SERVER_ERROR", { message });
            } finally {
                adding.delete(input.id);
            }
        }),
        // Replace just the capability's secret field and re-run its idempotent apply (ssh/vpn rewrite their
        // credential files, plugin re-clones with the new token, cli/mcp are cheap). No composeEnvironment: a
        // secret can't change a fragment. Apply-before-upsert keeps the old secret if the apply fails.
        setSecret: i.setSecret.handler(async ({ input }) => {
            const capability = await services.capabilities.get(input.id);
            if (capability === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "no capability with that id" });
            }
            const field = secretField(capability);
            if (field === undefined) {
                throw new ORPCError("CONFLICT", { message: `the ${capability.kind} capability holds no secret` });
            }
            const updated = CapabilitySchema.parse({ ...capability, config: { ...capability.config, [field]: input.value } });
            for await (const line of registry[updated.kind].apply(ctx, updated.id, updated.config)) {
                void line;
            }
            await services.capabilities.upsert(updated);
            return { ok: true } as const;
        }),
        remove: i.remove.handler(async ({ input }) => {
            const capability = await services.capabilities.get(input.id);
            if (capability === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "no capability with that id" });
            }
            const handler = registry[capability.kind];
            if (handler.remove === undefined) {
                throw new ORPCError("CONFLICT", { message: `the ${capability.kind} capability can't be removed` });
            }
            await handler.remove(ctx, capability.id, capability.config);
            await services.capabilities.remove(input.id);
            await composeEnvironment(services);
            return { ok: true } as const;
        }),
        status: i.status.handler(async ({ input }) => {
            const capability = await services.capabilities.get(input.id);
            if (capability === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "no capability with that id" });
            }
            return registry[capability.kind].status(ctx, capability.id, capability.config);
        }),
        marketplace: i.marketplace.handler(async ({ input }) => browseMarketplace(ctx, input.url, input.token)),
    };
};
