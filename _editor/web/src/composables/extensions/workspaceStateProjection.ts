import { type AccessEntry, AccessEntrySchema, groupOf, type ResourceView, type WorkspaceState } from "@intentic-app/api-contract";

/* Shapes the infrastructure read-model from the sandbox's desired-state graph (desired-state.json, the
 * compiled deploy.config.ts) joined with the last reconcile result (status.json), read directly from the
 * daemon's git file routes and projected locally. Shared by the infrastructure + live-status extensions
 * (ported from the retired infra operator panel). */

// The slice of @intentic/graph's DesiredStateGraph this projection reads, inlined so the web app needs no
// dependency on the graph package (the compiled desired-state.json matches this shape).
interface ResourceNode {
    readonly id: string;
    readonly type: string;
    readonly inputs: Record<string, unknown>;
    readonly dependsOn: readonly string[];
}
interface DesiredStateGraph {
    readonly version: number;
    readonly resources: Record<string, ResourceNode>;
}

// status.json has no named type in @intentic, the CLI writes it as `unknown`, so the slice we read is local.
interface StatusStep {
    readonly id: string;
    readonly action: string;
    readonly reason?: string;
}
interface Status {
    readonly converged?: boolean;
    readonly iterations?: number;
    readonly steps?: readonly StatusStep[];
    readonly access?: readonly unknown[];
}

// Keep only non-secret scalar inputs; $ref/$secret objects, arrays and nested objects are dropped.
const scalarConfig = (inputs: Record<string, unknown>): Record<string, string | number | boolean> => {
    const config: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(inputs)) {
        if (typeof value === `string` || typeof value === `number` || typeof value === `boolean`) {
            config[key] = value;
        }
    }
    return config;
};

// The service's public URL when the node carries a plain `domain`/`hostname` input; undefined otherwise.
const urlOf = (inputs: Record<string, unknown>): string | undefined => {
    const domain = inputs[`domain`] ?? inputs[`hostname`];
    return typeof domain === `string` && domain !== `` ? `https://${domain}` : undefined;
};

// Build the render model from the parsed graph + status (either may be absent / not resolved yet → empty
// state, which the UI shows as a "provision your infrastructure" prompt).
export const projectWorkspaceState = (graphRaw: unknown, statusRaw: unknown): WorkspaceState => {
    const graph = graphRaw as DesiredStateGraph | undefined;
    if (graph === undefined || graph.version !== 1 || typeof graph.resources !== `object`) {
        return { resources: [] };
    }
    const status = statusRaw as Status | undefined;
    const steps = new Map<string, StatusStep>();
    for (const step of status?.steps ?? []) {
        steps.set(step.id, step);
    }
    // oxlint-disable-next-line oxc/no-map-spread -- builds a fresh immutable ResourceView per node; the conditional url spread creates a new object, not an in-place mutation
    const resources: ResourceView[] = Object.values(graph.resources).map((node) => {
        const url = urlOf(node.inputs);
        const step = steps.get(node.id);
        return {
            id: node.id,
            type: node.type,
            title: node.id,
            group: groupOf(node.type),
            ...(url !== undefined ? { url } : {}),
            dependsOn: [...node.dependsOn],
            config: scalarConfig(node.inputs),
            status: step?.action ?? `unknown`,
            ...(step?.reason ? { reason: step.reason } : {}),
        };
    });
    // status.json's value-free access entries (a stale pre-access status simply has none).
    const access: AccessEntry[] = (status?.access ?? []).flatMap((entry) => {
        const parsed = AccessEntrySchema.safeParse(entry);
        return parsed.success ? [parsed.data] : [];
    });
    return {
        resources,
        ...(typeof status?.converged === `boolean` ? { converged: status.converged } : {}),
        ...(typeof status?.iterations === `number` ? { iterations: status.iterations } : {}),
        ...(access.length > 0 ? { access } : {}),
    };
};
