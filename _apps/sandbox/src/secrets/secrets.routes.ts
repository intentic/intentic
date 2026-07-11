import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseEnv } from "node:util";
import { collectSecretInventory, ENV_FILE, SECRETS_FILE } from "@intentic/scaffold";
import { secretField } from "../capabilities/capability.js";
import type { SecretInventoryEntry } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import { bearerFrom, ForbiddenError } from "../auth/auth.js";
import { secretsContract } from "@intentic/sandbox-contract";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";

// One connected provider account as an inventory entry (never a value — provider tokens are not revealable).
const providerAccountEntry = (provider: string, providerName: string, id: string, label: string, storedAt: string): SecretInventoryEntry => ({
    key: `${provider}:${id}`,
    kind: "provider",
    label: `${providerName} · ${label}`,
    status: "connected",
    requiredBy: [],
    storedAt,
    revealable: false,
});

// Upsert KEY=value into a .env's text. Parsed and re-serialized with Node's own env parser (the same one the
// CLI loads the file with), every value double-quoted — so multi-line secrets (SSH private keys) survive the
// round-trip. The file is machine-managed (only the daemon writes it), so re-serializing is lossless.
// ponytail: values are tokens/PEM keys — no embedded double quotes; add escaping if a secret kind ever carries them.
export const upsertEnv = (content: string, key: string, value: string): string => {
    const entries = { ...parseEnv(content), [key]: value };
    return Object.entries(entries)
        .map(([entryKey, entryValue]) => `${entryKey}="${entryValue}"\n`)
        .join("");
};

// Drop KEY from a .env's text (same parse/re-serialize round-trip as upsertEnv).
export const removeEnv = (content: string, key: string): string => {
    const entries: Record<string, string | undefined> = { ...parseEnv(content) };
    delete entries[key];
    return Object.entries(entries)
        .map(([entryKey, entryValue]) => `${entryKey}="${entryValue}"\n`)
        .join("");
};

// The KEYS present in a .env's text (for the UI's "✓ set" badges) — never the values.
export const envKeys = (content: string): string[] => Object.keys(parseEnv(content));

// User-supplied secrets → repositories/desired-state/.env (gitignored, on the file denylist, mode 0600). Written
// straight from the browser to the daemon (never the platform); `apply` reloads .env each run so a freshly set
// secret is picked up with no restart. set/remove/list/reveal refuse until DevOps has scaffolded the
// desired-state repo; `inventory` always answers (capability/provider entries exist pre-scaffold).
// `reveal` is the single value-returning route, owner-only. After every set/remove the daemon fires
// `intentic secrets push` best-effort so an adopted workspace's Forgejo Actions copy never goes silently stale.
export const createSecretsRoutes = (services: Services) => {
    const i = implement(secretsContract).$context<OrpcContext>();
    const desiredState = (): string => services.workspace.repos["desired-state"];
    const envPath = (): string => join(desiredState(), ENV_FILE);
    const ensureActive = (): void => {
        if (!existsSync(desiredState())) {
            throw new ORPCError("PRECONDITION_FAILED", { message: "DevOps is not active — activate it before adding secrets." });
        }
    };
    const read = async (): Promise<string> => {
        try {
            return await readFile(envPath(), "utf8");
        } catch {
            return "";
        }
    };
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
    const pushToCi = (): void => {
        void (async () => {
            for await (const line of services.intentic({ args: ["secrets", "push"], cwd: services.workspace.repositories })) {
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
            const [repoEntries, capabilities, claudeAccounts, codexAccounts, grokConnected] = await Promise.all([
                existsSync(desiredState()) ? collectSecretInventory(desiredState()) : [],
                services.capabilities.list(),
                services.claudeStore.list(),
                services.codexStore.list(),
                services.openCode.connected("xai"),
            ]);
            const capabilityEntries: SecretInventoryEntry[] = capabilities
                .filter((capability) => secretField(capability) !== undefined)
                .map((capability) => ({
                    key: capability.id,
                    kind: "capability",
                    status: "connected",
                    requiredBy: [],
                    storedAt: ".intentic/capabilities.json",
                    revealable: true,
                }));
            // One entry per connected account.
            const providerEntries: SecretInventoryEntry[] = [
                ...claudeAccounts.map((a) => providerAccountEntry("claude", "Claude", a.id, a.label, `.intentic/claude/${a.id}.json`)),
                ...codexAccounts.map((a) => providerAccountEntry("codex", "ChatGPT", a.id, a.label, `.intentic/codex/${a.id}`)),
                ...(grokConnected ? [providerAccountEntry("grok", "Grok", "xai", "Grok", ".intentic/opencode")] : []),
            ];
            return { entries: [...repoEntries, ...capabilityEntries, ...providerEntries] };
        }),
        reveal: i.reveal.handler(async ({ input, context }) => {
            await ensureOwner(context.headers);
            // Capability credentials first (key = capability id) — they exist pre-scaffold, before ensureActive.
            const capability = await services.capabilities.get(input.key);
            if (capability !== undefined) {
                const field = secretField(capability);
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
    };
};
