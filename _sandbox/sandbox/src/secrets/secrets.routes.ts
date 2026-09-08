import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseEnv } from "node:util";
import { envLine } from "@intentic/sandbox-run/quote";
import { collectSecretInventory, ENV_FILE, SECRETS_FILE } from "@intentic/scaffold";
import { secretField } from "../capabilities/summary.js";
import { lastUseByName, type SecretUse } from "./secret-uses.js";
import { contributionRegistry } from "../capabilities/contributions.js";
import type { CredentialGate, SecretInventoryEntry } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import { authorizeMaintainer, bearerFrom, ForbiddenError } from "../auth/auth.js";
import { secretsContract } from "@intentic/sandbox-contract";
import { providerSecretEntries } from "../agent/providers/provider-registry.js";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../app-env.js";
import { stateRelPath } from "../workspace/layout/state-paths.js";

// One connected provider account as an inventory entry; provider tokens are never revealable.
// Upserts by parsing and re-serializing via `envLine`, not string interpolation, so a value containing a quote or
// newline (an SSH key) cannot break out of its line or inject a second key.
export const upsertEnv = (content: string, key: string, value: string): string => {
    // parseEnv answers a Dict of string values; a missing key reads as undefined.
    const entries = { ...(parseEnv(content) as Record<string, string>), [key]: value };
    return Object.entries(entries)
        .map(([entryKey, entryValue]) => envLine(entryKey, entryValue))
        .join("");
};

// Drops KEY from a .env's text (same parse/re-serialize round-trip as upsertEnv).
export const removeEnv = (content: string, key: string): string => {
    const entries = parseEnv(content) as Record<string, string>;
    delete entries[key];
    return Object.entries(entries)
        .map(([entryKey, entryValue]) => envLine(entryKey, entryValue))
        .join("");
};

// The keys present in a .env's text (for the UI's set badges), never the values.
export const envKeys = (content: string): string[] => Object.keys(parseEnv(content));

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

// User-supplied secrets go to desired-state/.env (mode 0600); set/remove/list/reveal refuse until DevOps has scaffolded
// that repo, though inventory always answers. Every set/remove fires a best-effort `deploy secrets push` for the CI
// copy.
export const createSecretsRoutes = (services: SecretsRoutesDeps) => {
    const i = implement(secretsContract).$context<OrpcContext>();
    const desiredState = (): string => services.workspace.repos["desired-state"];
    const envPath = (): string => join(desiredState(), ENV_FILE);
    const ensureActive = (): void => {
        if (!existsSync(desiredState())) {
            throw new ORPCError("PRECONDITION_FAILED", { message: "DevOps is not active, activate it before adding secrets." });
        }
    };
    const read = async (): Promise<string> => {
        try {
            return await readFile(envPath(), "utf8");
        } catch {
            return "";
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
    // Everybody who could be named an approver: the owner plus the Access roster. Checked against, so a typo'd address
    // cannot produce a credential nobody can ever release.
    const releasableBy = async (): Promise<readonly string[]> => {
        const [owner, members] = await Promise.all([services.ownerEmail(), services.members.list()]);
        return [...(owner !== undefined ? [owner.toLowerCase()] : []), ...members.map((member) => member.email.toLowerCase())];
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
        set: i.set.handler(async ({ input }) => {
            ensureActive();
            const path = envPath();
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, upsertEnv(await read(), input.key, input.value), { mode: 0o600 });
            pushToCi();
            return { ok: true } as const;
        }),
        list: i.list.handler(async () => {
            ensureActive();
            return { keys: envKeys(await read()) };
        }),
        remove: i.remove.handler(async ({ input }) => {
            ensureActive();
            await writeFile(envPath(), removeEnv(await read(), input.key), { mode: 0o600 });
            pushToCi();
            return { ok: true } as const;
        }),
        inventory: i.inventory.handler(async () => {
            const [repoEntries, capabilities, connectors, providerEntries, uses, gates] = await Promise.all([
                existsSync(desiredState()) ? collectSecretInventory(desiredState()) : [],
                services.capabilities.list(),
                contributionRegistry(services),
                // Every provider's connected-account rows, from the modules themselves, not hand-kept here.
                providerSecretEntries(services),
                services.secretUses.all().catch(() => [] as const),
                // The approval policy, joined below; unreadable reads as no gates here, since this is a display
                // surface.
                services.credentialGates.list().catch(() => [] as const),
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
                const withGate = gate === undefined ? entry : { ...entry, gate: { approvers: gate.approvers, scope: gate.scope } };
                return use === undefined
                    ? withGate
                    : {
                          ...withGate,
                          lastUse: {
                              at: use.at,
                              lane: use.lane,
                              ...(use.detail !== undefined ? { detail: use.detail } : {}),
                              ...(use.approvedBy !== undefined ? { approvedBy: use.approvedBy } : {}),
                          },
                      };
            };
            return { entries: [...repoEntries, ...capabilityEntries, ...providerEntries].map(withUse) };
        }),
        reveal: i.reveal.handler(async ({ input, context }) => {
            await ensureMaintainer(context.headers);
            // Capability credentials first (key = capability id): they exist pre-scaffold, before ensureActive.
            const capability = await services.capabilities.get(input.key);
            if (capability !== undefined) {
                const field = secretField(capability, await contributionRegistry(services));
                const value = field === undefined ? undefined : (capability.config as Record<string, string>)[field];
                if (value !== undefined) {
                    return { value };
                }
            }
            ensureActive();
            const envValue = parseEnv(await read())[input.key];
            if (typeof envValue === "string") {
                return { value: envValue };
            }
            const generatedRaw = await readFile(join(desiredState(), SECRETS_FILE), "utf8").catch(() => "{}");
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
                () => {
                    throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "the credential gate policy could not be read" });
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
                // Arrives only from a turn's shell; an unattended shell stays unattended, so the gate refuses, not
                // parks.
                unattended: false,
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
