import type { Provider, ResolvedInputs } from "@intentic/engine";
import { z } from "zod";
import { parseInputs } from "../core/inputs.js";
import type { AlerterConfig, KomodoApi, ResourceTarget } from "./komodo-api.js";
import { komodoApi } from "./komodo-api.js";

const komodoNotifySchema = z.object({
    komodoUrl: z.string(),
    adminUser: z.string(),
    adminPassword: z.string(),
    targets: z.array(z.string()),
    webhook: z.string(),
});
type KomodoNotifyInputs = z.infer<typeof komodoNotifySchema>;
const parse = (inputs: ResolvedInputs): KomodoNotifyInputs => parseInputs(komodoNotifySchema, inputs, "komodo-notify");

// events:["deploy"] maps to the Komodo alert variants that fire on deployment lifecycle events.
const DEPLOY_ALERT_TYPES: readonly string[] = ["ContainerStateChange", "DeploymentAutoUpdated"];

// The Discord alerter scoped to exactly this app's deployments, so it does not fire for sibling apps.
const desiredConfig = (parsed: KomodoNotifyInputs): AlerterConfig => ({
    enabled: true,
    endpoint: { type: "Discord", params: { url: parsed.webhook } },
    alert_types: DEPLOY_ALERT_TYPES,
    resources: parsed.targets.map((id): ResourceTarget => ({ type: "Deployment", id })),
    except_resources: [],
});

const targetKey = (target: ResourceTarget): string => `${target.type}:${target.id}`;

const sameTargets = (a: readonly ResourceTarget[], b: readonly ResourceTarget[]): boolean => {
    if (a.length !== b.length) {
        return false;
    }
    const set = new Set(b.map(targetKey));
    return a.every((target) => set.has(targetKey(target)));
};

// CD notifications: a native Komodo Discord Alerter named <app>-notify (= ctx.id), scoped to the app's
// deployments. read returns undefined until Komodo is up (komodoUrl PENDING) or unreachable; diff detects
// drift in the webhook url, scope, or enabled flag.
export const createKomodoNotifyProvider = (api: KomodoApi = komodoApi): Provider => ({
    read: async (inputs, ctx) => {
        if (typeof inputs["komodoUrl"] !== "string" || typeof inputs["webhook"] !== "string") {
            return undefined;
        }
        const parsed = parse(inputs);
        try {
            const jwt = await api.login({ baseUrl: parsed.komodoUrl, username: parsed.adminUser, password: parsed.adminPassword });
            const alerter = (await api.listAlerters({ baseUrl: parsed.komodoUrl, jwt })).find((item) => item.name === ctx.id);
            if (alerter === undefined) {
                return undefined;
            }
            const config = await api.getAlerter({ baseUrl: parsed.komodoUrl, jwt, id: alerter.id });
            return { outputs: {}, detail: { config } };
        } catch (error) {
            ctx.log(`komodo-notify "${ctx.id}": komodo not reachable yet, treating as not-yet-created: ${String(error)}`);
            return undefined;
        }
    },
    diff: (inputs, observed) => {
        const parsed = parse(inputs);
        const current = observed.detail?.["config"] as AlerterConfig | undefined;
        const desired = desiredConfig(parsed);
        if (current === undefined || current.enabled !== true) {
            return { action: "update", reason: "alerter missing config or disabled" };
        }
        if (current.endpoint.params.url !== desired.endpoint.params.url) {
            return { action: "update", reason: "Discord webhook url differs from desired" };
        }
        if (!sameTargets(current.resources, desired.resources)) {
            return { action: "update", reason: "scoped deployments differ from desired" };
        }
        return { action: "noop" };
    },
    apply: async (inputs, _observed, ctx) => {
        const parsed = parse(inputs);
        const jwt = await api.login({ baseUrl: parsed.komodoUrl, username: parsed.adminUser, password: parsed.adminPassword });
        const existing = (await api.listAlerters({ baseUrl: parsed.komodoUrl, jwt })).find((item) => item.name === ctx.id);
        if (existing === undefined) {
            await api.createAlerter({ baseUrl: parsed.komodoUrl, jwt, name: ctx.id, config: desiredConfig(parsed) });
        } else {
            await api.updateAlerter({ baseUrl: parsed.komodoUrl, jwt, id: existing.id, config: desiredConfig(parsed) });
        }
        return {};
    },
    delete: async (inputs, ctx) => {
        if (typeof inputs["komodoUrl"] !== "string") {
            return;
        }
        const parsed = parse(inputs);
        const jwt = await api.login({ baseUrl: parsed.komodoUrl, username: parsed.adminUser, password: parsed.adminPassword });
        const existing = (await api.listAlerters({ baseUrl: parsed.komodoUrl, jwt })).find((item) => item.name === ctx.id);
        if (existing === undefined) {
            return;
        }
        await api.deleteAlerter({ baseUrl: parsed.komodoUrl, jwt, id: existing.id });
    },
});
