import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { errorMessage } from "@intentic/base/errors";
import { type Capability, capabilitiesContract, CapabilitySchema, isVaulted } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import { authorizeMaintainer, bearerFrom } from "../auth/auth.js";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../app-env.js";
import { capabilityJobSession } from "../terminal/terminal-session.js";
import { composeEnvironment } from "../environment/environment.js";
import { syncEndpointCompat } from "../endpoints/endpoint-translator.js";
import { mintsEndpointProvider } from "../endpoints/local-model.js";
import { capabilityFragments } from "../environment/fragment-sources.js";
import { reconcileListenerProcesses, startAutoStartProcesses } from "../extensions/extension-processes.js";
import { enabledExtensions } from "../extensions/installed-extensions.js";
import { type CapabilityCtx, capabilityCtx } from "./capability.js";
import { echoConfig, secretField } from "./summary.js";
import { secretFieldsOf } from "./secret-fields.js";
import { contributionFor, contributionRegistry } from "./contributions.js";
import { totpCode } from "./totp.js";
import { browseMarketplace } from "./marketplace.js";
import { probeCapability } from "./probe.js";
import { capabilityRecommendations } from "./recommend.js";
import { registry } from "./registry.js";

// Follows a capability id everywhere else it's stored by name: an account's identity, an identity's mailbox, a
// persona's capabilities list. Kept out of the handlers, since none of these is a fact about the kind being renamed.
const repointCapabilityReferences = async (services: Services, ctx: CapabilityCtx, from: string, to: string): Promise<void> => {
    // Re-parsed rather than spread: the schema both narrows the entry to its own arm and validates it.
    const repointed = (entry: Capability, key: "identity" | "mailbox"): Capability =>
        CapabilitySchema.parse({ ...entry, config: { ...entry.config, [key]: to } });
    // Re-applies as well as stores: an account's skill file names its connection by hand, and only apply rewrites it.
    const restore = async (entry: Capability, key: "identity" | "mailbox"): Promise<void> => {
        const next = repointed(entry, key);
        await services.capabilities.upsert(next);
        try {
            for await (const line of registry[next.kind].apply(ctx, next.id, next.config)) {
                void line;
            }
        } catch (error) {
            // Best-effort: this entry isn't the one being renamed, so an unrelated apply failure must not fail the
            // rename.
            services.logger.warn(
                `capabilities: renamed "${from}" but could not refresh "${next.id}" (${errorMessage(error)}), re-add it from its card`,
            );
        }
    };
    for (const entry of await services.capabilities.list()) {
        if (entry.kind === "browser" && entry.config.identity === from) {
            await restore(entry, "identity");
        }
        if (entry.kind === "identity" && entry.config.mailbox === from) {
            await restore(entry, "mailbox");
        }
    }
    for (const persona of await services.personas.list()) {
        if (persona.capabilities.includes(from)) {
            await services.personas.upsert({ ...persona, capabilities: persona.capabilities.map((id) => (id === from ? to : id)) });
        }
    }
};

// Resolves a VAULTED field (the edit form never sees existing secrets) back to the stored value before apply runs. A
// marker with nothing stored behind it is refused, not passed through, so it can't land in a real config file.
const withKeptSecrets = async (services: Services, input: Capability): Promise<Capability> => {
    const config = input.config as Record<string, unknown>;
    const kept = Object.keys(config).filter((key) => isVaulted(config[key]));
    if (kept.length === 0) {
        return input;
    }
    const stored = await services.capabilities.get(input.id);
    // A different kind stored under the same id is not this connection; its config is not the secret being kept.
    const storedConfig = (stored?.kind === input.kind ? stored.config : {}) as Record<string, unknown>;
    const missing = kept.filter((key) => typeof storedConfig[key] !== "string" || isVaulted(storedConfig[key]));
    if (missing.length > 0) {
        throw new ORPCError("BAD_REQUEST", {
            message: `nothing stored for ${missing.join(", ")} on "${input.id}", enter the value rather than keeping it`,
        });
    }
    return CapabilitySchema.parse({ ...input, config: { ...config, ...Object.fromEntries(kept.map((key) => [key, storedConfig[key]])) } });
};

