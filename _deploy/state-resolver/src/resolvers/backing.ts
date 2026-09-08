import type { Ref, SecretRef } from "@intentic/graph";
import { generated, makeRef } from "@intentic/graph";
import type { BackingCapability, BackingIntent, HostInput } from "@intentic/need-resolver";
import type { ResolvedNode, ResourceType } from "@intentic/resources";
import { appSlug, backingPort, bindingId, bucketName, cacheUser, dbName, secretKey } from "../lib/ids.js";
import { IMAGES } from "../lib/images.js";
import { sshOf } from "../lib/ssh.js";
import type { IngressPair } from "./route.js";
import { exposeRoute, routeId } from "./route.js";

// Backing catalog: each capability maps to its resource type, per-app binding type, pinned image, and whether it
// routes publicly. Adding a capability is one entry here plus a provider; the authoring surface is unchanged.
interface BackingSpec {
    readonly type: ResourceType;
    readonly bindingType: ResourceType;
    readonly image: string;
    // Whether an instance routes through Cloudflare; database/cache stay internal-only.
    readonly routes: boolean;
}

const catalog: Readonly<Record<BackingCapability, BackingSpec>> = {
    database: { type: "postgres", bindingType: "postgres-database", image: IMAGES.postgres, routes: false },
    cache: { type: "valkey", bindingType: "valkey-namespace", image: IMAGES.valkey, routes: false },
    // auth always routes (issuer must be a public HTTPS URL); object-storage routes only when given a domain.
    auth: { type: "authentik", bindingType: "authentik-client", image: IMAGES.authentik, routes: true },
    "object-storage": { type: "garage", bindingType: "garage-bucket", image: IMAGES.garage, routes: false },
};

// Env vars a binding injects, spread before the author's env; REDIS_URL aliases VALKEY_URL.
const envContract: Readonly<Record<BackingCapability, readonly (readonly [string, string])[]>> = {
    database: [["DATABASE_URL", "url"]],
    cache: [
        ["VALKEY_URL", "url"],
        ["REDIS_URL", "url"],
    ],
    auth: [
        ["OIDC_ISSUER", "issuer"],
        ["OIDC_CLIENT_ID", "clientId"],
        ["OIDC_CLIENT_SECRET", "clientSecret"],
    ],
    "object-storage": [
        ["S3_ENDPOINT", "endpoint"],
        ["S3_ACCESS_KEY", "accessKey"],
        ["S3_SECRET_KEY", "secretKey"],
        ["S3_BUCKET", "bucket"],
    ],
};

// Admin secret shared by an instance and its bindings (same key -> same value) to authenticate.
const adminSecretKey = (capability: BackingCapability, instanceId: string): string =>
    secretKey(capability === "database" ? "POSTGRES_ADMIN_PASSWORD" : "VALKEY_ADMIN_PASSWORD", instanceId);

// Bootstrap API token Authentik mints on first boot; per-app bindings reuse it via the shared secret key.
const authBootstrapTokenKey = (instanceId: string): string => secretKey("AUTHENTIK_BOOTSTRAP_TOKEN", instanceId);

// Capability-specific inputs beyond the shared base (ssh + internalIp + publishPort + image):
// database/cache: a generated admin password.
// auth: secret key, bootstrap token + password, bundled db password, pg/redis image pins, domain.
// object-storage: region and, when exposed, domain.
const instanceExtra = (intent: BackingIntent): Record<string, unknown> => {
    switch (intent.capability) {
        case "database":
        case "cache":
            return { adminPassword: generated(adminSecretKey(intent.capability, intent.id)) };
        case "auth":
            return {
                domain: intent.domain,
                secretKey: generated(secretKey("AUTHENTIK_SECRET_KEY", intent.id)),
                bootstrapToken: generated(authBootstrapTokenKey(intent.id)),
                bootstrapPassword: generated(secretKey("AUTHENTIK_BOOTSTRAP_PASSWORD", intent.id)),
                dbPassword: generated(secretKey("AUTHENTIK_DB_PASSWORD", intent.id)),
                pgImage: IMAGES.postgres,
                redisImage: IMAGES.valkey,
            };
        case "object-storage":
            // Garage's RPC secret is generated host-side (needs 64 hex, more than generated() gives), not threaded
            // here.
            return {
                region: "garage",
                ...(intent.domain !== undefined ? { domain: intent.domain } : {}),
            };
    }
};

