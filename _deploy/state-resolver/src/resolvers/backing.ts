import type { Ref, SecretRef } from "@intentic/graph";
import { generated, makeRef } from "@intentic/graph";
import type { BackingCapability, BackingIntent, HostInput } from "@intentic/need-resolver";
import type { ResolvedNode, ResourceType } from "@intentic/resources";
import { appSlug, backingPort, bindingId, bucketName, cacheUser, dbName, secretKey } from "../lib/ids.js";
import { IMAGES } from "../lib/images.js";
import { sshOf } from "../lib/ssh.js";
import type { IngressPair } from "./route.js";
import { exposeRoute, routeId } from "./route.js";

// The backing catalog: each abstract capability mapped to the concrete resource its provider deploys, the
// per-app binding resource that provisions an app's isolated credentials on it, the pinned image, and
// whether instances of it route publicly. Adding a capability is one entry here plus a provider — the
// authoring surface (i.want.database / cache) is unchanged. Auth / object-storage land in Phase 2.
interface BackingSpec {
    readonly type: ResourceType;
    readonly bindingType: ResourceType;
    readonly image: string;
    // Whether an instance is exposed through Cloudflare. database/cache are internal-only (false): apps reach
    // them over the host's internal ip, never a tunnel-routed hostname.
    readonly routes: boolean;
}

const catalog: Readonly<Record<BackingCapability, BackingSpec>> = {
    database: { type: "postgres", bindingType: "postgres-database", image: IMAGES.postgres, routes: false },
    cache: { type: "valkey", bindingType: "valkey-namespace", image: IMAGES.valkey, routes: false },
    // auth always routes (the OIDC issuer must be a public HTTPS URL browsers redirect to). object-storage is
    // internal-only by default; it routes only when the author gives it a domain (for external/browser access).
    auth: { type: "authentik", bindingType: "authentik-client", image: IMAGES.authentik, routes: true },
    "object-storage": { type: "garage", bindingType: "garage-bucket", image: IMAGES.garage, routes: false },
};

// The env vars a binding injects into a consuming app's deployments, each mapping an env var name to the
// output it reads off the per-app binding node. Spread before the author's env so an explicit override wins.
// REDIS_URL is an alias of VALKEY_URL so libraries that default to it work without extra config.
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

// The generated admin secret key a backing instance and its binding nodes share (same key -> same value via
// .secrets.json), so a binding can authenticate to the instance to mint per-app credentials. database/cache
// authenticate the binding with this; auth shares a bootstrap API token (below); object-storage's binding
// uses the local `garage` CLI (no shared secret needed).
const adminSecretKey = (capability: BackingCapability, instanceId: string): string =>
    secretKey(capability === "database" ? "POSTGRES_ADMIN_PASSWORD" : "VALKEY_ADMIN_PASSWORD", instanceId);

// The bootstrap API token an Authentik instance mints on first boot and its per-app client bindings reuse to
// call its API. Shared via .secrets.json (same key -> same value).
const authBootstrapTokenKey = (instanceId: string): string => secretKey("AUTHENTIK_BOOTSTRAP_TOKEN", instanceId);

// The capability-specific inputs an instance node carries beyond the shared base (ssh + internalIp +
// publishPort + image). database/cache: a generated superuser/requirepass password. auth: Authentik's secret
// key + bootstrap admin token/password + bundled Postgres password + the bundled pg/redis image pins + its
// public domain. object-storage: Garage's RPC secret + admin token + S3 region (+ domain when exposed).
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
            // The Garage CLI (the binding mints buckets/keys with it) talks to the local node over RPC, whose
            // secret the provider generates host-side once (it needs 32 bytes / 64 hex, longer than a generated()
            // value) — so no admin token/RPC secret is threaded here. region is fixed; domain only when exposed.
            return {
                region: "garage",
                ...(intent.domain !== undefined ? { domain: intent.domain } : {}),
            };
    }
};

// A backing instance: one node deployed onto its host over SSH from a pinned image, with a deterministic host
// port. The provider's apply blocks until healthy, so no readyWhen gate. When the capability routes (auth
// always; object-storage when a domain is given) it also emits a Cloudflare route + ingress, aggregated onto
// the host's tunnel by emit. apiToken authorizes the cf-route's DNS write.
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
            // Stateful data lives here — protected from pruning unless the author opts out.
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

// The per-app binding node for one app consuming one backing instance: it provisions the app's isolated
// sub-resource (Postgres database+role / Valkey ACL user / OIDC client / Garage bucket+key) on the instance
// and produces the connection credentials injected into the app's deployments. Depends on the instance so it
// runs once it is healthy. `appDomains` are the consuming app's environment domains, used to whitelist OIDC
// redirect URIs (auth only).
export const resolveBinding = (appId: string, intent: BackingIntent, host: HostInput, appDomains: readonly string[]): ResolvedNode => {
    const spec = catalog[intent.capability];
    const id = bindingId(appId, intent.id);
    // The instance to act on (its node id, stamped as the container's intentic.id label) + the SSH block to
    // reach the host. Per-capability instance refs (host coordinates / url / endpoint) are added below.
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
            // A Valkey ACL user scoped to the app's key prefix; the binding needs the admin password to run
            // ACL SETUSER (valkey-cli auths with requirepass).
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
            // A per-app Authentik OAuth2 provider + application. Unlike the SSH bindings, this calls Authentik's
            // REST API over HTTP at its PUBLIC url (like the Komodo deployment provider), so it carries no SSH
            // block and depends on the instance's route being live. client_id/secret are generated and set on
            // the provider, so outputs need no read-back; the issuer is https://<domain>/application/o/<slug>/.
            // redirectDomains whitelist any path under each consuming app domain.
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
            // A per-app Garage bucket + access key, minted via the local `garage` CLI (docker exec). The
            // endpoint injected into the app is the instance's host-internal S3 endpoint (apps reach it locally).
            return node({
                ...shared,
                endpoint: makeRef<string>(intent.id, "internalEndpoint"),
                bucket: bucketName(appId),
                keyName: bucketName(appId),
            });
    }
};

// The env injection an app's deployments receive for one binding: each contract var as a ref to the binding
// node's output. Used by resolveApp to merge into every deployment's env (before the author's own env).
export const bindingEnv = (appId: string, intent: BackingIntent): Record<string, Ref<string>> => {
    const id = bindingId(appId, intent.id);
    const env: Record<string, Ref<string>> = {};
    for (const [name, output] of envContract[intent.capability]) {
        env[name] = makeRef<string>(id, output);
    }
    return env;
};
