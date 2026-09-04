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
import { providerSecretEntries } from "../agent/provider-registry.js";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import { stateRelPath } from "../workspace/state-paths.js";

// One connected provider account as an inventory entry (never a value, provider tokens are not revealable).
/* Upsert KEY=value into a .env's text. Parsed and re-serialized with Node's own env parser (the same one the
 * CLI loads the file with), so multi-line secrets (SSH private keys) survive the round-trip. The file is
 * machine-managed (only the daemon writes it), so re-serializing is lossless.
 *
 * Serialization is envLine's, not this file's. Hardcoding `KEY="${value}"` here made the VALUE able to end its
 * own line: parseEnv has no escape inside a quoted value, so a secret containing a double quote was stored
 * truncated at it, and one containing `"` followed by a newline and `OTHER=…` added a second key to a file
 * that feeds the deploy engine and is pushed to CI below. The value on this route is typed into the browser by
 * whoever holds a session, which is the whole distance from "unlikely input" to "input". */
export const upsertEnv = (content: string, key: string, value: string): string => {
    // parseEnv answers a Dict, `undefined` per key so a MISSING key reads as undefined; every key it does
    // enumerate has a string value, which is what these round-trips iterate.
    const entries = { ...(parseEnv(content) as Record<string, string>), [key]: value };
    return Object.entries(entries)
        .map(([entryKey, entryValue]) => envLine(entryKey, entryValue))
        .join("");
};

// Drop KEY from a .env's text (same parse/re-serialize round-trip as upsertEnv).
export const removeEnv = (content: string, key: string): string => {
    const entries = parseEnv(content) as Record<string, string>;
    delete entries[key];
    return Object.entries(entries)
        .map(([entryKey, entryValue]) => envLine(entryKey, entryValue))
        .join("");
};

// The KEYS present in a .env's text (for the UI's "✓ set" badges), never the values.
export const envKeys = (content: string): string[] => Object.keys(parseEnv(content));

/* The whole Services, no longer a Pick: the inventory hands `services` on to every provider module's
 * secretEntries (provider-registry.ts), and the composition header's own rule applies — take the whole thing
 * where you pass the whole thing on; a Pick of whatever the six modules happen to read would be a
 * transcription that goes stale with every module edit. */
export type SecretsRoutesDeps = Services;

/* The use ledger's newest row for one inventory entry. Env/generated entries are keyed by the exact name a
 * reference carries; a capability entry is ONE row for a vault that may hold several named fields
 * (`reddit/password`, `reddit/totp`), so any of its fields' uses counts as the entry's. */
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

