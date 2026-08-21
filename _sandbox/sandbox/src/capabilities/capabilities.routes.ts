import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { type Capability, capabilitiesContract, CapabilitySchema, isVaulted } from "@intentic/sandbox-contract";
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
import { type CapabilityCtx, capabilityCtx } from "./capability.js";
import { echoConfig, secretField } from "./summary.js";
import { secretFieldsOf } from "./secret-fields.js";
import { contributionFor, contributionRegistry } from "./contributions.js";
import { totpCode } from "./totp.js";
import { browseMarketplace } from "./marketplace.js";
import { capabilityRecommendations } from "./recommend.js";
import { registry } from "./registry.js";

/* WHAT ELSE IN THE SANDBOX SPELLS A CONNECTION'S NAME, and therefore what a rename has to follow.
 *
 * Three places, and they are three because a capability id is how one stored thing points at another: an
 * account says which identity's browser it lives in, an identity says which mailbox reads its codes, and a
 * persona card names the accounts it may speak through. Left behind, each becomes a dangling reference that
 * fails quietly and late, an account whose browser has no profile, a persona that has stopped being able to
 * post. The alternative to following them is refusing to rename anything another entry points at, which is a
 * worse answer to "what is this connection called".
 *
 * Deliberately here rather than in the handlers: none of these is a fact about the kind being renamed. A cli
 * connector knows nothing about personas, and it is a persona that has to change when one is renamed. */
