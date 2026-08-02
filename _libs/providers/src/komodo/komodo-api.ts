import { z } from "zod";
import { parseResponse } from "../core/inputs.js";
import { responseDetail } from "../core/response-detail.js";

// A Komodo Core resource summary (id + unique name) and the typed Alerter config the CD-notify provider
// reconciles. Komodo's API is POST /{auth|read|write|execute}/{Operation} with a {type, params} body; it
// returns the operation result JSON directly and signals errors with a non-2xx status + {message,...}.
// Read responses are validated against the fields we consume (extra fields dropped); write/execute ops
// ignore the body (only the status matters).

export interface KomodoResource {
    readonly id: string;
    readonly name: string;
}

// A Komodo user: its mongo id (needed to set permissions), login name, and whether it is enabled. A user
// created via CreateLocalUser lands disabled, so the provider checks `enabled` to decide whether to enable it.
export interface KomodoUser {
    readonly id: string;
    readonly username: string;
    readonly enabled: boolean;
}

// The Komodo permission level a grant carries (None is never sent — an absent grant is the same as None).
export type KomodoPermissionLevel = "Read" | "Execute" | "Write";

// The slice of a Deployment's config the deployment provider diffs against — the one authored MUTABLE field
// it converges, `environment`. server_id and the build image are fixed at creation (like the deterministic
// ports); branch is a Build concept that a Deployment does not carry (GetDeployment never returns it). Komodo
// stores `environment` as a multiline string ("K = V\n") but also accepts the array-of-{variable,value} form
// we send, so read must tolerate both; other fields Komodo returns (server_id/image/ports/...) pass through.
const deploymentConfigSchema = z.looseObject({
    environment: z.union([z.string(), z.array(z.object({ variable: z.string(), value: z.string() }))]).default(""),
});
export type DeploymentConfig = z.infer<typeof deploymentConfigSchema>;

const alerterEndpointSchema = z.object({ type: z.enum(["Discord", "Slack", "Custom"]), params: z.object({ url: z.string() }) });
const resourceTargetSchema = z.object({ type: z.string(), id: z.string() });
const alerterConfigSchema = z.object({
    enabled: z.boolean(),
    endpoint: alerterEndpointSchema,
    alert_types: z.array(z.string()).readonly(),
    resources: z.array(resourceTargetSchema).readonly(),
    except_resources: z.array(resourceTargetSchema).readonly(),
});
export type AlerterEndpoint = z.infer<typeof alerterEndpointSchema>;
export type ResourceTarget = z.infer<typeof resourceTargetSchema>;
export type AlerterConfig = z.infer<typeof alerterConfigSchema>;

// ListX returns ResourceListItem<Info>[]; we validate id/name (+ deployment run state from info) and drop
// the rest. The login result is the JwtOrTwoFactor enum, internally tagged: {"type":"Jwt","data":{"jwt"}}
// on success, {"type":"Totp"|"Passkey",...} when 2FA is required.
const listItemSchema = z.object({ id: z.string(), name: z.string() });
// Komodo's User serializes its mongo id as "_id"; enabled defaults false (CreateLocalUser lands disabled).
const rawUserSchema = z.object({ _id: z.string(), username: z.string(), enabled: z.boolean().default(false) });
const loginSchema = z.object({ type: z.string(), data: z.object({ jwt: z.string() }).optional() });
const getAlerterSchema = z.object({ config: alerterConfigSchema });
const getDeploymentSchema = z.object({ config: deploymentConfigSchema });

