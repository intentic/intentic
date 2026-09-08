import {
    type Device,
    type DeviceAgentOp,
    type DeviceCommand,
    type DeviceCommandResult,
    type DeviceSandboxFlowInput,
    type DeviceSandboxOp,
    type SandboxResourcesAsk,
    DevicesListSchema,
    DeviceCommandResultSchema,
    SyncStatusSchema,
} from "@intentic/sandbox-contract";
import { computed, type ComputedRef, type Ref } from "vue";
import { sandboxError, sandboxJson, sandboxRequest } from "../client/sandboxClient";
import { readIntenticLines } from "../../../lib/intenticStream";
import { DEVICES, SYNC_HEALTH } from "../../../lib/queryKeys";
import { useSandboxQuery } from "../client/useSandboxQuery";

// Devices the daemon can see, merging both report paths (see hosts/device-reports.ts). Polled, not pushed:
// state is a snapshot cached by the daemon between polls, so an idle tab costs nothing extra.

const QUERY_KEY = DEVICES.of();
const POLL_MS = 10_000;

// Callers opt into polling; a non-polling reader still gets the shared cache, refreshed once on mount.
export function useDevices({ poll = true }: { poll?: boolean } = {}): {
    devices: ComputedRef<Device[]>;
    error: ComputedRef<string | undefined>;
    isLoading: Ref<boolean>;
    refetch: () => void;
} {
    const { query, error } = useSandboxQuery({
        queryKey: QUERY_KEY,
        queryFn: async () => DevicesListSchema.parse(await sandboxJson(`/system/devices`)),
        refetchInterval: poll ? POLL_MS : false,
    });
    return {
        devices: computed(() => query.data.value?.devices ?? []),
        error,
        // True only for the first fetch; a refetch must never blank an already-populated list.
        isLoading: query.isLoading,
        refetch: () => void query.refetch(),
    };
}

// One string field from a loosely-parsed stream frame, or undefined.
const frameText = (line: Record<string, unknown>, key: string): string | undefined => (typeof line[key] === `string` ? line[key] : undefined);

// Payload shared by every device-sandbox op, all issued through one streaming call. `onLine` gets progress
// as it prints; `hash` is rebuild's digest, `resources` is reshape's requested share.
export interface DeviceSandboxPayload {
    hash?: string | undefined;
    resources?: SandboxResourcesAsk | undefined;
    // The short-lived setup code reconnect redeems on the host machine for a drifted container's missing values.
    setupCode?: string | undefined;
    onLine?: ((line: string) => void) | undefined;
}

// hash/resources/setupCode are included only when present; the schema rejects an explicit undefined.
const flowInput = (
    hostId: string,
    slug: string,
    op: DeviceSandboxOp,
    { hash, resources, setupCode }: DeviceSandboxPayload,
): DeviceSandboxFlowInput => ({
    id: hostId,
    slug,
    op,
    ...(hash === undefined ? {} : { hash }),
    ...(resources === undefined ? {} : { resources }),
    ...(setupCode === undefined ? {} : { setupCode }),
});

// A stream ending without a terminal frame means the connection dropped, not that the operation stopped;
// the next fleet read reflects the real outcome.
const outcomeOf = async (body: ReadableStream<Uint8Array>, onLine: ((line: string) => void) | undefined): Promise<string> => {
    let outcome: string | undefined;
    for await (const line of readIntenticLines(body)) {
        if (line[`kind`] === `line`) {
            const text = frameText(line, `text`);
            if (text !== undefined) {
                onLine?.(text);
            }
            continue;
        }
        if (line[`kind`] === `error`) {
            throw new Error(frameText(line, `message`) ?? `That operation failed on the device.`);
        }
        if (line[`kind`] === `result`) {
            outcome = frameText(line, `message`) ?? outcome;
        }
    }
    if (outcome === undefined) {
        throw new Error(`Lost contact with that device while this was running: it may still have finished. Refresh to see where it got to.`);
    }
    return outcome;
};

export async function manageDeviceSandbox(hostId: string, slug: string, op: DeviceSandboxOp, payload: DeviceSandboxPayload = {}): Promise<string> {
    const response = await sandboxRequest(`/system/devices/${encodeURIComponent(hostId)}/sandboxes/${encodeURIComponent(slug)}`, {
        method: `POST`,
        headers: { "content-type": `application/json` },
        body: JSON.stringify(flowInput(hostId, slug, op, payload)),
    });
    if (!response.ok || !response.body) {
        throw await sandboxError(response, { method: `POST`, path: `/system/devices/{id}/sandboxes/{slug}` });
    }
    return outcomeOf(response.body, payload.onLine);
}

