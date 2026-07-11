import type { Provider, ResolvedInputs } from "@intentic/engine";
import { z } from "zod";
import { parseInputs } from "../core/inputs.js";
import type { ForgejoApi, ForgejoHook } from "./forgejo-api.js";
import { forgejoApi } from "./forgejo-api.js";

const forgejoNotifySchema = z.object({
    forgejoUrl: z.string(),
    adminUser: z.string(),
    adminPassword: z.string(),
    // The repo owner (a team's org, or the admin user when team-less); the webhook lives on owner/repoName.
    owner: z.string(),
    repoName: z.string(),
    webhook: z.string(),
});
type ForgejoNotifyInputs = z.infer<typeof forgejoNotifySchema>;
const parse = (inputs: ResolvedInputs): ForgejoNotifyInputs => parseInputs(forgejoNotifySchema, inputs, "forgejo-notify");

// The abstract events:["build"] maps to the Forgejo webhook events that carry CI results. The exact
// Forgejo Actions event names are confirmed against a live instance; "push" is the v1 default.
const FORGEJO_EVENTS: readonly string[] = ["push"];

const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((value) => b.includes(value));

// The Discord webhook has no comment/stamp field, so it is matched by (type "discord", config.url === the
// Discord webhook url) — one Discord sink per (repo, url).
const findDiscordHook = (hooks: readonly ForgejoHook[], webhook: string): ForgejoHook | undefined =>
    hooks.find((hook) => hook.type === "discord" && hook.config["url"] === webhook);

// CI notifications: a Forgejo repo webhook of type "discord" firing on build results.
export const createForgejoNotifyProvider = (api: ForgejoApi = forgejoApi): Provider => ({
    read: async (inputs, ctx) => {
        if (typeof inputs["forgejoUrl"] !== "string" || typeof inputs["webhook"] !== "string") {
            return undefined;
        }
        const parsed = parse(inputs);
        try {
            const hook = findDiscordHook(
                await api.listHooks({
                    baseUrl: parsed.forgejoUrl,
                    user: parsed.adminUser,
                    password: parsed.adminPassword,
                    owner: parsed.adminUser,
                    name: parsed.repoName,
                }),
                parsed.webhook,
            );
            if (hook === undefined) {
                return undefined;
            }
            return { outputs: {}, detail: { events: hook.events, active: hook.active } };
        } catch (error) {
            ctx.log(`forgejo-notify "${ctx.id}": forgejo not reachable yet, treating as not-yet-created: ${String(error)}`);
            return undefined;
        }
    },
    diff: (_inputs, observed) => {
        const detail = observed.detail;
        const events = Array.isArray(detail?.["events"]) ? (detail["events"] as string[]) : [];
        if (detail?.["active"] !== true || !sameSet(events, FORGEJO_EVENTS)) {
            return { action: "update", reason: "discord webhook is disabled or its events differ from desired" };
        }
        return { action: "noop" };
    },
    apply: async (inputs) => {
        const parsed = parse(inputs);
        const config = { url: parsed.webhook, content_type: "json" };
        const existing = findDiscordHook(
            await api.listHooks({
                baseUrl: parsed.forgejoUrl,
                user: parsed.adminUser,
                password: parsed.adminPassword,
                owner: parsed.owner,
                name: parsed.repoName,
            }),
            parsed.webhook,
        );
        if (existing === undefined) {
            await api.createHook({
                baseUrl: parsed.forgejoUrl,
                user: parsed.adminUser,
                password: parsed.adminPassword,
                owner: parsed.owner,
                name: parsed.repoName,
                type: "discord",
                config,
                events: FORGEJO_EVENTS,
            });
        } else {
            await api.updateHook({
                baseUrl: parsed.forgejoUrl,
                user: parsed.adminUser,
                password: parsed.adminPassword,
                owner: parsed.owner,
                name: parsed.repoName,
                id: existing.id,
                config,
                events: FORGEJO_EVENTS,
            });
        }
        return {};
    },
    delete: async (inputs) => {
        if (typeof inputs["forgejoUrl"] !== "string") {
            return;
        }
        const parsed = parse(inputs);
        const auth = {
            baseUrl: parsed.forgejoUrl,
            user: parsed.adminUser,
            password: parsed.adminPassword,
            owner: parsed.owner,
            name: parsed.repoName,
        };
        const existing = findDiscordHook(await api.listHooks(auth), parsed.webhook);
        if (existing === undefined) {
            return;
        }
        await api.deleteHook({ ...auth, id: existing.id });
    },
});