// The slice of the Komodo Core API the app/deployment/komodo-notify providers use, injected so the
// providers are unit-testable with a fake; the default `komodoApi` below talks to a Komodo Core over
// native fetch. Auth is a JWT minted per provider call via local-admin login (never baked in). Build and
// deployment configs are provider-built and passed through opaquely (their exact v2 JSON shapes are
// confirmed at integration time); the alerter config is typed because the notify provider diffs it. Builds
// are gone — CI builds + pushes the image and the workflow's notify step triggers Deploy, so this surface is
// just login + deployment reconciliation + alerters.
export interface KomodoApi {
    // POST /auth/LoginLocalUser {username,password} -> jwt (local auth must be enabled).
    readonly login: (args: { readonly baseUrl: string; readonly username: string; readonly password: string }) => Promise<string>;
    readonly listServers: (args: { readonly baseUrl: string; readonly jwt: string }) => Promise<readonly KomodoResource[]>;
    readonly listDeployments: (args: { readonly baseUrl: string; readonly jwt: string }) => Promise<readonly KomodoResource[]>;
    // read/GetDeployment {deployment: <id or name>} -> the authored config slice the provider diffs.
    readonly getDeployment: (args: { readonly baseUrl: string; readonly jwt: string; readonly deployment: string }) => Promise<DeploymentConfig>;
    readonly createDeployment: (args: {
        readonly baseUrl: string;
        readonly jwt: string;
        readonly name: string;
        readonly config: Readonly<Record<string, unknown>>;
    }) => Promise<void>;
    readonly updateDeployment: (args: {
        readonly baseUrl: string;
        readonly jwt: string;
        readonly id: string;
        readonly config: Readonly<Record<string, unknown>>;
    }) => Promise<void>;
    // write/DeleteDeployment {id} — tear a deployment down (used by prune). Stops + removes the container too.
    readonly deleteDeployment: (args: { readonly baseUrl: string; readonly jwt: string; readonly id: string }) => Promise<void>;
    // read/ListUsers {service_users:"Include"} -> every user (id from "_id", username, enabled).
    readonly listUsers: (args: { readonly baseUrl: string; readonly jwt: string }) => Promise<readonly KomodoUser[]>;
    // write/DeleteUser {id} — remove a user account (used by prune). The exact op is confirmed at integration time.
    readonly deleteUser: (args: { readonly baseUrl: string; readonly jwt: string; readonly userId: string }) => Promise<void>;
    // write/CreateLocalUser {username,password}; admin-only, creates the user DISABLED (enable separately).
    readonly createUser: (args: {
        readonly baseUrl: string;
        readonly jwt: string;
        readonly username: string;
        readonly password: string;
    }) => Promise<void>;
    // write/UpdateUserBasePermissions {user_id, enabled:true} — flip a freshly-created user on.
    readonly enableUser: (args: { readonly baseUrl: string; readonly jwt: string; readonly userId: string }) => Promise<void>;
    // write/UpdatePermissionOnTarget — grant a user `level` on one Deployment.
    readonly setPermissionOnTarget: (args: {
        readonly baseUrl: string;
        readonly jwt: string;
        readonly userId: string;
        readonly deployment: string;
        readonly level: KomodoPermissionLevel;
    }) => Promise<void>;
    readonly listAlerters: (args: { readonly baseUrl: string; readonly jwt: string }) => Promise<readonly KomodoResource[]>;
    readonly getAlerter: (args: { readonly baseUrl: string; readonly jwt: string; readonly id: string }) => Promise<AlerterConfig>;
    readonly createAlerter: (args: {
        readonly baseUrl: string;
        readonly jwt: string;
        readonly name: string;
        readonly config: AlerterConfig;
    }) => Promise<void>;
    readonly updateAlerter: (args: {
        readonly baseUrl: string;
        readonly jwt: string;
        readonly id: string;
        readonly config: AlerterConfig;
    }) => Promise<void>;
    // write/DeleteAlerter {id} — remove an alerter (used by prune).
    readonly deleteAlerter: (args: { readonly baseUrl: string; readonly jwt: string; readonly id: string }) => Promise<void>;
}

type Module = "read" | "write" | "execute";

interface PostArgs {
    readonly baseUrl: string;
    readonly module: Module;
    readonly type: string;
    readonly params: Readonly<Record<string, unknown>>;
    readonly jwt?: string;
}

// POST the {type, params} envelope; throw on a non-2xx status. Write/execute ops use this directly and
// ignore the body; read ops layer response validation on top via `read`.
const post = async (args: PostArgs): Promise<Response> => {
    const response = await fetch(`${args.baseUrl}/${args.module}`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            // Komodo expects the bare JWT in Authorization (no "Bearer " prefix), unlike most APIs.
            ...(args.jwt !== undefined ? { Authorization: args.jwt } : {}),
        },
        body: JSON.stringify({ type: args.type, params: args.params }),
        // Bound a stalled connection (undici's default headers timeout is ~5 minutes).
        signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
        throw new Error(`Komodo ${args.module}/${args.type} failed (HTTP ${response.status}): ${await responseDetail(response)}`);
    }
    return response;
};

const read = async <S extends z.ZodType>(args: PostArgs, schema: S): Promise<z.infer<S>> =>
    parseResponse(schema, await (await post(args)).json(), `Komodo ${args.module}/${args.type}`);

