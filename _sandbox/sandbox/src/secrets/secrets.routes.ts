import { noteAudit } from "../audit/audit-http.js";
import { errorMessage } from "@intentic/base/errors";
import { secretField } from "../capabilities/summary.js";
import { lastUseByName, type SecretUse } from "./secret-uses.js";
import { contributionRegistry } from "../capabilities/contributions.js";
import type { CredentialGate, CredentialPolicy, SecretInventoryEntry, SecretProgramGuard } from "@intentic/sandbox-contract/schemas/secrets";
import { implement, ORPCError } from "@orpc/server";
import type { Caller } from "../auth/auth.js";
import { holdsRight } from "@intentic/sandbox-contract/schemas/members";
import { ensureRight } from "../auth/owner-gates.js";
import { secretsContract } from "@intentic/sandbox-contract/contracts/secrets.contract";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../app-env.js";
import { stateRelPath } from "../state-paths.js";
import { sandboxSecretsDocument } from "./sandbox-secrets.js";
import { unmaskableSecrets } from "../agent/tools/agent-redaction.js";
import { guardForEntry } from "./guards/host-guards.js";
import { createSecretGenerateRoutes } from "./generate/secret-generate.routes.js";
import { createSecretHostRoutes } from "./guards/secret-hosts.routes.js";
import { createSecretProgramRoutes } from "./guards/secret-programs.routes.js";
import { createDeviceSecretRoutes } from "./device/device-secrets.routes.js";
import { deviceInventoryEntry } from "./device/device-secrets.js";
import type { DevicePointer } from "./device/keyring-link.js";
import { createCredentialPolicyRoutes, credentialPolicies } from "../capabilities/broker/broker-policy.routes.js";

// The whole `Services`, not a Pick: the inventory hands `services` on to every provider module's secretEntries, and a
// Pick would go stale with each module edit.
export type SecretsRoutesDeps = Services;

// The newest ledger row for one entry: env matches by exact name; a capability entry is one row for a vault
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

// A name nothing here holds, and the computer whose keyring holds it, if one does.
const keptOnDevice = async (services: Pick<SecretsRoutesDeps, "deviceSecrets">, key: string): Promise<string | undefined> =>
    // allow(silent-catch): an unreadable list of keyring entries only loses the hint of where the name lives; it is not found here either way.
    (await services.deviceSecrets.listed().catch(() => [])).find((entry) => entry.pointer.name === key)?.machine;

// Refused with where it lives when a computer's keyring holds it, since there is no value in this sandbox to show.
const notFound = async (services: Pick<SecretsRoutesDeps, "deviceSecrets">, key: string): Promise<ORPCError<string, unknown>> => {
    const machine = await keptOnDevice(services, key);
    return machine === undefined
        ? new ORPCError("NOT_FOUND", { message: `no secret named "${key}"` })
        : new ORPCError("FORBIDDEN", {
              message: `"${key}" is kept in the keyring on ${machine}: this sandbox holds only a pointer to it, so there is no value here to show. See it on that computer: intentic-machine keyring list.`,
          });
};

// A display surface, like the rest of the inventory: keyrings that cannot be listed cost their rows, said in the log.
const deviceRowsOf = async (services: Pick<SecretsRoutesDeps, "deviceSecrets" | "logger">): Promise<readonly DevicePointer[]> =>
    services.deviceSecrets.listed().catch((error: Error) => {
        services.logger.warn({ err: error }, "secrets inventory: the keyrings' entries could not be listed");
        return [];
    });

// The values a row holds that are under the masking floor: its own name, or a connection's `<id>/<field>` names.
// Display only, like the rest of the inventory: an unreadable store shows no warnings, while masking fails closed.
const flagTooShort = async (services: Pick<SecretsRoutesDeps, "secretRegistry">, entries: SecretInventoryEntry[]): Promise<SecretInventoryEntry[]> => {
    const unmaskable = await services.secretRegistry().then(unmaskableSecrets, (): readonly string[] => []);
    return entries.map((entry) => {
        const names = unmaskable.filter((name) => name === entry.key || name.startsWith(`${entry.key}/`));
        return names.length === 0 ? entry : { ...entry, tooShort: names };
    });
};

// A sandbox-held secret's program guard, where the owner set one; a keyring's row carries its keyring's own list.
const withPrograms = (entries: readonly SecretInventoryEntry[], guards: readonly SecretProgramGuard[]): SecretInventoryEntry[] =>
    entries.map((entry) => {
        const guard = entry.kind === "env" ? guards.find((candidate) => candidate.subject === entry.key) : undefined;
        return guard === undefined ? entry : { ...entry, programs: { programs: guard.programs, packages: guard.packages, anyField: guard.anyField, source: "owner" } };
    });

