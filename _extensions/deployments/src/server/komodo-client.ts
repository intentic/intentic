// Komodo Core API behind one client shape, keyed per call with the user's pasted api-key pair. Distinct from
// _deploy/providers' own Komodo client, which logs in as an admin it provisions itself. `fetch` is injectable for
// tests; failures throw with Komodo's status and body, and the caller decides what that means.

export type FetchFn = typeof fetch;

// Field names match Komodo's own env vars, which this connector reuses.
export interface KomodoConnection {
    readonly capability: string;
    // No trailing slash, every path below is joined with one.
    readonly baseUrl: string;
    readonly apiKey: string;
    readonly apiSecret: string;
}

const BODY_TAIL = 300;
// Bounds a stalled connection; undici's default timeout (~5 min) is far longer than the view's patience.
const TIMEOUT_MS = 15_000;

// A Cloudflare-fronted Komodo 403s a fetch with no user-agent at all; any value here avoids that.
const USER_AGENT = "intentic-sandbox";

// POST {module}/{Operation} with `params` as the whole body: Komodo's route re-wraps it as `{type, params}` itself, so
// wrapping it again here would make every required field read as absent.
const call = async <T>(
    connection: KomodoConnection,
    fetchFn: FetchFn,
    module: "read" | "execute",
    operation: string,
    params: Readonly<Record<string, unknown>> = {},
): Promise<T> => {
    const response = await fetchFn(`${connection.baseUrl}/${module}/${operation}`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "user-agent": USER_AGENT,
            "x-api-key": connection.apiKey,
            "x-api-secret": connection.apiSecret,
        },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`Komodo ${module}/${operation} failed (${response.status}): ${body.slice(0, BODY_TAIL)}`);
    }
    return response.json() as Promise<T>;
};

// Raw shapes we consume, named as Komodo names them. Typed loosely on purpose: Komodo adds fields to `info` release
// over release, and typing only what we read keeps an upgrade from emptying this view instead of erroring on new
// fields.

export interface KomodoListItem<Info> {
    readonly id: string;
    readonly name: string;
    readonly info: Info;
}

export interface KomodoDeploymentInfo {
    readonly state?: string;
    readonly status?: string;
    readonly image?: string;
    readonly update_available?: boolean;
    readonly server_name?: string;
}

export interface KomodoStackService {
    readonly service?: string;
    readonly image?: string;
    readonly update_available?: boolean;
}

export interface KomodoStackInfo {
    readonly state?: string;
    readonly status?: string;
    readonly server_name?: string;
    readonly services?: readonly KomodoStackService[];
}

export interface KomodoServerInfo {
    readonly state?: string;
    readonly stats?: {
        readonly cpu_perc?: number;
        readonly mem_used_gb?: number;
        readonly mem_total_gb?: number;
        readonly disk_used_gb?: number;
        readonly disk_total_gb?: number;
    };
}

// Komodo serializes an alert's mongo id as `{_id: {$oid}}` or a bare string, depending on the path; both are read.
export interface KomodoAlert {
    readonly _id?: { readonly $oid?: string } | string;
    readonly ts?: number;
    readonly resolved?: boolean;
    readonly level?: string;
    readonly target?: { readonly type?: string; readonly id?: string };
    readonly data?: { readonly type?: string; readonly data?: Record<string, unknown> };
}

// Who the API key acts as: Komodo filters every list by permission, so a key with no grants gets an empty array
// indistinguishable from an empty Komodo. Lets the view tell those two apart.
export interface KomodoViewer {
    readonly username: string;
    // Either flag means the key sees everything, so an empty board really is an empty board.
    readonly admin: boolean;
}

export interface KomodoClient {
    // GET /user, the one call on this surface that is not a POST envelope.
    readonly whoami: () => Promise<KomodoViewer>;
    readonly listDeployments: () => Promise<readonly KomodoListItem<KomodoDeploymentInfo>[]>;
    readonly listStacks: () => Promise<readonly KomodoListItem<KomodoStackInfo>[]>;
    readonly listServers: () => Promise<readonly KomodoListItem<KomodoServerInfo>[]>;
    // Newest first, capped by Komodo's own paging.
    readonly listAlerts: () => Promise<readonly KomodoAlert[]>;
    // Both channels of Komodo's `Log` for a deployment or a stack.
    readonly logs: (kind: "deployment" | "stack", name: string, tail: number) => Promise<{ stdout: string; stderr: string }>;
    // One of the five execute operations, already resolved to Komodo's operation name by the caller.
    readonly execute: (operation: string, params: Readonly<Record<string, unknown>>) => Promise<void>;
}

export const komodoClient = (connection: KomodoConnection, fetchFn: FetchFn = fetch): KomodoClient => ({
    whoami: async () => {
        const response = await fetchFn(`${connection.baseUrl}/user`, {
            headers: { "user-agent": USER_AGENT, "x-api-key": connection.apiKey, "x-api-secret": connection.apiSecret },
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!response.ok) {
            const body = await response.text().catch(() => "");
            throw new Error(`Komodo GET /user failed (${response.status}): ${body.slice(0, BODY_TAIL)}`);
        }
        const user = (await response.json()) as { username?: string; admin?: boolean; super_admin?: boolean };
        return { username: user.username ?? "unknown", admin: user.admin === true || user.super_admin === true };
    },
    listDeployments: () => call(connection, fetchFn, "read", "ListDeployments"),
    listStacks: () => call(connection, fetchFn, "read", "ListStacks"),
    listServers: () => call(connection, fetchFn, "read", "ListServers"),
    listAlerts: async () => (await call<{ alerts?: readonly KomodoAlert[] }>(connection, fetchFn, "read", "ListAlerts")).alerts ?? [],
    logs: async (kind, name, tail) => {
        // GetStackLog wants the service filter even when empty; GetDeploymentLog has no such field.
        const log =
            kind === "stack"
                ? await call<{ stdout?: string; stderr?: string }>(connection, fetchFn, "read", "GetStackLog", { stack: name, services: [], tail })
                : await call<{ stdout?: string; stderr?: string }>(connection, fetchFn, "read", "GetDeploymentLog", { deployment: name, tail });
        return { stdout: log.stdout ?? "", stderr: log.stderr ?? "" };
    },
    execute: async (operation, params) => {
        // Execute's Update record isn't read; the view refetches the overview for the authoritative answer.
        await call(connection, fetchFn, "execute", operation, params);
    },
});