// `add` streams progress frames, then records the manifest entry, then a terminal `result`, after checking any
// `requires` precondition. `list` fans each handler's status() out concurrently.
export const createCapabilitiesRoutes = (services: Services) => {
    const i = implement(capabilitiesContract).$context<OrpcContext>();
    const ctx = capabilityCtx(services);
    // One add per id at once, or a concurrent same-id add interleaves handler runs and races the manifest upsert.
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
                        // Names of the credentials this entry holds, so an edit form can show dots without showing a
                        // value.
                        secrets: [...secretFieldsOf(capability, connectors)],
                    })),
                ),
                capabilityRecommendations(services.workspace.root, capabilities, dismissed),
            ]);
            return { capabilities: rows, recommendations };
        }),
        add: i.add.handler(async function* ({ input, context }) {
            const handler = registry[input.kind];
            if (adding.has(input.id)) {
                throw new ORPCError("CONFLICT", { message: `"${input.id}" is already being added, wait for it to finish` });
            }
            // Extensions run trusted code in the browser shell and agent turns; installing one needs the operating
            // tier.
            if (input.kind === "extension" && services.auth !== undefined) {
                try {
                    await authorizeMaintainer(services.auth, bearerFrom(context.headers.get("authorization") ?? undefined));
                } catch {
                    throw new ORPCError("FORBIDDEN", { message: "only a sandbox maintainer can install extensions" });
                }
            }
            const active = await services.capabilities.list();
            for (const required of handler.requires ?? []) {
                if (!active.some((capability) => capability.kind === required)) {
                    throw new ORPCError("PRECONDITION_FAILED", { message: `activate ${required} first` });
                }
            }
            // Resolved before the id is claimed, so a bad "keep" request refuses plainly instead of erroring
            // mid-stream.
            const entry = await withKeptSecrets(services, input);
            adding.add(input.id);
            try {
                yield* handler.apply(ctx, entry.id, entry.config);
                await services.capabilities.upsert(entry);
                // Brings the extension's declared autoStart processes up, the same post-apply seam composeEnvironment
                // uses.
                if (input.kind === "extension") {
                    const installed = (await enabledExtensions(services)).find((extension) => extension.id === input.id);
                    if (installed !== undefined) {
                        await startAutoStartProcesses(services, installed);
                    }
                    // Loaded code can't be joined, only replaced; restarting is how its `server` bundle joins the
                    // backend host.
                    services.extensionBackend.restart();
                }
                // A connector add or remove flips whether its provider's gateway is wanted; this converges listener
                // extensions.
                void reconcileListenerProcesses(services);
                // Awaited, not fire-and-forget: "added" must mean the next turn on this endpoint actually routes.
                if (mintsEndpointProvider(input.kind)) {
                    await syncEndpointCompat(services);
                }
                // Folds this entry's image fragments into the overlay; upsert happens first so compose can see them.
                const composedHash = await composeEnvironment(services);
                if (
                    (await capabilityFragments(services, entry)).length > 0 &&
                    composedHash !== undefined &&
                    composedHash !== services.config.sandbox.environmentHash
                ) {
                    yield {
                        kind: "log",
                        message:
                            "This capability extends the sandbox image: a one-time rebuild is needed. Open the Sandbox page's Environment card to rebuild.",
                    };
                }
                yield { kind: "result", ok: true };
            } catch (error) {
                const message = errorMessage(error);
                yield { kind: "error", message };
                throw new ORPCError("INTERNAL_SERVER_ERROR", { message });
            } finally {
                adding.delete(input.id);
            }
        }),
        // Tries the settings without saving them: nothing is written, applied, or claimed, so this stays a pure
        // question. Kept credentials resolve the same way `add` does, for the same reason (the form never saw them).
        probe: i.probe.handler(async ({ input }) => {
            const entry = await withKeptSecrets(services, input);
            return probeCapability(await contributionRegistry(services), entry);
        }),
        // A migration, not a label edit: the id is the agent's handle in its skill file, tool prefix, env var, ssh
        // alias and browser directory; add-and-remove would lose all of it. State moves first, then the manifest, then
        // apply, so a failed apply leaves them agreeing and the Update button retries exactly that step.
        rename: i.rename.handler(async ({ input }) => {
            const capability = await services.capabilities.get(input.id);
            if (capability === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "no capability with that id" });
            }
            if (input.to === capability.id) {
                return { ok: true } as const;
            }
            if ((await services.capabilities.get(input.to)) !== undefined) {
                throw new ORPCError("CONFLICT", { message: `"${input.to}" is already the name of another connection` });
            }
            const handler = registry[capability.kind];
            if (handler.rename.refuse !== undefined) {
                throw new ORPCError("CONFLICT", { message: handler.rename.refuse });
            }
            await handler.rename.carry?.(ctx, capability.id, input.to, capability.config);
            // Parsed, not spread: id is the only field a rename rewrites, and the schema confirms it's still valid.
            const renamed = CapabilitySchema.parse({ ...capability, id: input.to });
            await services.capabilities.upsert(renamed);
            await services.capabilities.remove(capability.id);
            await repointCapabilityReferences(services, ctx, capability.id, input.to);
            if (handler.rename.reapply !== false) {
                for await (const line of handler.apply(ctx, renamed.id, renamed.config)) {
                    void line;
                }
            }
            // Same convergence as `add`: fragments key on entry id, gateways on the capability, translator on endpoint
            // name.
            await composeEnvironment(services);
            void reconcileListenerProcesses(services);
            if (mintsEndpointProvider(renamed.kind)) {
                await syncEndpointCompat(services);
            }
            // The warm ACP subprocess is keyed by the old name; dropping it lets the next turn respawn under the new
            // one.
            if (renamed.kind === "agent") {
                services.acpConnections.drop(capability.id);
            }
            // Loaded under its name, same as an install; the replacement (restart) is what picks up the new one.
            if (renamed.kind === "extension") {
                services.extensionBackend.restart();
            }
            return { ok: true } as const;
        }),
        // Replaces one secret field and re-runs the idempotent apply; no composeEnvironment, since a secret can't
        // change a fragment. Apply runs before upsert, so a failed apply keeps the old secret stored.
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
            // A rotated key is a new upstream credential; the translator keeps the old one until told to sync.
            if (mintsEndpointProvider(updated.kind)) {
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
            // The warm subprocess dies with a removed agent capability; a re-add respawns lazily on the next turn.
            if (capability.kind === "agent") {
                services.acpConnections.drop(capability.id);
            }
            await services.capabilities.remove(input.id);
            // Removed only after the manifest drops it, so the rebuilt list can't put the endpoint straight back.
            if (mintsEndpointProvider(capability.kind)) {
                await syncEndpointCompat(services);
            }
            await composeEnvironment(services);
            void reconcileListenerProcesses(services);
            // A removed extension's backend retires with it; a no-op for other kinds, whose set is unchanged.
            if (capability.kind === "extension") {
                services.extensionBackend.restart();
            }
            return { ok: true } as const;
        }),
        status: i.status.handler(async ({ input }) => {
            const capability = await services.capabilities.get(input.id);
            if (capability === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "no capability with that id" });
            }
            return registry[capability.kind].status(ctx, capability.id, capability.config);
        }),
        // One capability's stored config with secrets included, for an extension backend's credential read. The gate is
        // the identity check: this route serves only callers the bearer middleware never sets `identity` for, and is
        // unreachable from anything that renders.
        connection: i.connection.handler(async ({ input, context }) => {
            if (context.identity !== undefined) {
                throw new ORPCError("FORBIDDEN", { message: "the connection read serves extension backends, never a signed-in browser" });
            }
            const capability = await services.capabilities.get(input.id);
            if (capability === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "no capability with that id" });
            }
            // Only string fields survive; a connection is env-shaped, so a structured value would confuse a header
            // caller.
            const config = Object.fromEntries(Object.entries(capability.config).filter(([, value]) => typeof value === "string")) as Record<
                string,
                string
            >;
            return { id: capability.id, kind: capability.kind, config };
        }),
        marketplace: i.marketplace.handler(async ({ input }) => browseMarketplace(ctx, input.url, input.token)),
        // Re-derives the recommendation here rather than trusting the client, so the dismissal matches what was
        // actually on screen and lapses when the workspace changes.
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
        // Runs loginCommand in the capability's job session via send-keys so the user finishes an interactive sign-in
        // (device code, browser link, pasted token) in the terminal panel; the route returns immediately. The
        // capability's env block is not injected, since inline exports would print secrets into the persisted pane log.
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
                throw new ORPCError("CONFLICT", { message: "no visible terminal in this environment, run the login command manually" });
            }
            const session = capabilityJobSession(input.id);
            const run = promisify(execFile);
            // Attach-or-create keeps prior scrollback; the trailing ":" targets the active pane, a bare `=name`
            // doesn't.
            await run("tmux", ["new-session", "-A", "-d", "-s", session, "-c", services.workspace.root]);
            await run("tmux", ["new-window", "-t", `=${session}:`, "-n", "login", "-c", services.workspace.root]);
            await run("tmux", ["send-keys", "-t", `=${session}:`, "-l", loginCommand]);
            await run("tmux", ["send-keys", "-t", `=${session}:`, "Enter"]);
            return { session };
        }),
        // Mints one TOTP code from the stored seed so the seed itself never crosses the wire; this is the only
        // capability read the per-boot agent token is admitted to. The seed field is whichever one the capability's
        // card marks `totp`.
        otp: i.otp.handler(async ({ input, context, signal }) => {
            const capability = await services.capabilities.get(input.id);
            if (capability === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "no capability with that id" });
            }
            // conversationId comes from the INTENTIC_TURN_OWNER header; absent means a detached shell, refused rather
            // than guessed.
            const verdict = await services.credentialGate.check({
                subject: input.id,
                kind: "capability",
                lane: "otp",
                detail: `a one-time code for ${input.id}`,
                conversationId: context.headers.get("x-intentic-conversation") ?? undefined,
                // Always false: whether anyone is watching is for the gate to discover, not for this route to claim.
                unattended: false,
                signal: signal ?? new AbortController().signal,
            });
            if (!verdict.allow) {
                throw new ORPCError("FORBIDDEN", { message: verdict.reason });
            }
            const contribution = contributionFor(await contributionRegistry(services), capability.kind, capability.config);
            const field = contribution?.spec.fields.find((candidate) => candidate.totp === true);
            const seed = field === undefined ? undefined : (capability.config as Record<string, unknown>)[field.key];
            if (typeof seed !== "string" || seed === "") {
                throw new ORPCError("CONFLICT", { message: `"${input.id}" stores no TOTP secret, add one on its capability card` });
            }
            try {
                return totpCode(seed, Date.now());
            } catch (error) {
                const reason = errorMessage(error);
                throw new ORPCError("CONFLICT", { message: `the stored TOTP secret is unusable (${reason}), re-add it on the capability card` });
            }
        }),
    };
};