const project = (items: readonly z.infer<typeof listItemSchema>[]): readonly KomodoResource[] =>
    items.map((item) => ({ id: item.id, name: item.name }));

export const komodoApi: KomodoApi = {
    login: async ({ baseUrl, username, password }) => {
        // Auth is the external mogh_auth surface: POST /auth/login/<Operation> with the BARE params (not the
        // {type,params} envelope of /read|/write|/execute), and the JWT comes back internally tagged under .data.
        const response = await fetch(`${baseUrl}/auth/login/LoginLocalUser`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username, password }),
            signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) {
            throw new Error(`Komodo auth/login/LoginLocalUser failed (HTTP ${response.status}): ${await responseDetail(response)}`);
        }
        const result = parseResponse(loginSchema, await response.json(), "Komodo auth/login/LoginLocalUser");
        if (result.type !== "Jwt" || result.data === undefined) {
            throw new Error(`Komodo login did not return a Jwt (got "${result.type}"; 2FA is not supported)`);
        }
        return result.data.jwt;
    },
    listServers: async ({ baseUrl, jwt }) =>
        project(await read({ baseUrl, module: "read", type: "ListServers", params: {}, jwt }, z.array(listItemSchema))),
    listDeployments: async ({ baseUrl, jwt }) =>
        project(await read({ baseUrl, module: "read", type: "ListDeployments", params: {}, jwt }, z.array(listItemSchema))),
    getDeployment: async ({ baseUrl, jwt, deployment }) =>
        (await read({ baseUrl, module: "read", type: "GetDeployment", params: { deployment }, jwt }, getDeploymentSchema)).config,
    createDeployment: async ({ baseUrl, jwt, name, config }) => {
        await post({ baseUrl, module: "write", type: "CreateDeployment", params: { name, config }, jwt });
    },
    updateDeployment: async ({ baseUrl, jwt, id, config }) => {
        await post({ baseUrl, module: "write", type: "UpdateDeployment", params: { id, config }, jwt });
    },
    deleteDeployment: async ({ baseUrl, jwt, id }) => {
        await post({ baseUrl, module: "write", type: "DeleteDeployment", params: { id }, jwt });
    },
    listUsers: async ({ baseUrl, jwt }) => {
        const users = await read({ baseUrl, module: "read", type: "ListUsers", params: { service_users: "Include" }, jwt }, z.array(rawUserSchema));
        return users.map((user) => ({ id: user["_id"], username: user.username, enabled: user.enabled }));
    },
    createUser: async ({ baseUrl, jwt, username, password }) => {
        await post({ baseUrl, module: "write", type: "CreateLocalUser", params: { username, password }, jwt });
    },
    deleteUser: async ({ baseUrl, jwt, userId }) => {
        await post({ baseUrl, module: "write", type: "DeleteUser", params: { id: userId }, jwt });
    },
    enableUser: async ({ baseUrl, jwt, userId }) => {
        await post({ baseUrl, module: "write", type: "UpdateUserBasePermissions", params: { user_id: userId, enabled: true }, jwt });
    },
    setPermissionOnTarget: async ({ baseUrl, jwt, userId, deployment, level }) => {
        await post({
            baseUrl,
            module: "write",
            type: "UpdatePermissionOnTarget",
            params: {
                user_target: { type: "User", id: userId },
                resource_target: { type: "Deployment", id: deployment },
                permission: { level, specific: [] },
            },
            jwt,
        });
    },
    listAlerters: async ({ baseUrl, jwt }) =>
        project(await read({ baseUrl, module: "read", type: "ListAlerters", params: {}, jwt }, z.array(listItemSchema))),
    getAlerter: async ({ baseUrl, jwt, id }) =>
        (await read({ baseUrl, module: "read", type: "GetAlerter", params: { alerter: id }, jwt }, getAlerterSchema)).config,
    createAlerter: async ({ baseUrl, jwt, name, config }) => {
        await post({ baseUrl, module: "write", type: "CreateAlerter", params: { name, config }, jwt });
    },
    updateAlerter: async ({ baseUrl, jwt, id, config }) => {
        await post({ baseUrl, module: "write", type: "UpdateAlerter", params: { id, config }, jwt });
    },
    deleteAlerter: async ({ baseUrl, jwt, id }) => {
        await post({ baseUrl, module: "write", type: "DeleteAlerter", params: { id }, jwt });
    },
};
