import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { capabilitiesContract, CapabilitySchema } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import { bearerFrom } from "../auth/auth.js";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import { capabilityJobSession } from "../terminal/terminal-session.js";
import { composeEnvironment } from "../environment/environment.js";
import { syncEndpointCompat } from "../endpoints/endpoint-translator.js";
import { capabilityFragments } from "../environment/fragment-sources.js";
import { reconcileListenerProcesses, startAutoStartProcesses } from "../extensions/extension-processes.js";
import { enabledExtensions } from "../extensions/installed-extensions.js";
import { capabilityCtx } from "./capability.js";
import { echoConfig, secretField } from "./summary.js";
import { contributionFor, contributionRegistry } from "./contributions.js";
import { totpCode } from "./totp.js";
import { browseMarketplace } from "./marketplace.js";
import { capabilityRecommendations } from "./recommend.js";
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
            const [capabilities, connectors, dismissed] = await Promise.all([
                services.capabilities.list(),
                contributionRegistry(services),
                services.capabilityDismissals.list(),
            ]);
            const [rows, recommendations] = await Promise.all([
                Promise.all(
                    capabilities.map(async (capability) => ({
                        id: capability.id,
                        kind: capability.kind,
                        status: await registry[capability.kind].status(ctx, capability.id, capability.config),
                        config: echoConfig(capability, connectors),
                    })),
                ),
                capabilityRecommendations(services.workspace.root, capabilities, dismissed),
            ]);
            return { capabilities: rows, recommendations };
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
                    const installed = (await enabledExtensions(services)).find((extension) => extension.id === input.id);
                    if (installed !== undefined) {
                        await startAutoStartProcesses(services, installed);
                    }
                }
                // A connector add/remove flips whether its provider's gateway process is wanted (a cli discord
                // entry is what makes ext-discord run) — converge listener extensions on the new manifest.
                void reconcileListenerProcesses(services);
                // An endpoint is only drivable once the translator knows how to reach it — awaited, not fired and
                // forgotten, so the "added" the user reads means the next turn on it will actually route.
                if (input.kind === "endpoint") {
                    await syncEndpointCompat(services);
                }
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
            const field = secretField(capability, await contributionRegistry(services));
            if (field === undefined) {
                throw new ORPCError("CONFLICT", { message: `the ${capability.kind} capability holds no secret` });
            }
            const updated = CapabilitySchema.parse({ ...capability, config: { ...capability.config, [field]: input.value } });
            for await (const line of registry[updated.kind].apply(ctx, updated.id, updated.config)) {
                void line;
            }
            await services.capabilities.upsert(updated);
            void reconcileListenerProcesses(services);
            // A rotated endpoint key is a new upstream credential — the translator holds the old one until told.
            if (updated.kind === "endpoint") {
                await syncEndpointCompat(services);
            }
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
            // A removed ACP agent's warm subprocess dies with its capability (re-adds respawn lazily; a
            // config edit respawns on the next turn via the pool's config-key check).
            if (capability.kind === "agent") {
                services.acpConnections.drop(capability.id);
            }
            await services.capabilities.remove(input.id);
            // Removed AFTER the manifest drops it, so the rebuilt list can't put the endpoint straight back.
            if (capability.kind === "endpoint") {
                await syncEndpointCompat(services);
            }
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
        // "Not needed", recorded against the evidence the card is CURRENTLY recommended on — re-derived here
        // rather than taken from the client, so the dismissal answers the claim that was actually on screen and
        // lapses by itself when the workspace moves. A card that is no longer recommended has nothing to record.
        dismiss: i.dismiss.handler(async ({ input }) => {
            const recommendations = await capabilityRecommendations(
                services.workspace.root,
                await services.capabilities.list(),
                await services.capabilityDismissals.list(),
            );
            const recommendation = recommendations.find((candidate) => candidate.card === input.card);
            if (recommendation === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "nothing is being recommended for that card" });
            }
            await services.capabilityDismissals.dismiss({ card: input.card, evidence: recommendation.evidence });
            return { ok: true } as const;
        }),
        // An agent capability's interactive sign-in: run its loginCommand in a live window of the capability's
        // job session, typed via send-keys (the managed-processes pattern) so the USER completes the flow in
        // the attached terminal panel — device codes, browser links, pasted tokens all work. Deliberately not
        // terminalRun (a run-to-completion capture): the route returns immediately and the pane IS the UI.
        // The capability's env block is NOT injected — inline exports would print secrets into the persisted
        // pane logs; login flows establish the agent's own stored credential interactively instead.
        login: i.login.handler(async ({ input }) => {
            const capability = await services.capabilities.get(input.id);
            if (capability === undefined || capability.kind !== "agent") {
                throw new ORPCError("NOT_FOUND", { message: "no agent capability with that id" });
            }
            const loginCommand = capability.config.loginCommand;
            if (loginCommand === undefined) {
                throw new ORPCError("CONFLICT", { message: "this agent declares no login command" });
            }
            if (!services.terminalRun.visible) {
                throw new ORPCError("CONFLICT", { message: "no visible terminal in this environment — run the login command manually" });
            }
            const session = capabilityJobSession(input.id);
            const run = promisify(execFile);
            // Attach-or-create keeps any prior job windows' scrollback; the trailing ":" targets the window's
            // active pane (a bare exact-match `=name` never resolves as a pane target — see managed-processes).
            await run("tmux", ["new-session", "-A", "-d", "-s", session, "-c", services.workspace.root]);
            await run("tmux", ["new-window", "-t", `=${session}:`, "-n", "login", "-c", services.workspace.root]);
            await run("tmux", ["send-keys", "-t", `=${session}:`, "-l", loginCommand]);
            await run("tmux", ["send-keys", "-t", `=${session}:`, "Enter"]);
            return { session };
        }),
        // One TOTP code off the capability's stored seed — the `otp` command's whole backend. The seed field is
        // whichever one the capability's card marks `totp`; the code is minted here so the seed never crosses
        // the wire (this route is the single capability read the per-boot agent token is admitted to).
        otp: i.otp.handler(async ({ input }) => {
            const capability = await services.capabilities.get(input.id);
            if (capability === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "no capability with that id" });
            }
            const contribution = contributionFor(await contributionRegistry(services), capability.kind, capability.config);
            const field = contribution?.spec.fields.find((candidate) => candidate.totp === true);
            const seed = field === undefined ? undefined : (capability.config as Record<string, unknown>)[field.key];
            if (typeof seed !== "string" || seed === "") {
                throw new ORPCError("CONFLICT", { message: `"${input.id}" stores no TOTP secret — add one on its capability card` });
            }
            try {
                return totpCode(seed, Date.now());
            } catch (error) {
                const reason = error instanceof Error ? error.message : String(error);
                throw new ORPCError("CONFLICT", { message: `the stored TOTP secret is unusable (${reason}) — re-add it on the capability card` });
            }
        }),
    };
};