// One backing instance node deployed onto its host over SSH; apply blocks until healthy, so no readyWhen gate.
// When the capability routes (auth always, object-storage with a domain) it also emits a Cloudflare route + ingress.
export const resolveBacking = (intent: BackingIntent, host: HostInput, apiToken: SecretRef): { nodes: ResolvedNode[]; ingress: IngressPair[] } => {
    const spec = catalog[intent.capability];
    const node: ResolvedNode = {
        id: intent.id,
        type: spec.type,
        inputs: {
            server: makeRef(intent.on),
            ...sshOf(host),
            internalIp: makeRef<string>(intent.on, "internalIp"),
            // The host port the instance publishes on; named distinctly from the SSH `port` in the ssh block.
            publishPort: backingPort(intent.id),
            image: spec.image,
            // Stateful data lives here, protected from pruning unless the author opts out.
            protect: intent.protect ?? true,
            ...instanceExtra(intent),
        },
        explicitDependsOn: [intent.on],
    };
    const nodes: ResolvedNode[] = [node];
    const ingress: IngressPair[] = [];
    if (spec.routes || intent.domain !== undefined) {
        if (intent.domain === undefined || intent.expose === undefined) {
            throw new Error(`backing "${intent.id}" (${intent.capability}) must be exposed with a domain; declare it with { expose, domain }`);
        }
        const exposure = exposeRoute(intent.expose, intent.on, intent.domain, backingPort(intent.id), apiToken);
        nodes.push(exposure.route);
        ingress.push(exposure.ingress);
    }
    return { nodes, ingress };
};

// Per-app binding node for one app consuming one backing instance: provisions its isolated sub-resource (db+role
// / ACL user / OIDC client / bucket) and produces the injected connection credentials. `appDomains` whitelist
// OIDC redirect URIs (auth only).
export const resolveBinding = (appId: string, intent: BackingIntent, host: HostInput, appDomains: readonly string[]): ResolvedNode => {
    const spec = catalog[intent.capability];
    const id = bindingId(appId, intent.id);
    // Instance to act on (its node id, the container's intentic.id label) + the SSH block to reach the host.
    const shared = { ...sshOf(host), instance: intent.id };
    const node = (inputs: Record<string, unknown>): ResolvedNode => ({ id, type: spec.bindingType, inputs, explicitDependsOn: [intent.id] });
    switch (intent.capability) {
        case "database":
            return node({
                ...shared,
                instanceHost: makeRef<string>(intent.id, "internalHost"),
                instancePort: makeRef<string>(intent.id, "port"),
                database: dbName(appId),
                role: dbName(appId),
                password: generated(secretKey("APP_DATABASE_PASSWORD", id)),
            });
        case "cache":
            // Valkey ACL user scoped to the app's key prefix; needs the admin password to run ACL SETUSER.
            return node({
                ...shared,
                instanceHost: makeRef<string>(intent.id, "internalHost"),
                instancePort: makeRef<string>(intent.id, "port"),
                adminPassword: generated(adminSecretKey("cache", intent.id)),
                username: cacheUser(appId),
                password: generated(secretKey("APP_CACHE_PASSWORD", id)),
                keyPrefix: cacheUser(appId),
            });
        case "auth": {
            // Per-app Authentik client; calls Authentik's public API over HTTP, so it depends on the route being live.
            if (intent.domain === undefined || intent.expose === undefined) {
                throw new Error(`auth backing "${intent.id}" must be exposed with a domain; declare it with i.want.auth({ expose, domain })`);
            }
            return {
                id,
                type: spec.bindingType,
                inputs: {
                    authentikUrl: `https://${intent.domain}`,
                    bootstrapToken: generated(authBootstrapTokenKey(intent.id)),
                    domain: intent.domain,
                    slug: appSlug(appId),
                    clientId: generated(secretKey("OIDC_CLIENT_ID", id)),
                    clientSecret: generated(secretKey("OIDC_CLIENT_SECRET", id)),
                    redirectDomains: appDomains,
                },
                explicitDependsOn: [intent.id, routeId(intent.expose, intent.domain)],
            };
        }
        case "object-storage":
            // Per-app Garage bucket + key minted via the local `garage` CLI; endpoint is host-internal.
            return node({
                ...shared,
                endpoint: makeRef<string>(intent.id, "internalEndpoint"),
                bucket: bucketName(appId),
                keyName: bucketName(appId),
            });
    }
};

// Env injection for one binding: each contract var as a ref to the binding node's output.
export const bindingEnv = (appId: string, intent: BackingIntent): Record<string, Ref<string>> => {
    const id = bindingId(appId, intent.id);
    const env: Record<string, Ref<string>> = {};
    for (const [name, output] of envContract[intent.capability]) {
        env[name] = makeRef<string>(id, output);
    }
    return env;
};
