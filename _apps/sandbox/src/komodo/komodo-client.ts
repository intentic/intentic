import type { CapabilitiesStore } from "../capabilities/capabilities-store.js";

/* The Komodo Core API behind one client shape, authenticated with an API key PAIR (`x-api-key` +
 * `x-api-secret`) resolved per call from the `komodo` cli capability the route names.
 *
 * WHY THIS IS NOT _libs/providers/src/komodo/komodo-api.ts. That one is the deploy ENGINE's client: it mints a
 * JWT by logging in as the local admin the engine itself provisioned, and its surface is deployment
 * reconciliation. This one serves a connection the USER made to a Komodo we know nothing about, with a
 * credential they pasted, and its surface is read + execute. Two different callers, two different auth
 * stories; sharing them would mean one module that logs in OR carries keys depending on who called it.
 *
 * `fetch` is injectable for tests, the CiClient/git-access precedent. Failures throw with Komodo's own status
 * and body tail — the caller decides whether that means "unreachable" (the overview, which degrades) or a
 * BAD_GATEWAY (the actions, where the vendor's words are the whole point). */

export type FetchFn = typeof fetch;

// Komodo's own env var names, which are also this connector's (see _extensions/connectors).
export interface KomodoConnection {
    readonly capability: string;
    // No trailing slash — every path below is joined with one.
    readonly baseUrl: string;
    readonly apiKey: string;
    readonly apiSecret: string;
}

const BODY_TAIL = 300;
// Bound a stalled connection: undici's default headers timeout is ~5 minutes, and a hung Komodo must read as
// unreachable within the view's own patience, not hold a request open past it.
const TIMEOUT_MS = 15_000;

// The `komodo` cli capabilities currently connected, newest-manifest-order. The rail renders one tile per
// entry, so this is also what decides how many Deployments tiles exist.
export const komodoConnections = async (capabilities: CapabilitiesStore): Promise<KomodoConnection[]> =>
    (await capabilities.list()).flatMap((capability) => {
        if (capability.kind !== "cli" || capability.config.provider !== "komodo") {
            return [];
        }
        const { url, apiKey, apiSecret } = capability.config;
        // A half-filled capability (added before the schema validated, or hand-edited) is skipped rather than
        // throwing: one bad entry costs itself, the capabilities-store rule.
        if (url === undefined || apiKey === undefined || apiSecret === undefined) {
            return [];
        }
        return [{ capability: capability.id, baseUrl: url.replace(/\/+$/, ""), apiKey, apiSecret }];
    });

export const komodoConnectionFor = async (capabilities: CapabilitiesStore, capability: string): Promise<KomodoConnection | undefined> =>
    (await komodoConnections(capabilities)).find((connection) => connection.capability === capability);

// POST {module}/{Operation} with a bare `{params}` body — the form Komodo's own TS client uses. (Core also
// accepts POST /read with a {type, params} envelope; the path form keeps the operation visible in a stack
// trace and in any proxy log.)
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
            "x-api-key": connection.apiKey,
            "x-api-secret": connection.apiSecret,
        },
        body: JSON.stringify({ params }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`Komodo ${module}/${operation} failed (${response.status}): ${body.slice(0, BODY_TAIL)}`);
    }
    return response.json() as Promise<T>;
};

/* The raw shapes we consume, named as Komodo names them. Read loosely on purpose: every list item is
 * `{id, name, info}` with a per-type `info`, and Komodo adds fields to `info` release over release. Typing
 * only what we read (and leaving the rest to pass through unread) is what keeps a Komodo upgrade from
 * emptying this view — the alternative, a strict schema, turns every new field into an outage. */

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

// Komodo serializes an alert's mongo id as `{_id: {$oid}}` or a bare string depending on the path; both are
// read, and an alert with neither still renders (its id only keys a list).
export interface KomodoAlert {
    readonly _id?: { readonly $oid?: string } | string;
    readonly ts?: number;
    readonly resolved?: boolean;
    readonly level?: string;
    readonly target?: { readonly type?: string; readonly id?: string };
    readonly data?: { readonly type?: string; readonly data?: Record<string, unknown> };
}

export interface KomodoClient {
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
        // Execute returns an Update record describing the run; only the status matters here — the view
        // refetches the overview, which is the authoritative answer to "did it work".
        await call(connection, fetchFn, "execute", operation, params);
    },
});
