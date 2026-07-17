import { capabilitiesContract, CapabilitySchema } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import { bearerFrom } from "../auth/auth.js";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import { composeEnvironment } from "../environment/environment.js";
import { capabilityFragments } from "../environment/fragment-sources.js";
import { reconcileListenerProcesses, startAutoStartProcesses } from "../extensions/extension-processes.js";
import { installedExtensions } from "../extensions/installed-extensions.js";
import { capabilityCtx, echoConfig, secretField } from "./capability.js";
import { connectorRegistry } from "./cli/connector-registry.js";
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
            const [capabilities, connectors] = await Promise.all([services.capabilities.list(), connectorRegistry(services)]);
            const rows = await Promise.all(
                capabilities.map(async (capability) => ({
                    id: capability.id,
                    kind: capability.kind,
                    status: await registry[capability.kind].status(ctx, capability.id, capability.config),
                    config: echoConfig(capability, connectors),
                })),
            );
            return { capabilities: rows };
        }),
        add: i.add.handler(async function* ({ input, context }) {
            const handler = registry[input.kind];
            if (adding.has(input.id)) {
                throw new ORPCError("CONFLICT", { message: `"${input.id}" is already being added — wait for it to finish` });
            }
            // Extensions ship code that runs trusted in the browser shell and the agent's turns — installing
            // one IS the trust decision, so only the owner may make it (mirrors /environment/approve; loopback
            // mode has no auth and skips the gate like every other route).
            if (input.kind === "extension" && services.auth !== undefined) {
                try {
                    await services.auth.authorizeOwner(bearerFrom(context.headers.get("authorization") ?? undefined));
                } catch {
                    throw new ORPCError("FORBIDDEN", { message: "only the sandbox owner can install extensions" });
                }
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
                // A fresh extension checkout brings its declared autoStart processes up (the same post-apply
                // seam composeEnvironment uses — full Services, so the narrow handler ctx stays narrow).
                if (input.kind === "extension") {
                    const installed = (await installedExtensions(services)).find((extension) => extension.id === input.id);
                    if (installed !== undefined) {
                        await startAutoStartProcesses(services, installed);
                    }
                }
                // A connector add/remove flips whether its provider's gateway process is wanted (a cli discord
                // entry is what makes ext-discord run) — converge listener extensions on the new manifest.
                void reconcileListenerProcesses(services);
                // Fold this entry's image fragment(s) into the composed overlay (upsert first, so compose sees it).
                const composedHash = await composeEnvironment(services);
                if (
                    (await capabilityFragments(services, input)).length > 0 &&
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
            const field = secretField(capability, await connectorRegistry(services));
            if (field === undefined) {
                throw new ORPCError("CONFLICT", { message: `the ${capability.kind} capability holds no secret` });
            }
            const updated = CapabilitySchema.parse({ ...capability, config: { ...capability.config, [field]: input.value } });
            for await (const line of registry[updated.kind].apply(ctx, updated.id, updated.config)) {
                void line;
            }
            await services.capabilities.upsert(updated);
            void reconcileListenerProcesses(services);
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
            void reconcileListenerProcesses(services);
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
