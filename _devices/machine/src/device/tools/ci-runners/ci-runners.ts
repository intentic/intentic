import type { DeviceScopes } from "@intentic/sandbox-contract/schemas/capabilities";
import {
    CI_RUNNER_LOG_TAIL_DEFAULT,
    CI_RUNNER_LOG_TAIL_MAX,
    CiRunnerNameSchema,
    CiRunnerOpSchema,
    CiRunnerRegisterArgsSchema,
    CiRunnerRemoveArgsSchema,
} from "@intentic/sandbox-contract/schemas/ci-fleet";
import { type McpTool, textResult, tool } from "@intentic/sandbox-contract/peer-mcp-server";
import { z } from "zod";
import { askFleet } from "../../../ci-fleet/client.js";
import { readFleet } from "../../../ci-fleet/fleet.js";
import { assertScope } from "../../policy.js";

/* THE SELF-HOSTED CI RUNNERS ON THIS COMPUTER (schemas/ci-fleet.ts), for the Pipelines view's Runners section and an
   agent fixing a runner the CI fix loop blamed: read here, as this account, and driven through the root fleet service
   (ci-fleet/fleet-service.ts), which alone may start a system unit or register a runner. Linux only: the runners are systemd
   units. Every tool needs "Run commands", the switch a `systemctl` typed here would need. */

// What each ask of the service may take: a unit op waits on the runner's own 30-second shutdown, a registration
// downloads and configures a runner (ci-fleet/register.ts bounds its steps well inside this).
const OP_MS = 150_000;
const LOGS_MS = 45_000;
const REGISTER_MS = 10 * 60_000;

const linuxOnly = (): void => {
    if (process.platform !== "linux") {
        throw new Error("Self-hosted CI runners are read and driven on a Linux computer or a WSL distro (their units are systemd's): ask that side of this computer.");
    }
};

const guarded = (scopes: DeviceScopes): void => {
    assertScope(scopes, "shell");
    linuxOnly();
};

export const ciRunners = async (scopes: DeviceScopes): Promise<string> => {
    guarded(scopes);
    return JSON.stringify(await readFleet());
};

const said = async (request: Parameters<typeof askFleet>[0], timeoutMs: number, scopes: DeviceScopes): Promise<string> => {
    guarded(scopes);
    const answer = await askFleet(request, timeoutMs);
    return answer.said ?? answer.text ?? "";
};

const NAME = CiRunnerNameSchema.describe("The runner's name, from ci_runners.");

export const ciRunnerTools = (): McpTool<DeviceScopes>[] => [
    tool({
        name: "ci_runners",
        description:
            "The self-hosted GitHub Actions runners on this computer, as JSON: each runner's name, systemd unit, folder, account, what it is registered to, version, state (systemd's, or `not-installed` for a runner folder whose unit is gone), whether it is running a job (`busy`, `busySince`, `job`), whether it is held down on purpose (`held`: stopped from here, drained, or paused for a Windows smoke job) or draining; then the fleet service (`service`: running, installed, version, or why it is not answering), the shared cache sizes, the test-memory pool (`slots`) and the last keeper, janitor and host-prune passes. Reads systemd, the process table and the runners' own files; changes nothing. Linux only. Requires the 'Run commands' permission.",
        effect: "read",
        input: z.object({}),
        run: async (_args, scopes) => textResult(await ciRunners(scopes)),
    }),
    tool({
        name: "ci_runner_action",
        description:
            "Start, stop, drain or restart one runner on this computer, through its fleet service, by its name from ci_runners; answers with what was done, in a sentence. `stop` refuses a runner running a job; `drain` stops it the moment its job ends (at once when idle); `restart` is a drain then a start. A runner stopped or drained here stays down (the keeper leaves it) until a `start`. Needs the fleet service (`sudo intentic-machine ci-fleet install`). Requires the 'Run commands' permission.",
        effect: "write",
        input: z.object({ name: NAME, op: CiRunnerOpSchema.describe("start, stop, drain or restart.") }),
        run: async ({ name, op }, scopes) => textResult(await said({ verb: "unit", name, op }, OP_MS, scopes)),
    }),
    tool({
        name: "ci_runner_logs",
        description:
            "The end of one runner's journal on this computer (its listener: connecting, jobs taken and finished, updates, errors), by its name from ci_runners. Read-only. Needs the fleet service, which reads the system journal. Requires the 'Run commands' permission.",
        effect: "read",
        input: z.object({
            name: NAME,
            tail: z
                .int()
                .positive()
                .max(CI_RUNNER_LOG_TAIL_MAX)
                .optional()
                .describe(`How many lines from the end. Default ${CI_RUNNER_LOG_TAIL_DEFAULT}, maximum ${CI_RUNNER_LOG_TAIL_MAX}.`),
        }),
        run: async ({ name, tail }, scopes) => textResult(await said({ verb: "logs", name, tail: tail ?? CI_RUNNER_LOG_TAIL_DEFAULT }, LOGS_MS, scopes)),
    }),
    tool({
        name: "ci_runner_register",
        description:
            "Register a new self-hosted runner on this computer: the fleet service downloads the GitHub Actions runner release this computer's runners already run (else the newest), checks it against the SHA-256 its release notes publish, unpacks it into `<home>/actions-runner-<name>` as the runner's account (`user`, default the account most runners here run as), runs config.sh with `token` (a registration token GitHub minted for `url`, an hour's use; never stored) under `name` and `labels`, then installs and starts its unit. Refuses a name already used here. Requires the 'Run commands' permission.",
        effect: "write",
        input: CiRunnerRegisterArgsSchema,
        run: async (args, scopes) => textResult(await said({ verb: "register", args }, REGISTER_MS, scopes)),
    }),
    tool({
        name: "ci_runner_remove",
        description:
            "Remove a runner from this computer and from GitHub, by its name from ci_runners: refused while it runs a job (drain it first); its unit is stopped and uninstalled, config.sh removes its registration with `token` (a removal token GitHub minted for what it is registered to), and its folder goes into the fleet service's trash. Requires the 'Run commands' permission.",
        effect: "destructive",
        input: CiRunnerRemoveArgsSchema,
        run: async (args, scopes) => textResult(await said({ verb: "deregister", args }, OP_MS, scopes)),
    }),
];
