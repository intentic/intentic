import type { DeployAlert, DeployResource, DeployServer, DeployState } from "../contract.js";
import type { KomodoAlert, KomodoDeploymentInfo, KomodoListItem, KomodoServerInfo, KomodoStackInfo, KomodoStackService } from "./komodo-client.js";

/* Komodo's vocabulary → the view's. Pure functions over already-fetched data, so the mapping is testable
 * without a Komodo: the routes do the I/O, this does the translation, and the extension does the attention
 * model on top of what comes out.
 *
 * The whole file is written to survive a Komodo upgrade. Every field is read defensively and every unknown
 * word falls through to a defined answer rather than throwing, because the failure mode we care about is the
 * one where a new enum variant blanks an operator's board during an incident. */

// Komodo's deep links, from its own `usableResourcePath`: the lowercase plural, then the resource id.
const resourceUrl = (baseUrl: string, path: string, id: string): string => `${baseUrl}/${path}/${id}`;

/* Eleven state words across DeploymentState and StackState, onto five.
 *
 * `stopped` deliberately swallows exited: a container that exited could have crashed or been stopped on
 * purpose, and Komodo's own status prose ("Exited (1) 20 minutes ago") is the only thing that knows which.
 * Guessing from the exit code here would put a red chip on every deliberately-stopped resource — a LEVEL that
 * is lit forever, which is the exact failure ciStreaks was written to avoid. What says a running thing stopped
 * is the alert log, and that is an edge.
 *
 * `unhealthy` is the breakage a chip may carry on its own: restarting (a crash loop is never intentional),
 * dead, unhealthy. */
const STATE: Record<string, DeployState> = {
    running: "running",
    deploying: "deploying",
    stopping: "deploying",
    removing: "deploying",
    exited: "stopped",
    stopped: "stopped",
    down: "stopped",
    paused: "stopped",
    created: "stopped",
    not_deployed: "stopped",
    restarting: "unhealthy",
    dead: "unhealthy",
    unhealthy: "unhealthy",
};

export const deployState = (state: string | undefined): DeployState => (state === undefined ? "unknown" : (STATE[state] ?? "unknown"));

const service = (raw: KomodoStackService): { name: string; image: string; updateAvailable: boolean } => ({
    name: raw.service ?? "",
    image: raw.image ?? "",
    updateAvailable: raw.update_available === true,
});

export const deploymentResource = (baseUrl: string, item: KomodoListItem<KomodoDeploymentInfo>): DeployResource => ({
    kind: "deployment",
    id: item.id,
    name: item.name,
    state: deployState(item.info.state),
    ...(item.info.status !== undefined ? { status: item.info.status } : {}),
    ...(item.info.server_name !== undefined ? { server: item.info.server_name } : {}),
    ...(item.info.image !== undefined ? { image: item.info.image } : {}),
    updateAvailable: item.info.update_available === true,
    services: [],
    url: resourceUrl(baseUrl, "deployments", item.id),
});

export const stackResource = (baseUrl: string, item: KomodoListItem<KomodoStackInfo>): DeployResource => {
    const services = (item.info.services ?? []).map(service);
    return {
        kind: "stack",
        id: item.id,
        name: item.name,
        state: deployState(item.info.state),
        ...(item.info.status !== undefined ? { status: item.info.status } : {}),
        ...(item.info.server_name !== undefined ? { server: item.info.server_name } : {}),
        updateAvailable: services.some((entry) => entry.updateAvailable),
        services,
        url: resourceUrl(baseUrl, "stacks", item.id),
    };
};

// ServerState is Ok | NotOk | Disabled; anything else reads as unreachable, which is the safe direction — a
// state we cannot interpret must not be drawn as healthy.
const serverState = (state: string | undefined): DeployServer["state"] => {
    if (state === "Ok") {
        return "ok";
    }
    return state === "Disabled" ? "disabled" : "unreachable";
};

// Komodo reports memory and disk in GB, not as percentages; cpu already is one. A zero total means "no stats"
// rather than "100% full", so it yields undefined and the gauge simply doesn't render.
const percent = (used: number | undefined, total: number | undefined): number | undefined =>
    used === undefined || total === undefined || total <= 0 ? undefined : Math.round((used / total) * 100);

export const serverEntry = (baseUrl: string, item: KomodoListItem<KomodoServerInfo>): DeployServer => {
    const stats = item.info.stats;
    const cpu = stats?.cpu_perc;
    const mem = percent(stats?.mem_used_gb, stats?.mem_total_gb);
    const disk = percent(stats?.disk_used_gb, stats?.disk_total_gb);
    return {
        id: item.id,
        name: item.name,
        state: serverState(item.info.state),
        ...(cpu !== undefined ? { cpuPercent: Math.round(cpu) } : {}),
        ...(mem !== undefined ? { memPercent: mem } : {}),
        ...(disk !== undefined ? { diskPercent: disk } : {}),
        url: resourceUrl(baseUrl, "servers", item.id),
    };
};

const LEVEL: Record<string, DeployAlert["level"]> = { OK: "ok", WARNING: "warning", CRITICAL: "critical" };

// Every AlertData variant names its subject the same two ways when it has them — `name` for the resource and
// `server_name` for its host — so one reader serves ContainerStateChange, ServerUnreachable, BuildFailed and
// every variant Komodo adds next. A variant carrying neither still produces an alert; it just goes unnamed,
// which is a far better outcome during an incident than being dropped.
const text = (data: Record<string, unknown> | undefined, key: string): string | undefined => {
    const value = data?.[key];
    return typeof value === "string" && value !== "" ? value : undefined;
};

// Bracket access because the field is mongo's `_id` and the repo forbids dangling underscores in member
// expressions — the same spelling _deploy/providers' Komodo client already uses for this exact field.
const alertId = (raw: KomodoAlert, index: number): string => {
    const id = raw["_id"];
    if (typeof id === "string") {
        return id;
    }
    // Komodo serializes the mongo id as {$oid}; an alert with neither still needs a stable list key, and its
    // open timestamp plus position is unique enough for one response.
    return id?.$oid ?? `${raw.ts ?? 0}-${index}`;
};

export const deployAlert = (raw: KomodoAlert, index: number): DeployAlert => {
    const data = raw.data?.data;
    const resource = text(data, "name");
    const server = text(data, "server_name");
    const from = text(data, "from");
    const to = text(data, "to");
    return {
        id: alertId(raw, index),
        // The raw variant tag. A variant we have not met is exactly the one worth surfacing, so it passes
        // through unmapped rather than collapsing into an "other" the view cannot reason about.
        type: raw.data?.type ?? "Unknown",
        level: LEVEL[raw.level ?? ""] ?? "warning",
        resolved: raw.resolved === true,
        ts: raw.ts ?? 0,
        ...(resource !== undefined ? { resource } : {}),
        ...(server !== undefined ? { server } : {}),
        ...(from !== undefined ? { from } : {}),
        ...(to !== undefined ? { to } : {}),
    };
};

// Newest first — the same order every list on this surface uses, and the order an operator reads an incident
// log in.
export const deployAlerts = (raw: readonly KomodoAlert[]): DeployAlert[] =>
    raw.map((alert, index) => deployAlert(alert, index)).toSorted((a, b) => b.ts - a.ts);
