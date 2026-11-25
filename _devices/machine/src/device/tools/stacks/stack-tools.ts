import type { DeviceScopes } from "@intentic/sandbox-contract/schemas/capabilities";
import { DeployStackToolArgsSchema, STACK_LOG_TAIL_DEFAULT, STACK_LOG_TAIL_MAX, StackNameSchema, StackOpSchema } from "@intentic/sandbox-contract/schemas/device-stacks";
import { type McpTool, textResult, tool } from "@intentic/sandbox-contract/peer-mcp-server";
import { z } from "zod";
import { deployStack } from "./deploy.js";
import { hostStats } from "./host-stats.js";
import { listStacks, stackAction, stackLogs } from "./stacks.js";

// The stack tools as the device serves them (stacks.ts, deploy.ts, host-stats.ts); `caller` is the sandbox the call came
// from, whose pushed builds alone a deploy may copy, and which owns every stack it deploys.
export const stackTools = (caller: () => string): McpTool<DeviceScopes>[] => [
    tool({
        name: "list_stacks",
        description:
            "The Docker compose stacks on this device, as JSON: `root`, the folder deploy_stack puts stacks in, and for each compose project, running or stopped, its name, compose's status, the compose files it was started from, its working folder, whether a deploy put it in `root` (`managed`), on a managed stack the sandbox that deployed it (`owner`: `sandbox`, and `you` when that is the sandbox asking; absent on one deployed before owners were recorded), whether it is an Intentic sandbox's own (`sandbox`: list_sandboxes and manage_sandbox drive those, not these tools), and each service's container, image, state, status and health. Reads `docker compose ls` and `docker ps` and changes nothing. A device without Docker, or whose Docker does not answer, is an error in Docker's own words, never an empty list. Requires the 'Run commands' permission.",
        effect: "read",
        input: z.object({}),
        run: async (_args, scopes) => textResult(await listStacks(scopes, caller())),
    }),
    tool({
        name: "stack_action",
        description:
            "Drive one compose stack on this device by its name from list_stacks, and answer with what compose printed. `up` applies its compose files as they are (`docker compose up -d --remove-orphans`, which also removes the containers of services no longer in them), `pull` fetches newer images and then does the same, `restart`, `start` and `stop` act on its containers. A managed stack runs with the registry logins its last deploy left for it. `up` and `pull` need the compose files the stack was started from and are refused once those are gone; an Intentic sandbox's own project is refused, since manage_sandbox drives those, and so is a stack another sandbox deployed. Nothing here takes a stack down or deletes a volume: `down` and `-v` are the owner's to run. Requires the 'Run commands' permission.",
        effect: "write",
        input: z.object({
            name: StackNameSchema.describe("The stack's name, from list_stacks."),
            op: StackOpSchema.describe("up, pull (newer images, then up), restart, start or stop."),
        }),
        run: async ({ name, op }, scopes) => textResult(await stackAction(name, op, scopes, caller())),
    }),
    tool({
        name: "stack_logs",
        description:
            "The end of one compose stack's logs on this device, every service's lines together (`docker compose logs --tail`), by its name from list_stacks. A stack another sandbox deployed is refused. Read-only. Requires the 'Run commands' permission.",
        effect: "read",
        input: z.object({
            name: StackNameSchema.describe("The stack's name, from list_stacks."),
            tail: z
                .int()
                .positive()
                .max(STACK_LOG_TAIL_MAX)
                .optional()
                .describe(`How many lines from the end of each service's log. Default ${STACK_LOG_TAIL_DEFAULT}, maximum ${STACK_LOG_TAIL_MAX}.`),
        }),
        run: async ({ name, tail }, scopes) => textResult(await stackLogs(name, tail, scopes, caller())),
    }),
    tool({
        name: "deploy_stack",
        description:
            "Deploy a repository this sandbox pushed to this device as a compose stack: copy the pushed folder (`source`, the path the push answered with; any other folder is refused) into `<root>/<name>` (root from list_stacks), record the commit and this sandbox as the stack's owner there in .intentic-deploy.json, and run `docker compose -p <name> -f <composeFile> up -d --build --remove-orphans` in that folder; the whole deploy has 14 minutes. The copy adds and overwrites files and deletes nothing already in the folder (a service's data may live there); a .env is never copied from the repository. A path whose kind differs between the folder and the repository, a name another compose project on this device already runs under, and a stack another sandbox deployed are refused before anything is written. The managed fields, sent by a sandbox for a stack its repository's stacks manifest declares: `env`, the whole .env, written 0600 (a .env already there that no deploy wrote, or that was edited since, is refused and never overwritten; without `env` a .env there is left as it is); `mode` `images` to pull and then `up` without building; `registries`, logins kept in the stack's own docker config (.intentic-stack/docker, handed to compose as DOCKER_CONFIG, never the machine's); `hooks.preDeploy`, run by the shell (sh -c; PowerShell on Windows) in the stack's folder with COMPOSE_PROJECT_NAME and COMPOSE_FILE set, after the files are in place and before compose, its failure stopping the deploy; `health`, waiting until every container runs (none restarting, each healthcheck healthy, a one-shot service exited 0) and each URL answers 2xx; `hooks.postDeploy`, run once healthy; `pins`, service → image laid over the compose file (.intentic-stack/pins.yaml); `adopt`, taking over a compose project of this name that no deploy put here once none of its containers runs. Answers with JSON: `path`, the stack's folder, and `output`, what compose and the hooks printed; a managed deploy adds `digests` (service → the image it runs, pinned), `envDigest` and `healthySeconds`. A failure is an error carrying the output; no secret the deploy carried is ever in an answer. Requires the 'Run commands' and 'Run programs this sandbox sends' permissions.",
        effect: "write",
        input: DeployStackToolArgsSchema,
        run: async (args, scopes) => textResult(await deployStack(args, scopes, caller())),
    }),
    tool({
        name: "host_stats",
        description:
            "How full this device is, as JSON: `disks`, the total and free bytes of the volume Docker keeps its images and volumes on (`docker`, left out when Docker does not answer or its data lives in a VM) and of the one the stacks folder is on (`stacks`); `memory`, total and available bytes (what a new process could have); `load`, the 1, 5 and 15 minute load averages (zeros on Windows); and `cpus`. Changes nothing. Requires the 'Run commands' permission.",
        effect: "read",
        input: z.object({}),
        run: async (_args, scopes) => textResult(await hostStats(scopes)),
    }),
];
