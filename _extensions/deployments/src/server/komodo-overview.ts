import type { DeployAlert, DeployResource, DeployServer, DeployState } from "../contract.js";
import type { KomodoAlert, KomodoDeploymentInfo, KomodoListItem, KomodoServerInfo, KomodoStackInfo, KomodoStackService } from "./komodo-client.js";

// Komodo's vocabulary translated to the view's, as pure functions over already-fetched data, testable without a Komodo.
// Every field is read defensively and every unknown word falls through to a defined answer instead of throwing, since a
// new Komodo enum variant must never blank an operator's board.

// Builds Komodo's own deep link: lowercase plural of the resource kind, then its id.
const resourceUrl = (baseUrl: string, path: string, id: string): string => `${baseUrl}/${path}/${id}`;

// Eleven Komodo states onto five; `exited` maps to `stopped`, only the alert log knows if it crashed.
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

// ServerState is Ok | NotOk | Disabled; anything unrecognized reads as unreachable, the safe direction, never healthy.
const serverState = (state: string | undefined): DeployServer["state"] => {
    if (state === "Ok") {
        return "ok";
    }
    return state === "Disabled" ? "disabled" : "unreachable";
};

// Memory/disk arrive in GB, not percentages (cpu already is one); a zero total means no stats, not "100% full", so the
// gauge just doesn't render.
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

// Every AlertData variant names its subject the same two keys when it has them (`name`, `server_name`), so one reader
// serves every variant. One with neither still produces an alert, just unnamed, rather than being dropped.
const text = (data: Record<string, unknown> | undefined, key: string): string | undefined => {
    const value = data?.[key];
    return typeof value === "string" && value !== "" ? value : undefined;
};

// Bracket access since the field is mongo's `_id`, and dangling underscores are forbidden in member expressions.
const alertId = (raw: KomodoAlert, index: number): string => {
    const id = raw["_id"];
    if (typeof id === "string") {
        return id;
    }
    // Mongo id as `{$oid}`; with neither, timestamp plus index is a stable enough key for one response.
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
        // Raw variant tag passes through unmapped; an unmet variant is exactly the one worth surfacing.
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

// Newest first, the order every list here uses, and the order an operator reads an incident log in.
export const deployAlerts = (raw: readonly KomodoAlert[]): DeployAlert[] =>
    raw.map((alert, index) => deployAlert(alert, index)).toSorted((a, b) => b.ts - a.ts);
