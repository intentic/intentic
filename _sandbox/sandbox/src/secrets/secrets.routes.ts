import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { errorMessage, undefinedIfMissing } from "@intentic/base/errors";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { UnquotableValueError } from "@intentic/sandbox-run/quote";
import { collectSecretInventory, ENV_FILE, SECRETS_FILE } from "@intentic/scaffold";
import { secretField } from "../capabilities/summary.js";
import { lastUseByName, type SecretUse } from "./secret-uses.js";
import { contributionRegistry } from "../capabilities/contributions.js";
import type { CredentialGate, CredentialPolicy, SecretInventoryEntry } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import { authorizeMaintainer, bearerFrom, type Caller, ForbiddenError } from "../auth/auth.js";
import { roleAtLeast, secretsContract } from "@intentic/sandbox-contract";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../app-env.js";
import { stateRelPath } from "../state-paths.js";
import { envKeys, removeEnv, upsertEnv } from "./env-text.js";
import { sandboxSecretsDocument } from "./sandbox-secrets.js";
import { randomSecret } from "./random-secret.js";
import { guardForEntry } from "./host-guards.js";
import { createSecretHostRoutes } from "./secret-hosts.routes.js";
import { createCredentialPolicyRoutes, credentialPolicies } from "../capabilities/broker/broker-policy.routes.js";
import { type TextFile, textFile } from "../store/text-file.js";

// The whole `Services`, not a Pick: the inventory hands `services` on to every provider module's secretEntries, and a
// Pick would go stale with each module edit.
export type SecretsRoutesDeps = Services;

// The newest ledger row for one entry: env/generated match by exact name; a capability entry is one row for a vault
// with several fields, so any field's use counts.
const lastUseFor = (entry: Pick<SecretInventoryEntry, "key" | "kind">, lastByName: ReadonlyMap<string, SecretUse>): SecretUse | undefined => {
    if (entry.kind === "provider") {
        return undefined;
    }
    if (entry.kind !== "capability") {
        return lastByName.get(entry.key);
    }
    let newest: SecretUse | undefined;
    for (const [name, use] of lastByName) {
        if (name.startsWith(`${entry.key}/`) && (newest === undefined || use.at > newest.at)) {
            newest = use;
        }
    }
    return newest;
};