const repointCapabilityReferences = async (services: Services, ctx: CapabilityCtx, from: string, to: string): Promise<void> => {
    // Re-parsed rather than spread onto the narrowed type: a manifest entry is a union over sixteen config
    // shapes, and the schema is both what puts the edited entry back on its own arm and what says it is still
    // a valid one.
    const repointed = (entry: Capability, key: "identity" | "mailbox"): Capability =>
        CapabilitySchema.parse({ ...entry, config: { ...entry.config, [key]: to } });
    /* Stored AND re-applied, because a reference is not only in the manifest: an account's skill file tells the
     * agent whose browser it lives in, by name. Re-applying rewrites that sentence, otherwise the manifest
     * would be right and the thing the agent actually reads would still name a connection that no longer
     * exists. Both kinds here are cheap and idempotent to apply (each writes one skill file). */
    const restore = async (entry: Capability, key: "identity" | "mailbox"): Promise<void> => {
        const next = repointed(entry, key);
        await services.capabilities.upsert(next);
        try {
            for await (const line of registry[next.kind].apply(ctx, next.id, next.config)) {
                void line;
            }
        } catch (error) {
            /* Best-effort, and only here: this entry is not the one being renamed. Its apply can fail for
             * reasons that have nothing to do with the rename, the extension declaring its platform was
             * uninstalled, its provider's checkout rotted, and failing the rename over it would leave the
             * connection the user actually asked about half-moved to punish them for an unrelated fault. The
             * reference itself is already saved, which is the part that would otherwise dangle. */
            services.logger.warn(
                `capabilities: renamed "${from}" but could not refresh "${next.id}" (${error instanceof Error ? error.message : String(error)}), re-add it from its card`,
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

/* WHAT AN EDIT SENDS WHERE A CREDENTIAL WOULD GO, resolved back into the credential before anything runs.
 *
 * `add` is the upsert, so it is also how an existing connection is CHANGED, and the browser editing one has
 * never been shown its secrets (the list route echoes the shape of a connection and drops every value in it).
 * Left to send what it holds, a form could only send empty, which the schema either rejects or, worse, accepts
 * as the new value: changing a tunnel's routed networks would erase its pre-shared key. So a field the user did
 * not touch comes back as VAULTED, meaning "whatever is already stored", and that is resolved HERE, before the
 * handler's apply, which writes the real conf files and dials the real gateway.
 *
 * The storage layer already refuses to write the marker over a real value, which covers a caller that reads
 * without rehydrating and writes back. This is the other half: a caller that deliberately says "keep it", whose
 * apply must still see the credential itself.
 *
 * A marker with nothing behind it is a REFUSAL rather than a pass-through. It means the form believed a
 * credential was stored and none is, a fresh add that sent one, an entry removed mid-edit, an id reused for a
 * different kind, and letting it through would write the literal marker into an ssh key file and fail later,
 * somewhere that cannot say which box to go back and fill in. */
const withKeptSecrets = async (services: Services, input: Capability): Promise<Capability> => {
    const config = input.config as Record<string, unknown>;
    const kept = Object.keys(config).filter((key) => isVaulted(config[key]));
    if (kept.length === 0) {
        return input;
    }
    const stored = await services.capabilities.get(input.id);
    // A different kind under the same name is not this connection, its credentials are not the ones being kept.
    const storedConfig = (stored?.kind === input.kind ? stored.config : {}) as Record<string, unknown>;
    const missing = kept.filter((key) => typeof storedConfig[key] !== "string" || isVaulted(storedConfig[key]));
    if (missing.length > 0) {
        throw new ORPCError("BAD_REQUEST", {
            message: `nothing stored for ${missing.join(", ")} on "${input.id}", enter the value rather than keeping it`,
        });
    }
    return CapabilitySchema.parse({ ...input, config: { ...config, ...Object.fromEntries(kept.map((key) => [key, storedConfig[key]])) } });
};

// The unified capability manifest routes. `add` streams its apply (mirroring /intentic): the handler yields
// progress frames, then the manifest entry is recorded, then a terminal `result`. A `requires` precondition
// (service/integration → devops) is checked before apply. `list` fans each handler's status() concurrently.
export const createCapabilitiesRoutes = (services: Services) => {
    const i = implement(capabilitiesContract).$context<OrpcContext>();
    const ctx = capabilityCtx(services);
    // One add per id at a time: a concurrent same-id add would interleave two handler runs in the same visible
    // job session (and race the manifest upsert), reject the second instead.
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
                        // The NAMES of the credentials this entry holds, so an edit form can show dots where it
                        // may not show a value, the complement of the echo above, which is the same rule the
                        // vault splits on (secret-fields.ts).
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
            // Extensions ship code that runs trusted in the browser shell and the agent's turns, installing
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
            // An edit keeps the credentials it was never shown, resolved before apply, and before the id is
            // claimed below, so a form that asked to keep something that isn't there gets a plain refusal
            // rather than an error frame in the middle of a stream.
            const entry = await withKeptSecrets(services, input);
            adding.add(input.id);
            try {
                yield* handler.apply(ctx, entry.id, entry.config);
                await services.capabilities.upsert(entry);
                // A fresh extension checkout brings its declared autoStart processes up (the same post-apply
                // seam composeEnvironment uses, full Services, so the narrow handler ctx stays narrow).
                if (input.kind === "extension") {
                    const installed = (await enabledExtensions(services)).find((extension) => extension.id === input.id);
                    if (installed !== undefined) {
                        await startAutoStartProcesses(services, installed);
                    }
                    // …and its `server` bundle joins the backend host, a restart, because loaded code
                    // cannot be joined by, only replaced with, a process that loads the new set.
                    services.extensionBackend.restart();
                }
                // A connector add/remove flips whether its provider's gateway process is wanted (a cli discord
                // entry is what makes ext-discord run), converge listener extensions on the new manifest.
                void reconcileListenerProcesses(services);
                // An endpoint is only drivable once the translator knows how to reach it, awaited, not fired and
                // forgotten, so the "added" the user reads means the next turn on it will actually route.
                if (input.kind === "endpoint") {
                    await syncEndpointCompat(services);
                }
                // Fold this entry's image fragment(s) into the composed overlay (upsert first, so compose sees it).
                const composedHash = await composeEnvironment(services);
                if (
                    (await capabilityFragments(services, entry)).length > 0 &&
                    composedHash !== undefined &&
                    composedHash !== services.config.sandbox.environmentHash
                ) {
                    yield {
                        kind: "log",
                        message:
                            "This capability extends the sandbox image: a one-time rebuild is needed. Open the Sandbox page's Environment card for the command.",
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
        /* GIVE A CONNECTION A DIFFERENT NAME, a migration, not a label edit.
         *
         * The id is the agent's handle for the thing: its skill file, its tool prefix, the `$VAR_<NAME>` its
         * credential arrives in, the alias `ssh <name>` resolves, the directory its logged-in browser lives in.
         * Add-and-remove would produce the right manifest and lose all of it, signing an account out of every
         * site, un-pairing a computer, re-cloning an extension. So each kind says what its own name keys
         * (capability.ts `rename`): what has to be carried by hand, and whether re-running `apply` is how the
         * derived half gets rewritten.
         *
         * ORDER IS CHOSEN FOR WHAT A FAILURE LEAVES BEHIND. The state moves first, then the manifest follows it,
         * and only then is the new name applied. A failure in the apply therefore leaves manifest and state
         * agreeing on the new name, with a status that says what is wrong and a card whose Update button re-runs
         * exactly the step that failed, where applying first would leave the state under one name and the
         * manifest under the other. */
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
            // Parsed, not spread: the id is the one field of a stored entry this daemon ever rewrites, and the
            // schema is what says the result is still a capability of that kind.
            const renamed = CapabilitySchema.parse({ ...capability, id: input.to });
            await services.capabilities.upsert(renamed);
            await services.capabilities.remove(capability.id);
            await repointCapabilityReferences(services, ctx, capability.id, input.to);
            if (handler.rename.reapply !== false) {
                for await (const line of handler.apply(ctx, renamed.id, renamed.config)) {
                    void line;
                }
            }
            // The same convergence an add runs, for the same reasons, the fragment set is keyed by entry id, a
            // connector's gateway by the capability serving it, the translator by the endpoint's name.
            await composeEnvironment(services);
            void reconcileListenerProcesses(services);
            if (renamed.kind === "endpoint") {
                await syncEndpointCompat(services);
            }
            // The warm ACP subprocess is keyed by the old name; dropping it is what an edit already does, and
            // the next turn respawns it under the new one.
            if (renamed.kind === "agent") {
                services.acpConnections.drop(capability.id);
            }
            // An extension's server bundle is loaded under its name, the same replacement an install performs.
            if (renamed.kind === "extension") {
                services.extensionBackend.restart();
            }
            return { ok: true } as const;
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
            // A rotated endpoint key is a new upstream credential, the translator holds the old one until told.
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
            // A removed extension's backend retires with it (no-op for every other kind, the supervisor
            // re-enumerates and finds the same set).
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
        /* One capability's stored config, secrets included, the extension BACKENDS' credential read (see the
         * contract's note). The identity check is the whole gate: the bearer middleware sets `identity` for
         * every member it verifies, and this route serves precisely the callers it never does, the daemon's
         * own header grants, of which the extension token is the only one that must also DECLARE this route.
         * Secrets echoing as hasToken booleans everywhere else on this surface is unchanged: this route is
         * unreachable from anything that renders. */
        connection: i.connection.handler(async ({ input, context }) => {
            if (context.identity !== undefined) {
                throw new ORPCError("FORBIDDEN", { message: "the connection read serves extension backends, never a signed-in browser" });
            }
            const capability = await services.capabilities.get(input.id);
            if (capability === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "no capability with that id" });
            }
            // Only the string-valued fields: a connection is env-shaped by construction (a cli's url/key pair,
            // a browser platform's urls), and a structured value leaking through would only confuse a caller
            // that expects to put these into headers.
            const config = Object.fromEntries(Object.entries(capability.config).filter(([, value]) => typeof value === "string")) as Record<
                string,
                string
            >;
            return { id: capability.id, kind: capability.kind, config };
        }),
        marketplace: i.marketplace.handler(async ({ input }) => browseMarketplace(ctx, input.url, input.token)),
        // "Not needed", recorded against the evidence the card is CURRENTLY recommended on, re-derived here
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
        // the attached terminal panel, device codes, browser links, pasted tokens all work. Deliberately not
        // terminalRun (a run-to-completion capture): the route returns immediately and the pane IS the UI.
        // The capability's env block is NOT injected, inline exports would print secrets into the persisted
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
                throw new ORPCError("CONFLICT", { message: "no visible terminal in this environment, run the login command manually" });
            }
            const session = capabilityJobSession(input.id);
            const run = promisify(execFile);
            // Attach-or-create keeps any prior job windows' scrollback; the trailing ":" targets the window's
            // active pane (a bare exact-match `=name` never resolves as a pane target, see managed-processes).
            await run("tmux", ["new-session", "-A", "-d", "-s", session, "-c", services.workspace.root]);
            await run("tmux", ["new-window", "-t", `=${session}:`, "-n", "login", "-c", services.workspace.root]);
            await run("tmux", ["send-keys", "-t", `=${session}:`, "-l", loginCommand]);
            await run("tmux", ["send-keys", "-t", `=${session}:`, "Enter"]);
            return { session };
        }),
        // One TOTP code off the capability's stored seed, the `otp` command's whole backend. The seed field is
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
                throw new ORPCError("CONFLICT", { message: `"${input.id}" stores no TOTP secret, add one on its capability card` });
            }
            try {
                return totpCode(seed, Date.now());
            } catch (error) {
                const reason = error instanceof Error ? error.message : String(error);
                throw new ORPCError("CONFLICT", { message: `the stored TOTP secret is unusable (${reason}), re-add it on the capability card` });
            }
        }),
    };
};
