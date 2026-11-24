import {
    type CiFleet,
    CiFleetSchema,
    type CiRunnerLogs,
    type CiRunnerOpResult,
    type DeviceCiRunnerLogsInput,
    type DeviceCiRunnerOpInput,
} from "@intentic/sandbox-contract/schemas/ci-fleet";
import { DEVICE_FEATURE_CI_RUNNERS } from "@intentic/sandbox-contract/schemas/hosts";
import type { Services } from "../../composition.js";
import { DEVICE_ANSWER_MARGIN_MS } from "../../peers/device-call-deadline.js";
import { type DeviceNeed, deviceClientFor, parsedToolAnswer, relayTool } from "../devices/device-tool-relay.js";

// THE SELF-HOSTED CI RUNNERS ON ONE OF THE OWNER'S COMPUTERS (schemas/ci-fleet.ts), for the Pipelines view's Runners
// section: relayed to the machine's own tools (`ci_runners`, `ci_runner_action`, `ci_runner_logs`,
// `ci_runner_register`, `ci_runner_remove`; src/ci-fleet/ in _devices/machine), which check the computer's switches and
// ask its root fleet service for what needs root. As for compose stacks (../stacks/device-stacks.ts), the daemon refuses
// only what the machine could not answer and passes a refusal on in the machine's words. Adding or removing a runner
// also takes a token GitHub mints, which is the CI layer's (ci/fleet/runner-registration.ts).

// Bounds on waiting for each tool, each past the machine's own bound on the work. A read gets the minute a loaded
// machine needs to answer at all, as a stack list does.
const READ_DEADLINE_MS = 60_000;
// An op waits on systemd, and a stop or a drain on the runner's own 30 s shutdown after its job lets go: three minutes,
// and the time the machine needs to say it gave up.
const OP_DEADLINE_MS = 3 * 60_000 + DEVICE_ANSWER_MARGIN_MS;
/** What every runner tool needs of the computer's agent. */
export const RUNNERS: DeviceNeed = { feature: DEVICE_FEATURE_CI_RUNNERS, to: "read or drive its CI runners" };

/** Every runner on the computer, with its fleet service, caches, test-memory slots and last passes, as `ci_runners` reads them. */
export const deviceCiFleet = async (services: Pick<Services, "hostHub">, id: string): Promise<CiFleet> => {
    deviceClientFor(services, id, [RUNNERS]);
    return parsedToolAnswer(id, "ci_runners", await relayTool(services, id, "ci_runners", {}, READ_DEADLINE_MS), CiFleetSchema);
};

export const deviceCiRunnerOp = async (services: Pick<Services, "hostHub">, input: DeviceCiRunnerOpInput): Promise<CiRunnerOpResult> => {
    deviceClientFor(services, input.id, [RUNNERS]);
    return { said: await relayTool(services, input.id, "ci_runner_action", { name: input.name, op: input.op }, OP_DEADLINE_MS) };
};

export const deviceCiRunnerLogs = async (services: Pick<Services, "hostHub">, input: DeviceCiRunnerLogsInput): Promise<CiRunnerLogs> => {
    deviceClientFor(services, input.id, [RUNNERS]);
    const args = input.tail === undefined ? { name: input.name } : { name: input.name, tail: input.tail };
    return { text: await relayTool(services, input.id, "ci_runner_logs", args, READ_DEADLINE_MS) };
};