// User-supplied secrets go to the sandbox's own store (sandbox-secrets.ts); reveal reads it, and inventory always
// answers. `providerAccounts` answers every provider's connected-account rows, which the router reads from the provider
// modules themselves.
export const createSecretsRoutes = (services: SecretsRoutesDeps, providerAccounts: () => Promise<readonly SecretInventoryEntry[]>) => {
    const i = implement(secretsContract).$context<OrpcContext>();
    // Whether this caller may see a value in the clear: reveal is for whoever runs secrets (the owner, Full access, or a
    // member given Secrets), and a gated credential is held to its approvers there as at every other release. A loopback
    // daemon has one person, who answers for everything.
    const mayReveal = (identity: Caller | undefined, gate: CredentialGate | undefined): boolean => {
        if (services.auth === undefined) {
            return true;
        }
        if (identity === undefined || !holdsRight(identity, "secrets")) {
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
    return {
        // Where each secret may be sent: its own module, since who may change a list turns on more than a role.
        ...createSecretHostRoutes(services),
        // Which programs each may be typed into, the host guard's counterpart for windows (secret-programs.routes.ts).
        ...createSecretProgramRoutes(services),
        // The owner's own doors to the keyrings on their computers: Type into…, the keyrings, and pairing two of them.
        ...createDeviceSecretRoutes(services),
        // How each connection's credential reaches the agent and what it may do there (broker/broker-policy.routes.ts).
        ...createCredentialPolicyRoutes(services),
        set: i.set.handler(async ({ input }) => {
            noteAudit({ target: input.key });
            await services.sandboxSecrets.set(input.key, input.value);
            return { ok: true } as const;
        }),
        // Making a random value, new or in place of one a person set (secret-generate.routes.ts).
        ...createSecretGenerateRoutes(services, (key) => keptOnDevice(services, key)),
        list: i.list.handler(async () => ({ keys: Object.keys(await services.sandboxSecrets.all()) })),
        remove: i.remove.handler(async ({ input }) => {
            if (!(await services.sandboxSecrets.remove(input.key))) {
                throw new ORPCError("NOT_FOUND", { message: `no secret named "${input.key}"` });
            }
            return { ok: true } as const;
        }),
        inventory: i.inventory.handler(async ({ context }) => {
            const [capabilities, connectors, providerEntries, uses, gates, kept, hostGuards, policies, onDevices, programGuards] = await Promise.all([
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
                // What the keyrings on the owner's computers share here, from memory; an offline computer's rows stay.
                deviceRowsOf(services),
                // Display only, like the host guards: an unreadable file shows no lists, while every typing still asks.
                services.secretProgramGuards.list().catch(() => [] as const),
            ]);
            const capabilityEntries: SecretInventoryEntry[] = capabilities
                .filter((capability) => secretField(capability, connectors) !== undefined)
                .map((capability) => ({
                    key: capability.id,
                    kind: "capability",
                    status: "connected",
                    // The vault, not the manifest: the manifest never holds the value, which lives beside the provider
                    // logins.
                    storedAt: stateRelPath(".intentic/secrets/auth/", "capability-secrets.json"),
                    revealable: true,
                }));
            // Joins the ledger's newest row per entry, so inventory alone answers when the agent last spent it.
            const lastByName = lastUseByName(uses);
            // The gate for one entry, by the exits' own subject rule: env rows are a secret subject,
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
            // A person's own, set here or generated.
            const keptEntries: SecretInventoryEntry[] = Object.keys(kept).map((key) => ({
                key,
                kind: "env",
                status: "set",
                storedAt: stateRelPath(".intentic/secrets/auth/", sandboxSecretsDocument.path),
                revealable: true,
            }));
            const ownRows = [...keptEntries, ...capabilityEntries, ...providerEntries];
            // One row per key: a name a row above already lists is the sandbox's, whatever a keyring shares under it.
            const listedKeys = new Set(ownRows.map((entry) => entry.key));
            const deviceRows = onDevices.filter((entry) => !listedKeys.has(entry.pointer.name)).map(deviceInventoryEntry);
            return { entries: await flagTooShort(services, [...withPrograms(ownRows, programGuards), ...deviceRows].map(withUse)) };
        }),
        reveal: i.reveal.handler(async ({ input, context }) => {
            noteAudit({ target: input.key });
            await ensureRight(services, context.headers, "secrets");
            // Capability credentials first (key = capability id).
            const capability = await services.capabilities.get(input.key);
            if (capability !== undefined) {
                const field = secretField(capability, await contributionRegistry(services));
                const value = field === undefined ? undefined : (capability.config as Record<string, string>)[field];
                if (value !== undefined) {
                    await refuseUnlessReleasable(context.identity, "capability", input.key);
                    return { value };
                }
            }
            // The sandbox's own store answers to a secret of this name.
            await refuseUnlessReleasable(context.identity, "secret", input.key);
            const keptValue = await services.sandboxSecrets.get(input.key);
            if (keptValue !== undefined) {
                return { value: keptValue };
            }
            throw await notFound(services, input.key);
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
        // A person's own request only, in-route as well as by the route's floor: the owner, Full access, or a member given
        // Secrets. Never a machine credential, which a gate may hold back, so it could otherwise lift its own constraint.
        setGate: i.setGate.handler(async ({ input, context }) => {
            await ensureRight(services, context.headers, "secrets");
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
            // A keyring's entry is gated like a stored secret: the gate runs before its computer is ever asked.
            const registry = await services.secretRegistry();
            if (!registry.some((secret) => secret.name === input.subject) && (await keptOnDevice(services, input.subject)) === undefined) {
                throw new ORPCError("NOT_FOUND", { message: `no stored secret named "${input.subject}"` });
            }
            await guardApprovers(input.approvers);
            await services.credentialGates.set(input);
            return { ok: true } as const;
        }),
        removeGate: i.removeGate.handler(async ({ input, context }) => {
            await ensureRight(services, context.headers, "secrets");
            await services.credentialGates.remove(input.subject);
            return { ok: true } as const;
        }),
        // The agent's door to ask for a gated capability: absent, not refused, so there is nothing to trip over and
        // learn from otherwise. Parks until an approver clicks, which is why the CLI holds its connection open with no
        // timeout.
        request: i.request.handler(async ({ input, context, signal }) => {
            const gate = await services.credentialGates.list().then(
                (gates) => gates.find((entry) => entry.subject === input.subject),
                (error: Error) => {
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