// Update/restart kills the process serving the request, so an untimely stream end here is success, not
// manageDeviceSandbox's lost-connection case. `settled` only says a result frame arrived; the agent version
// on the next poll is the real answer.
export async function runDeviceAgentFlow(
    hostId: string,
    op: DeviceAgentOp,
    { onLine }: { onLine?: (line: string) => void } = {},
): Promise<{ message: string | undefined; settled: boolean }> {
    const response = await sandboxRequest(`/system/devices/${encodeURIComponent(hostId)}/agent/${encodeURIComponent(op)}`, {
        method: `POST`,
        headers: { "content-type": `application/json` },
        body: JSON.stringify({ id: hostId, op }),
    });
    if (!response.ok || !response.body) {
        throw await sandboxError(response, { method: `POST`, path: `/system/devices/{id}/agent/{op}` });
    }
    let message: string | undefined;
    for await (const line of readIntenticLines(response.body)) {
        if (line[`kind`] === `line`) {
            const text = frameText(line, `text`);
            if (text !== undefined) {
                onLine?.(text);
            }
            continue;
        }
        // An `error` frame means the device refused (its switch off, or its agent too old), not a dropped connection.
        if (line[`kind`] === `error`) {
            throw new Error(frameText(line, `message`) ?? `That device wouldn't update its agent.`);
        }
        if (line[`kind`] === `result`) {
            message = frameText(line, `message`) ?? message;
        }
    }
    return { message, settled: message !== undefined };
}

// Runs one device CLI action by a closed-set name; the daemon builds the argv (hosts/device-commands.ts),
// never forwarding free text. `ok: false` is the device's own refusal as a result; only an unreachable
// device rejects the promise.
export async function runDeviceCommand(hostId: string, command: DeviceCommand, sandboxId?: string): Promise<DeviceCommandResult> {
    const path = `/system/devices/${encodeURIComponent(hostId)}/commands/${encodeURIComponent(command)}`;
    const response = await sandboxRequest(path, {
        method: `POST`,
        headers: { "content-type": `application/json` },
        body: JSON.stringify({ id: hostId, command, ...(sandboxId === undefined ? {} : { sandboxId }) }),
    });
    if (!response.ok) {
        throw await sandboxError(response, { method: `POST`, path: `/system/devices/{id}/commands/{command}` });
    }
    return DeviceCommandResultSchema.parse(await response.json());
}

// Revokes one device's desktop-sync key without touching others' enrollment. Drops it from
// authorized_keys; the device notices on its next poll and stops mirroring itself.
export async function revokeSyncDevice(machine: string): Promise<void> {
    const response = await sandboxRequest(`/system/authorized-key/${encodeURIComponent(machine)}`, { method: `DELETE` });
    if (!response.ok) {
        throw await sandboxError(response, { method: `DELETE`, path: `/system/authorized-key/{machine}` });
    }
}

// The connected, online device running a given sandbox slug, if any (a sync-only agent never reports
// containers). Shares the Devices query without polling it itself.
export function useHostRunning(slug: () => string | undefined): ComputedRef<string | undefined> {
    const { devices } = useDevices({ poll: false });
    return computed(() => {
        const target = slug();
        if (target === undefined || target === ``) {
            return undefined;
        }
        return devices.value.find(
            (device) =>
                device.hostId !== undefined && device.online === true && (device.report?.sandboxes ?? []).some((box) => box.slug === target),
        )?.hostId;
    });
}

// Past this, a device is treated as gone quiet rather than merely between reports.
const REPORT_STALE_MS = 60_000;

export const reportStale = (device: Device, now: number): boolean =>
    device.report !== undefined && now - device.report.capturedAt > REPORT_STALE_MS;

// Reads /system/sync, not /system/devices, to avoid polling every laptop just to draw a badge.
const HEALTH_POLL_MS = 60_000;

export function useSyncHealth(): { stoppedOn: ComputedRef<string[]>; contendedPorts: ComputedRef<number[]> } {
    const { query } = useSandboxQuery({
        queryKey: SYNC_HEALTH.of(),
        queryFn: async () => SyncStatusSchema.parse(await sandboxJson(`/system/sync`)),
        refetchInterval: HEALTH_POLL_MS,
    });
    const machines = computed(() => query.data.value?.machines ?? []);
    return {
        // Machines whose sync watcher has stopped, though other signals still read healthy.
        stoppedOn: computed(() => machines.value.filter((report) => !report.agent.running).map((report) => report.hostname)),
        // Ports this sandbox serves that never reached localhost because another paired sandbox already holds them.
        contendedPorts: computed(() => [
            ...new Set(machines.value.flatMap((report) => report.ports.filter((port) => port.state !== `mirrored`).map((port) => port.port))),
        ]),
    };
}
