import type { Provider, ResolvedInputs } from "@intentic/engine";
import { z } from "zod";
import { parseInputs } from "../core/inputs.js";
import type { KomodoApi } from "./komodo-api.js";
import { komodoApi } from "./komodo-api.js";

const komodoUserSchema = z.object({
    komodoUrl: z.string(),
    adminUser: z.string(),
    adminPassword: z.string(),
    username: z.string(),
    // The same intentic-generated password as the user's Forgejo account (one credential per person).
    password: z.string(),
    // The per-deployment permissions, resolved from the user's team memberships. level ∈ Read|Execute|Write.
    grants: z.array(z.object({ deployment: z.string(), level: z.enum(["Read", "Execute", "Write"]) })),
});
type KomodoUserInputs = z.infer<typeof komodoUserSchema>;
const parse = (inputs: ResolvedInputs): KomodoUserInputs => parseInputs(komodoUserSchema, inputs, "komodo-user");

// A declared person's Komodo UI account + its per-deployment permissions. CreateLocalUser is admin-only and
// lands the user disabled, so apply creates (when absent), enables, then grants each scoped deployment. read
// keys on existence + enabled (so a freshly-created-but-not-yet-enabled user re-applies); grants are idempotent
// re-asserts. Depends (via refs) on Komodo + each scoped deployment existing. A pure sink — no outputs.
export const createKomodoUserProvider = (api: KomodoApi = komodoApi): Provider => ({
    read: async (inputs, ctx) => {
        if (typeof inputs["komodoUrl"] !== "string") {
            return undefined;
        }
        const parsed = parse(inputs);
        try {
            const jwt = await api.login({ baseUrl: parsed.komodoUrl, username: parsed.adminUser, password: parsed.adminPassword });
            const user = (await api.listUsers({ baseUrl: parsed.komodoUrl, jwt })).find((candidate) => candidate.username === parsed.username);
            return user === undefined ? undefined : { outputs: {}, detail: { enabled: user.enabled } };
        } catch (error) {
            ctx.log(`komodo-user "${ctx.id}": komodo not reachable yet, treating as not-yet-created: ${String(error)}`);
            return undefined;
        }
    },
    diff: (_inputs, observed) => {
        if (observed.detail?.["enabled"] !== true) {
            return { action: "update", reason: "komodo user is not enabled" };
        }
        return { action: "noop" };
    },
    apply: async (inputs) => {
        const parsed = parse(inputs);
        const jwt = await api.login({ baseUrl: parsed.komodoUrl, username: parsed.adminUser, password: parsed.adminPassword });
        const find = async (): Promise<string | undefined> =>
            (await api.listUsers({ baseUrl: parsed.komodoUrl, jwt })).find((candidate) => candidate.username === parsed.username)?.id;
        let userId = await find();
        if (userId === undefined) {
            await api.createUser({ baseUrl: parsed.komodoUrl, jwt, username: parsed.username, password: parsed.password });
            userId = await find();
        }
        if (userId === undefined) {
            throw new Error(`komodo user "${parsed.username}" was not found after creation`);
        }
        await api.enableUser({ baseUrl: parsed.komodoUrl, jwt, userId });
        for (const grant of parsed.grants) {
            await api.setPermissionOnTarget({ baseUrl: parsed.komodoUrl, jwt, userId, deployment: grant.deployment, level: grant.level });
        }
        return {};
    },
    delete: async (inputs) => {
        if (typeof inputs["komodoUrl"] !== "string") {
            return;
        }
        const parsed = parse(inputs);
        const jwt = await api.login({ baseUrl: parsed.komodoUrl, username: parsed.adminUser, password: parsed.adminPassword });
        const user = (await api.listUsers({ baseUrl: parsed.komodoUrl, jwt })).find((candidate) => candidate.username === parsed.username);
        if (user === undefined) {
            return;
        }
        await api.deleteUser({ baseUrl: parsed.komodoUrl, jwt, userId: user.id });
    },
});
