import type { DeviceFlowLine } from "@intentic/sandbox-contract";
import { Frames } from "@intentic/contract-serve";
import { forgetDemoLinks, removeDemoSandbox, setDemoSandboxRunning } from "../fixture/devices";

// A paired machine's verbs, streamed as the machine sends them: progress lines, then its own sentence, paced so a
// press is watchable rather than over before the row has drawn its log.

// One device agent's update or restart, in the frames the real flow sends: `line` for progress, `result` for what the
// machine says at the end. Paced so a press is watchable rather than over before the row has drawn its log.
const AGENT_STEP_MS = 450;

// The machine's own words for each op, as the real agent prints them (_devices/machine/src/device/tools/agent.ts).
const DEAD_LINKS = [`b055ea494d4d`, `d1143f54bc31`, `04d00cfa2fc0`, `52c0a0524bcb`, `db30f83623ad`].map(
    (id) => `https://sandbox-${id}.sbx.intentic.dev`,
);
const agentSaid = (id: string, op: string): { lines: string[]; result: string; after?: () => void } => {
    if (op === `restart`) {
        return { lines: [`Stopping the agent loop on ${id}.`], result: `The agent loop was restarted on this device.` };
    }
    if (op === `forget-unreachable`) {
        return {
            lines: [
                `Dropping this device's links to sandboxes that have stopped answering. The agent closes them on its next pass; this connection stays up.`,
                `Started device forget-unreachable (pid 33844), detached from this connection so it finishes either way. Log: C:\\Users\\ada\\.intentic\\machine\\machine-update.log`,
                `Dropped 5 unreachable links: ${DEAD_LINKS.join(`, `)}.`,
                `Still connected to 2 sandboxes.`,
            ],
            result: `The drop ran on this device. What it removed is in the lines above; this device's link count catches up within a few seconds.`,
            after: forgetDemoLinks,
        };
    }
    return {
        lines: [`Downloading the current agent (1.275.0)…`, `  100% of 87 MB`, `Swapping the binary and restarting the loop.`],
        result: `Already on the current agent (1.275.0). Nothing to do.`,
    };
};

// Lines, then the one terminal frame, paced like a machine that is doing the work.
const paced = (said: { lines: string[]; result: string; after?: () => void }): Frames<DeviceFlowLine> =>
    new Frames((sink) => {
        let step = 0;
        const timer = setInterval(() => {
            const line = said.lines[step];
            if (line !== undefined) {
                sink.emit({ kind: `line`, text: line });
                step += 1;
                return;
            }
            said.after?.();
            sink.emit({ kind: `result`, message: said.result });
            sink.close();
        }, AGENT_STEP_MS);
        return () => clearInterval(timer);
    });

export const agentFlow = (id: string, op: string): Frames<DeviceFlowLine> => paced(agentSaid(id, op));

// A container verb on the demo PC: the power verbs and removal change what the next reading says, the rest answer and
// leave it as it was.
const SANDBOX_DONE: Record<string, string> = {
    start: `Started`,
    stop: `Stopped`,
    restart: `Restarted`,
    update: `Updated`,
    rollback: `Rolled back`,
    remove: `Removed`,
    reshape: `Reshaped`,
};
// What `ic sandbox update` and `rollback` stream, in the order recreate.rs prints it, so the Devices page draws its
// steps from the same words a real machine sends: docker's pull, the read-only pre-flight, the backup, the swap.
const RECREATE_LINES = (slug: string): string[] => [
    `intentic: pre-flighting the state conversions of ghcr.io/intentic/sandbox:stable on this sandbox's data (read-only)…`,
    `intentic: backed up ${slug}'s state before the swap (snapshot 479bdfba).`,
    `intentic: recreating the sandbox from ghcr.io/intentic/sandbox:stable…`,
    `intentic: waiting for the sandbox daemon to come up…`,
];
const LAYERS = [`3f4ca61aafcd`, `9b3a2e4c11d0`, `d5c0f2a8e771`, `5e1b0c9d2f44`, `a07c6d3e8b19`];
const UPDATE_LINES = (slug: string): string[] => [
    `intentic: pulling ghcr.io/intentic/sandbox:stable…`,
    `stable: Pulling from intentic/sandbox`,
    `${LAYERS[0]}: Already exists`,
    ...LAYERS.slice(1).map((layer) => `${layer}: Pulling fs layer`),
    ...LAYERS.slice(1).flatMap((layer) => [`${layer}: Download complete`, `${layer}: Pull complete`]),
    `Digest: sha256:1366a71da67cabd5d9f5c90d3b3a4181d861c7b29decc57cc0201c546317ab60`,
    `Status: Downloaded newer image for ghcr.io/intentic/sandbox:stable`,
    ...RECREATE_LINES(slug),
    `intentic: sandbox updated to ghcr.io/intentic/sandbox:stable (channel stable).`,
    `          Roll back with: ic sandbox rollback ${slug}`,
];
const flowLines = (slug: string, op: string): string[] => {
    switch (op) {
        case `logs`:
            return [`[${slug}] listening on :8080`, `[${slug}] GET /health 200 2ms`];
        case `update`:
            return UPDATE_LINES(slug);
        case `rollback`:
            return [
                `intentic: rolling back to intentic-sandbox-pin-${slug}:1.320.0…`,
                ...RECREATE_LINES(slug),
                `intentic: sandbox rolled back to intentic-sandbox-pin-${slug}:1.320.0 — run rollback again to return.`,
            ];
        default:
            return [`docker ${op} intentic-sandbox-${slug}`];
    }
};

export const sandboxFlow = (slug: string, op: string): Frames<DeviceFlowLine> =>
    paced({
        lines: flowLines(slug, op),
        result: `${SANDBOX_DONE[op] ?? `Ran ${op} on`} sandbox "${slug}".`,
        after: () => {
            if (op === `start` || op === `restart` || op === `update` || op === `rollback`) {
                setDemoSandboxRunning(slug, true);
            } else if (op === `stop`) {
                setDemoSandboxRunning(slug, false);
            } else if (op === `remove`) {
                removeDemoSandbox(slug);
            }
        },
    });
