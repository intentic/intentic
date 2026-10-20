import { z } from "zod";
import { FlyError, flyRequest, isFlyOk } from "./fly.js";

// Fly's managed Prometheus, read with the same org token as the Machines API (sent in its own FlyV1 scheme, see fly.ts): one instant query, answered per machine.
// `instance` in Fly's labels is the machine id, which is what tells a sandbox's machine from a builder in the same app.

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
    const response = await flyRequest(url, {
        method: `GET`,
        token: metrics.flyApiToken,
        scheme: `native`,
        unanswered: {
            timedOut: (seconds) => `Fly's metrics API did not answer within ${seconds}s`,
            unreachable: (detail) => `Fly's metrics API could not be reached: ${detail}`,
        },
    });
    if (!isFlyOk(response)) {
        throw new FlyError(`Fly's metrics API answered HTTP ${response.status} for ${promql}`, response.status);
    }
    const parsed = vectorSchema.safeParse(response.json);
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
