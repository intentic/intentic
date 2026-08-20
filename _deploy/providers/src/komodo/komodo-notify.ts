import type { Provider, ResolvedInputs } from "@intentic/engine";
import { z } from "zod";
import { hasPendingRef, parseInputs, sshSchema } from "../core/inputs.js";
import { overSsh } from "../core/over-ssh.js";
import type { SshExecutor } from "../core/ssh.js";
import { sshExecutor } from "../core/ssh.js";
import type { AlerterConfig, KomodoApi, ResourceTarget } from "./komodo-api.js";
import { komodoApi } from "./komodo-api.js";
import { KOMODO_CORE_PORT } from "./komodo.js";

// The ssh block is the control-plane host's. Komodo's API is reached over an SSH port-forward to Core.
const komodoNotifySchema = sshSchema.extend({
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
// deployments. Reached over an SSH port-forward to Core. read returns undefined until the Discord webhook
// resolves (its ref is PENDING) or while Komodo is unreachable; diff detects drift in the webhook url,
// scope, or enabled flag.
export const createKomodoNotifyProvider = (api: KomodoApi = komodoApi, executor: SshExecutor = sshExecutor): Provider => ({
    read: async (inputs, ctx) => {
        if (hasPendingRef(inputs, "webhook")) {
            return undefined;
        }
        const parsed = parse(inputs);
        try {
            return await overSsh(executor, parsed, KOMODO_CORE_PORT, async (baseUrl) => {
                const jwt = await api.login({ baseUrl, username: parsed.adminUser, password: parsed.adminPassword });
                const alerter = (await api.listAlerters({ baseUrl, jwt })).find((item) => item.name === ctx.id);
                if (alerter === undefined) {
                    return undefined;
                }
                const config = await api.getAlerter({ baseUrl, jwt, id: alerter.id });
                return { outputs: {}, detail: { config } };
            });
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
        return overSsh(executor, parsed, KOMODO_CORE_PORT, async (baseUrl) => {
            const jwt = await api.login({ baseUrl, username: parsed.adminUser, password: parsed.adminPassword });
            const existing = (await api.listAlerters({ baseUrl, jwt })).find((item) => item.name === ctx.id);
            if (existing === undefined) {
                await api.createAlerter({ baseUrl, jwt, name: ctx.id, config: desiredConfig(parsed) });
            } else {
                await api.updateAlerter({ baseUrl, jwt, id: existing.id, config: desiredConfig(parsed) });
            }
            return {};
        });
    },
    delete: async (inputs, ctx) => {
        const parsed = parse(inputs);
        await overSsh(executor, parsed, KOMODO_CORE_PORT, async (baseUrl) => {
            const jwt = await api.login({ baseUrl, username: parsed.adminUser, password: parsed.adminPassword });
            const existing = (await api.listAlerters({ baseUrl, jwt })).find((item) => item.name === ctx.id);
            if (existing === undefined) {
                return;
            }
            await api.deleteAlerter({ baseUrl, jwt, id: existing.id });
        });
    },
});