// User-supplied secrets go to desired-state/.env (mode 0600) once DevOps has scaffolded that repo, and to the sandbox's
// own store (sandbox-secrets.ts) before it; reveal reads both, and inventory always answers. Every set/remove fires a best-effort `deploy secrets push` for the CI
// copy. `providerAccounts` answers every provider's connected-account rows, which the router reads from the provider
// modules themselves.
export const createSecretsRoutes = (services: SecretsRoutesDeps, providerAccounts: () => Promise<readonly SecretInventoryEntry[]>) => {
    const i = implement(secretsContract).$context<OrpcContext>();
    const desiredState = (): string => services.workspace.repos["desired-state"];
    const envPath = (): string => join(desiredState(), ENV_FILE);
    // Resolved per call rather than once: the desired-state repo isn't scaffolded when these routes are built.
    const envFile = (): TextFile => textFile(envPath(), 0o600);
    const read = async (): Promise<string> => await envFile().read();
    const devopsActive = (): boolean => existsSync(desiredState());
    // `envLine` cannot express a value holding all three quote characters; refused as a bad request naming the value,
    // since a raw throw here reads as a server fault the user cannot act on.
    const writeEnv = async (change: (current: string) => string): Promise<void> => {
        try {
            await envFile().update(change);
        } catch (error) {
            if (error instanceof UnquotableValueError) {
                throw new ORPCError("BAD_REQUEST", { message: error.message });
            }
            throw error;
        }
    };
    const ensureMaintainer = async (headers: Headers): Promise<void> => {
        if (services.auth === undefined) {
            return;
        }
        try {
            await authorizeMaintainer(services.auth, bearerFrom(headers.get("authorization") ?? undefined));
        } catch (error) {
            if (error instanceof ForbiddenError) {
                throw new ORPCError("FORBIDDEN", { message: error.message });
            }
            throw new ORPCError("UNAUTHORIZED");
        }
    };
    // Owner-only, in-route rather than by the route's maintainer floor: a maintainer is exactly who a gate may be
    // written about, and letting that tier edit the policy would let it lift its own constraint.
    const ensureOwner = async (headers: Headers): Promise<void> => {
        if (services.auth === undefined) {
            return;
        }
        try {
            await services.auth.authorizeOwner(bearerFrom(headers.get("authorization") ?? undefined));
        } catch (error) {
            if (error instanceof ForbiddenError) {
                throw new ORPCError("FORBIDDEN", { message: error.message });
            }
            throw new ORPCError("UNAUTHORIZED");
        }
    };
    // Whether this caller may see a value in the clear: reveal is the operating tier's (ensureMaintainer), and a gated
    // credential is held to its approvers there as at every other release, since a maintainer is exactly who a gate may
    // be written about. A loopback daemon has one person, who answers for everything.
    const mayReveal = (identity: Caller | undefined, gate: CredentialGate | undefined): boolean => {
        if (services.auth === undefined) {
            return true;
        }
        if (identity === undefined || !roleAtLeast(identity.role, "maintainer")) {
            return false;
        }
        return gate === undefined || gate.approvers.some((approver) => approver.toLowerCase() === identity.email.toLowerCase());
    };
    const refuseUnlessReleasable = async (identity: Caller | undefined, kind: CredentialGate["kind"], subject: string): Promise<void> => {
        const gate = (await services.credentialGates.list()).find((entry) => entry.kind === kind && entry.subject === subject);
        if (!mayReveal(identity, gate)) {
            throw new ORPCError("FORBIDDEN", { message: `Only ${gate?.approvers.join(", ") ?? "an approver"} can see "${subject}": it is gated.` });
        }
    };
    // Everybody who could be named an approver: the owner plus the Access roster, less its guests, who never see a gate
    // and so could never release one. Checked against, so a typo'd address cannot produce a credential nobody can ever
    // release.
    const releasableBy = async (): Promise<readonly string[]> => {
        const [owner, members] = await Promise.all([services.ownerEmail(), services.members.list()]);
        return [...(owner !== undefined ? [owner.toLowerCase()] : []), ...members.filter((member) => member.role !== "guest").map((member) => member.email.toLowerCase())];
    };
    // Refuses a gate naming somebody off the roster; compared lowercased since roster writes normalize case but a
    // Google claim may not.
    const guardApprovers = async (approvers: readonly string[]): Promise<void> => {
        const allowed = await releasableBy();
        const strangers = approvers.filter((approver) => !allowed.includes(approver.toLowerCase()));
        if (strangers.length > 0) {
            throw new ORPCError("BAD_REQUEST", {
                message: `not on this sandbox's access roster: ${strangers.join(", ")}. Give them access first, or a credential would be gated to somebody who can never release it.`,
            });
        }
    };
    const pushToCi = (): void => {
        void (async () => {
            for await (const line of services.intentic({ args: ["deploy", "secrets", "push"], cwd: services.workspace.root })) {
                void line;
            }
        })().catch((error: unknown) => services.logger.warn({ err: error }, "secrets push after set failed"));
    };
    return {
        // Where each secret may be sent: its own module, since who may change a list turns on more than a role.
        ...createSecretHostRoutes(services),
        // How each connection's credential reaches the agent and what it may do there (broker/broker-policy.routes.ts).
        ...createCredentialPolicyRoutes(services),
        // With DevOps, into desired-state/.env, which deploys and the CI copy read; without it, into the sandbox's own
        // store (sandbox-secrets.ts), so keeping a key for the agent never needs a deploy pipeline scaffolded first.
        set: i.set.handler(async ({ input }) => {
            if (devopsActive()) {
                await writeEnv((current) => upsertEnv(current, input.key, input.value));
                pushToCi();
            } else {
                await services.sandboxSecrets.set(input.key, input.value);
            }
            return { ok: true } as const;
        }),
        // A secret nobody has to find: made here, kept where `set` keeps one, and only its name and length answered. A
        // name any store already holds is refused, since a new value would break whatever reads the old one.
        generate: i.generate.handler(async ({ input }) => {
            if ((await services.secretRegistry()).some((secret) => secret.name === input.key)) {
                throw new ORPCError("CONFLICT", {
                    message: `"${input.key}" is already stored: use it as it is, or pick a name nothing here holds. A new value would break whatever reads the old one.`,
                });
            }
            const value = randomSecret(input.bytes, input.format);
            const devops = devopsActive();
            if (devops) {
                await writeEnv((current) => upsertEnv(current, input.key, value));
                pushToCi();
            } else {
                await services.sandboxSecrets.set(input.key, value);
            }
            return { key: input.key, length: value.length, stored: devops ? ("env" as const) : ("sandbox" as const) };
        }),
        list: i.list.handler(async () => {
            const kept = Object.keys(await services.sandboxSecrets.all());
            const env = devopsActive() ? envKeys(await read()) : [];
            return { keys: [...new Set([...env, ...kept])] };
        }),
        remove: i.remove.handler(async ({ input }) => {
            const kept = await services.sandboxSecrets.remove(input.key);
            if (devopsActive()) {
                await writeEnv((current) => removeEnv(current, input.key));
                pushToCi();
            } else if (!kept) {
                throw new ORPCError("NOT_FOUND", { message: `no secret named "${input.key}"` });
            }
            return { ok: true } as const;
        }),
        inventory: i.inventory.handler(async ({ context }) => {
            const [repoEntries, capabilities, connectors, providerEntries, uses, gates, kept, hostGuards, policies] = await Promise.all([
                // A display surface: one unparseable repo file costs its own rows, said in the log, not the whole panel.
                existsSync(desiredState())
                    ? collectSecretInventory(desiredState()).catch((error: unknown) => {
                          services.logger.warn({ err: error }, "secrets inventory: the desired-state repo's secret files could not be read");
                          return [];
                      })
                    : [],
                services.capabilities.list(),
                contributionRegistry(services),
                // Every provider's connected-account rows, from the modules themselves, not hand-kept here.
                providerAccounts(),
                services.secretUses.all().catch(() => [] as const),
                // The approval policy, joined below; unreadable reads as no gates here, since this is a display
                // surface.
                services.credentialGates.list().catch(() => [] as const),
                // A display surface like the rest: an unreadable store costs its rows, said in the log.
                services.sandboxSecrets.all().catch((error: unknown) => {
                    services.logger.warn({ err: error }, "secrets inventory: the sandbox's own secret store could not be read");
                    return {};
                }),
                // Display only, like the gates: an unreadable file shows no guards here, while every exit still refuses.
                services.hostGuards().catch(() => [] as const),
                // How each connection's credential reaches the agent; display only, the gateway reads its own.
                credentialPolicies(services, services.credentialPolicy).catch((): ReadonlyMap<string, CredentialPolicy> => new Map()),
            ]);
            const capabilityEntries: SecretInventoryEntry[] = capabilities
                .filter((capability) => secretField(capability, connectors) !== undefined)
                .map((capability) => ({
                    key: capability.id,
                    kind: "capability",
                    status: "connected",
                    requiredBy: [],
                    // The vault, not the manifest: the manifest never holds the value, which lives beside the provider
                    // logins.
                    storedAt: stateRelPath(".intentic/secrets/auth/", "capability-secrets.json"),
                    revealable: true,
                }));
            // Joins the ledger's newest row per entry, so inventory alone answers when the agent last spent it.
            const lastByName = lastUseByName(uses);
            // The gate for one entry, by the exits' own subject rule: env/generated rows are a secret subject,
            // capability rows a capability subject; a provider account has neither.
            const gateFor = (entry: Pick<SecretInventoryEntry, "key" | "kind">): CredentialGate | undefined => {
                if (entry.kind === "provider") {
                    return undefined;
                }
                const wanted = entry.kind === "capability" ? "capability" : "secret";
                return gates.find((gate) => gate.kind === wanted && gate.subject === entry.key);
            };
            const withUse = (entry: SecretInventoryEntry): SecretInventoryEntry => {
                const use = lastUseFor(entry, lastByName);
                const gate = gateFor(entry);
                const hostGuard = guardForEntry(hostGuards, entry);
                const withHosts =
                    hostGuard === undefined ? entry : { ...entry, hosts: { guard: hostGuard.guard, list: hostGuard.hosts, source: hostGuard.source } };
                const withGate = gate === undefined ? withHosts : { ...withHosts, gate: { approvers: gate.approvers, scope: gate.scope } };
                const policy = entry.kind === "capability" ? policies.get(entry.key) : undefined;
                const withPolicy =
                    policy === undefined ? withGate : { ...withGate, credential: { delivery: policy.delivery, rules: policy.rules, rulesFrom: policy.rulesFrom } };
                // Revealable says what this caller's Reveal would get: a gated row is only its approvers'.
                const readable = withPolicy.revealable && !mayReveal(context.identity, gate) ? { ...withPolicy, revealable: false } : withPolicy;
                return use === undefined
                    ? readable
                    : {
                          ...readable,
                          lastUse: {
                              at: use.at,
                              lane: use.lane,
                              ...(use.detail !== undefined ? { detail: use.detail } : {}),
                              ...(use.approvedBy !== undefined ? { approvedBy: use.approvedBy } : {}),
                          },
                      };
            };
            // Kept without DevOps: a person's own, like the .env's rows, one row per name the .env does not already hold.
            const repoKeys = new Set(repoEntries.map((entry) => entry.key));
            const keptEntries: SecretInventoryEntry[] = Object.keys(kept)
                .filter((key) => !repoKeys.has(key))
                .map((key) => ({
                    key,
                    kind: "env",
                    status: "set",
                    requiredBy: [],
                    storedAt: stateRelPath(".intentic/secrets/auth/", sandboxSecretsDocument.path),
                    revealable: true,
                }));
            return { entries: [...repoEntries, ...keptEntries, ...capabilityEntries, ...providerEntries].map(withUse) };
        }),
        reveal: i.reveal.handler(async ({ input, context }) => {
            await ensureMaintainer(context.headers);
            // Capability credentials first (key = capability id): they exist whether or not DevOps is active.
            const capability = await services.capabilities.get(input.key);
            if (capability !== undefined) {
                const field = secretField(capability, await contributionRegistry(services));
                const value = field === undefined ? undefined : (capability.config as Record<string, string>)[field];
                if (value !== undefined) {
                    await refuseUnlessReleasable(context.identity, "capability", input.key);
                    return { value };
                }
            }
            // Every other store answers to a secret of this name.
            await refuseUnlessReleasable(context.identity, "secret", input.key);
            const keptValue = await services.sandboxSecrets.get(input.key);
            if (keptValue !== undefined) {
                return { value: keptValue };
            }
            if (!devopsActive()) {
                throw new ORPCError("NOT_FOUND", { message: `no secret named "${input.key}"` });
            }
            const envValue = parseEnv(await read())[input.key];
            if (typeof envValue === "string") {
                return { value: envValue };
            }
            // Only absence is "no generated secrets": an unreadable file must not answer NOT_FOUND for a secret it holds.
            const generatedRaw = (await readFile(join(desiredState(), SECRETS_FILE), "utf8").catch(undefinedIfMissing)) ?? "{}";
            const generatedValue = (JSON.parse(generatedRaw) as Record<string, unknown>)[input.key];
            if (typeof generatedValue === "string") {
                return { value: generatedValue };
            }
            throw new ORPCError("NOT_FOUND", { message: `no secret named "${input.key}"` });
        }),
        // Subjects and approvers only, never a value; the agent's own token can reach this so it can tell "not
        // connected" from "needs Bob". Unreadable is an error here, not an empty list, unlike the inventory join.
        gates: i.gates.handler(async () => {
            try {
                return { gates: [...(await services.credentialGates.list())] };
            } catch (error) {
                throw new ORPCError("INTERNAL_SERVER_ERROR", {
                    message: error instanceof Error ? error.message : "the credential gate policy could not be read",
                });
            }
        }),
        setGate: i.setGate.handler(async ({ input, context }) => {
            await ensureOwner(context.headers);
            // Checked against the registry or capability manifest: a name nothing answers to never fires.
            if (input.kind === "capability") {
                const capability = await services.capabilities.get(input.subject);
                if (capability === undefined) {
                    throw new ORPCError("NOT_FOUND", { message: `nothing is connected under the id "${input.subject}"` });
                }
                // Browser, identity and mcp mount for a turn, so the route forces `conversation` scope, not the
                // input's.
                const forced = capability.kind === "browser" || capability.kind === "identity" || capability.kind === "mcp";
                const gate = { ...input, ...(forced ? { scope: "conversation" as const } : {}) };
                await guardApprovers(gate.approvers);
                await services.credentialGates.set(gate);
                return { ok: true } as const;
            }
            const registry = await services.secretRegistry();
            if (!registry.some((secret) => secret.name === input.subject)) {
                throw new ORPCError("NOT_FOUND", { message: `no stored secret named "${input.subject}"` });
            }
            await guardApprovers(input.approvers);
            await services.credentialGates.set(input);
            return { ok: true } as const;
        }),
        removeGate: i.removeGate.handler(async ({ input, context }) => {
            await ensureOwner(context.headers);
            await services.credentialGates.remove(input.subject);
            return { ok: true } as const;
        }),
        // The agent's door to ask for a gated capability: absent, not refused, so there is nothing to trip over and
        // learn from otherwise. Parks until an approver clicks, which is why the CLI holds its connection open with no
        // timeout.
        request: i.request.handler(async ({ input, context, signal }) => {
            const gate = await services.credentialGates.list().then(
                (gates) => gates.find((entry) => entry.subject === input.subject),
                (error: unknown) => {
                    throw new ORPCError("INTERNAL_SERVER_ERROR", { message: errorMessage(error), cause: error });
                },
            );
            if (gate === undefined) {
                throw new ORPCError("NOT_FOUND", {
                    message: `"${input.subject}" is not behind an approver, so there is nothing to ask for. If it exists it is already yours to use; if a tool says otherwise, the reason is something else.`,
                });
            }
            // A per-use gate is asked at the use, not here: `use` scope records no grant, so an advance card is wasted.
            if (gate.scope === "use") {
                throw new ORPCError("BAD_REQUEST", {
                    message:
                        `"${gate.subject}" is released one use at a time, so there is nothing to ask for in advance: ` +
                        `write the credential's reference into the command you actually want to run, and the approval card goes up for that one use.`,
                });
            }
            const verdict = await services.credentialGate.check({
                subject: gate.subject,
                kind: gate.kind,
                lane: "session",
                detail: gate.subject,
                ...(input.why !== undefined && input.why !== "" ? { why: input.why } : {}),
                // Body field first, else the header every agent CLI sends; the gate re-derives the live conversation
                // anyway.
                conversationId: input.conversationId ?? context.headers.get("x-intentic-conversation") ?? undefined,
                signal: signal ?? new AbortController().signal,
            });
            if (!verdict.allow) {
                throw new ORPCError("FORBIDDEN", { message: verdict.reason });
            }
            return {
                granted: true as const,
                approvedBy: verdict.approvedBy ?? "",
                message:
                    `Released for the rest of this conversation by ${verdict.approvedBy ?? "an approver"}. ` +
                    `A connected account is mounted from the NEXT turn, so finish this turn and ask the user to continue; ` +
                    `a \`cli\` connector you can use right now by writing its credential reference in a command.`,
            };
        }),
    };
};
