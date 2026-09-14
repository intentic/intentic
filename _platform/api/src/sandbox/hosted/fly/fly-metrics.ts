import { z } from "zod";
import { FlyError } from "./fly.js";

// Fly's managed Prometheus, read with the same org token as the Machines API: one instant query, answered per machine.
// `instance` in Fly's labels is the machine id, which is what tells a sandbox's machine from a builder in the same app.

const METRICS_TIMEOUT_MS = 30_000;

const vectorSchema = z.object({
    status: z.literal(`success`),
    data: z.object({
        resultType: z.literal(`vector`),
        result: z.array(z.object({ metric: z.record(z.string(), z.string()), value: z.tuple([z.number(), z.string()]) })),
    }),
});

export interface MachineSample {
    readonly app: string;
    readonly machineId: string;
    readonly value: number;
}

export const queryMachineMetric = async (
    metrics: { readonly metricsUrl: string; readonly flyOrg: string; readonly flyApiToken: string },
    promql: string,
): Promise<MachineSample[]> => {
    const url = `${metrics.metricsUrl.replace(/\/$/, ``)}/${encodeURIComponent(metrics.flyOrg)}/api/v1/query?query=${encodeURIComponent(promql)}`;
    let response: Response;
    try {
        response = await fetch(url, { headers: { authorization: `Bearer ${metrics.flyApiToken}` }, signal: AbortSignal.timeout(METRICS_TIMEOUT_MS) });
    } catch (error) {
        throw new FlyError(`Fly's metrics API could not be reached: ${error instanceof Error ? error.message : `transport failure`}`);
    }
    if (!response.ok) {
        throw new FlyError(`Fly's metrics API answered HTTP ${response.status} for ${promql}`, response.status);
    }
    const parsed = vectorSchema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) {
        throw new FlyError(`Fly's metrics API answered an unexpected shape for ${promql}`);
    }
    return parsed.data.data.result.flatMap((sample) => {
        const app = sample.metric[`app`];
        const machineId = sample.metric[`instance`];
        const value = Number(sample.value[1]);
        return app === undefined || machineId === undefined || !Number.isFinite(value) ? [] : [{ app, machineId, value }];
    });
};