// User-supplied secrets → desired-state/.env (gitignored, on the file denylist, mode 0600). Written
// straight from the browser to the daemon (never the platform); `apply` reloads .env each run so a freshly set
// secret is picked up with no restart. set/remove/list/reveal refuse until DevOps has scaffolded the
// desired-state repo; `inventory` always answers (capability/provider entries exist pre-scaffold).
// `reveal` is the single value-returning route and remains operating-tier gated in-route. After every set/remove the daemon fires
// `intentic deploy secrets push` best-effort so an adopted workspace's Forgejo Actions copy never goes silently stale.
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
    /* THE OWNER'S OWN GATE, in-route rather than by the /secrets role floor, and the distinction is the
     * point: the floor is `maintainer` (auth/role-floor.ts, credentials are the operating tier), and a
     * maintainer is exactly who a gate is sometimes written ABOUT. Letting the operating tier edit the policy
     * would mean anyone it constrains could lift their own constraint, which is not a gate. */
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
    /* Everybody who could be named an approver: the bound owner plus the Access roster. Checked so a gate
     * cannot be written against somebody who can never sign in — a typo'd address would produce a credential
     * nobody on earth can release, which is a lock rather than a gate, discovered mid-turn by an agent that
     * then cannot proceed. */
    const releasableBy = async (): Promise<readonly string[]> => {
        const [owner, members] = await Promise.all([services.ownerEmail(), services.members.list()]);
        return [...(owner !== undefined ? [owner.toLowerCase()] : []), ...members.map((member) => member.email.toLowerCase())];
    };
    // Refuse a gate naming somebody who cannot sign in. Compared lowercased for the roster's own reason
    // (auth/auth.ts): every write to the roster normalizes, while a Google claim may preserve case.
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
                // Every provider's connected-account rows, from the modules themselves (provider-registry.ts).
                // This list was hand-kept here and wrong twice — Kimi's rows never existed and Cursor's were
                // forgotten the week it landed — which is the exact omission the registry exists to end.
                providerSecretEntries(services),
                services.secretUses.all().catch(() => [] as const),
                /* The approval policy, joined on below so a row can say "needs approval from Bob" without a
                 * second call. An unreadable policy reads as NO gates HERE, which is the one place in this
                 * feature that is right: this is a display surface, and a Secrets view that refuses to render
                 * because one file is corrupt tells the owner less than a view that renders without badges.
                 * Everything that actually RELEASES a credential fails closed instead
                 * (secrets/credential-gate.ts). */
                services.credentialGates.list().catch(() => [] as const),
            ]);
            const capabilityEntries: SecretInventoryEntry[] = capabilities
                .filter((capability) => secretField(capability, connectors) !== undefined)
                .map((capability) => ({
                    key: capability.id,
                    kind: "capability",
                    status: "connected",
                    requiredBy: [],
                    /* THE VAULT, not the manifest, this line used to name capabilities.json and had been wrong
                     * since the credential values moved out of it. Harmless while that file was untracked and
                     * unreadable-ish; actively misleading now that it is neither, because "where does this live"
                     * would be pointing the owner at a file in their own Changes review. The value is beside the
                     * provider logins below, in the one tree a secret-less export leaves behind. */
                    storedAt: stateRelPath(".intentic/secrets/auth/", "capability-secrets.json"),
                    revealable: true,
                }));
            // The use ledger's newest row per entry, joined in, the inventory is where "when did the agent
            // last spend this" is answered, so the ledger never needs its own surface.
            const lastByName = lastUseByName(uses);
            /* The gate covering one entry, by the same subject rule the exits use: an env or generated row is
             * a SECRET subject under its own key, a capability row is a CAPABILITY subject under its id, and a
             * provider account is neither (gating a model login would stop the sandbox thinking, which is not
             * what this feature is for). */
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
            // Capability credentials first (key = capability id), they exist pre-scaffold, before ensureActive.
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
        /* THE POLICY, READ. Named subjects and approver addresses, never a value, which is why the agent's own
         * token reaches this one (auth/grants.ts): a model that cannot see which credentials are gated cannot
         * tell "not connected" from "needs Bob", and that difference decides whether its next move is to ask a
         * person or to go looking for another road.
         *
         * An unreadable policy is an ERROR here rather than an empty list. The Secrets view can render without
         * badges (the inventory join swallows it deliberately, and says so), but a caller that asked this
         * question directly is entitled to know the answer is unavailable rather than "nothing". */
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
            /* THE SUBJECT MUST EXIST, checked against the same two places the exits resolve from: the named
             * registry for a secret, the capability manifest for a connected account. A gate on a name nothing
             * answers to is invisible dead policy — it never fires, so the owner believes a credential is
             * guarded when it is not, which is the worst possible way for this feature to be wrong. */
            if (input.kind === "capability") {
                const capability = await services.capabilities.get(input.subject);
                if (capability === undefined) {
                    throw new ORPCError("NOT_FOUND", { message: `nothing is connected under the id "${input.subject}"` });
                }
                /* SESSION-SHAPED CREDENTIALS CANNOT BE RELEASED FOR ONE USE, so the route settles the scope
                 * rather than trusting what was sent. A signed-in browser profile, an identity's browser and a
                 * running MCP server are all mounted for a whole turn: there is no "one use" to release,
                 * because the use is a page that is already logged in. Forced here rather than validated so a
                 * client that sends the wrong thing gets the right policy instead of an error about a
                 * distinction it has no way to know (credential-grants.ts argues the whole rule). */
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
        /* THE AGENT'S DOOR. A gated capability is ABSENT from a turn rather than refused inside it (its
         * profile is not mounted, its env is not exported), so unlike a secret reference there is nothing for
         * the model to trip over and learn from — this route is how it asks on purpose.
         *
         * It parks: the card goes up and this handler holds until somebody named on it clicks, which is why
         * the CLI holds its connection open with no timeout (bin/secrets says why). Refusals name the
         * approvers and tell the model not to retry, like every other refusal in this feature. */
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
            /* A PER-USE GATE IS NOT ASKED FOR HERE, it is asked for AT the use. Raising a card whose release
             * covers one use, out of band from any use, would spend a person's click on nothing: no grant is
             * recorded for `use` scope, so the next reference would ask again. The model is told the road
             * instead, which is the one it should have taken. */
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
                // The body's own field, else the header every agent CLI in this sandbox sends from
                // INTENTIC_TURN_OWNER (children.routes.ts, wallet.routes.ts, ask.routes.ts). Either way the
                // card lands in the LIVE run's conversation, which the gate re-derives for itself.
                conversationId: input.conversationId ?? context.headers.get("x-intentic-conversation") ?? undefined,
                // A `secrets request` only ever arrives from a turn's own shell, and an unattended turn's
                // shell is still unattended: the gate refuses rather than parking on a card nobody will see.
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
