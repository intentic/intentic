import type { DeviceFlowLine } from "@intentic/sandbox-contract/schemas/devices";
import { Frames } from "@intentic/contract-serve";
import { forgetDemoLinks, removeDemoSandbox, setDemoSandboxRunning } from "../../fixture/devices";
import { connectLines, redeem, STEPS_TO_CHECK_IN } from "../../world/machines";
import { addDemoRunner, forgetRunner } from "./peers";

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
// What `ic runner up` streams (runner.rs): the setup's own phase markers, docker's pull, and the parent's approved overlay
// built by BuildKit, so the runners list draws a runner being added from the words a real machine sends.
const RUNNER_UP_LINES = (name: string): string[] => [
    `intentic: starting runner ${name}…`,
    `intentic: [pulling-image] pulling sandbox image ghcr.io/intentic/sandbox:stable (first run can take a minute)…`,
    `stable: Pulling from intentic/sandbox`,
    ...LAYERS.map((layer) => `${layer}: Already exists`),
    `Status: Image is up to date for ghcr.io/intentic/sandbox:stable`,
    `intentic: [building-environment] building intentic-sandbox-env-runner-${name}:1f4c9ab2d0e3 from the parent's approved overlay…`,
    `#5 [1/3] FROM ghcr.io/intentic/sandbox:stable`,
    `#6 [2/3] RUN apt-get update && apt-get install -y postgresql-client`,
    `#6 3.912 Setting up postgresql-client-16 (16.4-1) ...`,
    `#6 DONE 6.1s`,
    `#7 [3/3] RUN npx playwright install --with-deps chromium`,
    `#7 DONE 21.4s`,
    `#8 exporting to image`,
    `#8 DONE 2.3s`,
    `intentic: [starting-sandbox] starting runner ${name}…`,
    `intentic: [waiting-health] waiting for the runner daemon to come up…`,
    `intentic: Runner ${name} is up and enrolling with https://sandbox-demo.sbx.intentic.dev.`,
];
// The machine's own sentence at the end of a runner op (_devices/machine/src/device/tools/sandboxes.ts).
const RUNNER_DONE = {
    "runner-up": (name: string) => `Runner "${name}" is up on this device and pairing with the sandbox that asked for it.`,
    "runner-remove": (name: string) => `Removed runner "${name}". Its work lives in the parent sandbox's git, so nothing was lost with it.`,
} as const satisfies Record<string, (name: string) => string>;
const isRunnerOp = (op: string): op is keyof typeof RUNNER_DONE => Object.hasOwn(RUNNER_DONE, op);

const flowLines = (slug: string, op: string): string[] => {
    switch (op) {
        case `runner-up`:
            return RUNNER_UP_LINES(slug);
        case `runner-remove`:
            return [`intentic: Removing runner-${slug}…`, `intentic: Removed runner-${slug}.`];
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

// `create` with a setup code: the machine runs `ic sandbox connect`, each line after its own pause, and the sandbox it
// makes redeems the code at the line that says so and announces itself as a real one would (world/machines.ts), which is
// what Add sandbox waits on and its progress reads step by step. The editor opens the new sandbox the moment it checks
// in, so its reports are paced to check in just after the last line: every step of the progress is seen to finish first.
const CHECK_IN_AFTER_MS = 700;

const createFlow = (slug: string, setupCode: string): Frames<DeviceFlowLine> =>
    new Frames((sink) => {
        const lines = connectLines(slug, setupCode);
        const claim = lines.findIndex((line) => line.claims === true);
        const sum = (upTo: number): number => lines.slice(0, upTo).reduce((ms, line) => ms + line.afterMs, 0);
        const every = (sum(lines.length) - sum(claim + 1) + CHECK_IN_AFTER_MS) / STEPS_TO_CHECK_IN;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const next = (step: number): void => {
            const line = lines[step];
            if (line === undefined) {
                setDemoSandboxRunning(slug, true);
                sink.emit({ kind: `result`, message: `Created sandbox "${slug}" and connected it to your account.` });
                sink.close();
                return;
            }
            timer = setTimeout(() => {
                if (line.claims === true) {
                    redeem(setupCode, every);
                }
                sink.emit({ kind: `line`, text: line.text });
                next(step + 1);
            }, line.afterMs);
        };
        next(0);
        return () => clearTimeout(timer);
    });

// A runner op lands in the runners list (peers.ts) on the machine it was asked of, `host`.
export const sandboxFlow = (slug: string, op: string, setupCode?: string, host?: string): Frames<DeviceFlowLine> =>
    op === `create` && setupCode !== undefined ? createFlow(slug, setupCode) : paced({
        lines: flowLines(slug, op),
        result: isRunnerOp(op) ? RUNNER_DONE[op](slug) : `${SANDBOX_DONE[op] ?? `Ran ${op} on`} sandbox "${slug}".`,
        after: () => {
            if (op === `runner-up` && host !== undefined) {
                addDemoRunner(slug, host);
            } else if (op === `runner-remove`) {
                forgetRunner(slug);
            } else if (op === `start` || op === `restart` || op === `update` || op === `rollback`) {
                setDemoSandboxRunning(slug, true);
            } else if (op === `stop`) {
                setDemoSandboxRunning(slug, false);
            } else if (op === `remove`) {
                removeDemoSandbox(slug);
            }
        },
    });
