import type {
    CiRunnerOpResult,
    CiRunnerRegisterArgs,
    DeviceCiRunnerRegisterInput,
    DeviceCiRunnerRemoveInput,
} from "@intentic/sandbox-contract/schemas/ci-fleet";
import { ORPCError } from "@orpc/server";
import type { Services } from "../../composition.js";
import { deviceCiFleet, RUNNERS } from "../../hosts/ci-fleet/device-ci-fleet.js";
import { deviceClientFor, relayTool } from "../../hosts/devices/device-tool-relay.js";
import { DEVICE_CALL_CEILING_MS } from "../../peers/device-call-deadline.js";
import { mintRunnerToken } from "../../forge/github.js";
import { registrationScope, removalScope } from "./runner-scope.js";
import type { FetchFn } from "../../forge/http.js";

// ADDING AND REMOVING A SELF-HOSTED RUNNER ON ONE OF THE OWNER'S COMPUTERS, for the Pipelines view's Runners section:
// GitHub's side and the computer's together. The token GitHub mints for the repository is minted here through the
// workspace's GitHub connection for that one call (forge/github.ts) and handed to the machine's
// `ci_runner_register` or `ci_runner_remove`, relayed as every runner tool is (hosts/ci-fleet/device-ci-fleet.ts).

export type CiFleetServices = Pick<Services, "hostHub" | "workspace" | "capabilities">;

// A registration downloads the runner release (about 200 MB) and configures it, which the machine stops at ten minutes,
// and a removal runs the runner's own config.sh against GitHub: the hub's ceiling on any one call covers both, so only
// a computer gone quiet is cut here.
const CHANGE_DEADLINE_MS = DEVICE_CALL_CEILING_MS;

/** A new runner on the computer for a workspace repository's GitHub repository: the registration token is minted for
 *  it here and handed to `ci_runner_register` with the runner's name and labels; the machine installs it as the account
 *  its other runners run as. The computer is checked first, so a token is minted only for a call that can be made. */
export const registerDeviceCiRunner = async (
    services: CiFleetServices,
    input: DeviceCiRunnerRegisterInput,
    fetchFn: FetchFn = fetch,
): Promise<CiRunnerOpResult> => {
    deviceClientFor(services, input.id, [RUNNERS]);
    const scope = await registrationScope(services, input.repo);
    // No `user`: the machine installs it as the account its other runners run as.
    const args = { url: scope.url, token: await mintRunnerToken(scope, "registration", fetchFn), name: input.name, labels: input.labels } satisfies CiRunnerRegisterArgs;
    return { said: await relayTool(services, input.id, "ci_runner_register", args, CHANGE_DEADLINE_MS) };
};

/** A runner taken off GitHub and off the computer: its registration is read from `ci_runners` first, the removal token
 *  minted for that repository (or organisation), and `ci_runner_remove` does the rest. The machine refuses one that is
 *  running a job. */
export const removeDeviceCiRunner = async (services: CiFleetServices, input: DeviceCiRunnerRemoveInput, fetchFn: FetchFn = fetch): Promise<CiRunnerOpResult> => {
    const fleet = await deviceCiFleet(services, input.id);
    const runner = fleet.runners.find((candidate) => candidate.name === input.name);
    if (runner === undefined) {
        throw new ORPCError("NOT_FOUND", { message: `There is no runner "${input.name}" on "${input.id}".` });
    }
    const scope = await removalScope(services.capabilities, input.name, runner.url);
    const token = await mintRunnerToken(scope, "remove", fetchFn);
    return { said: await relayTool(services, input.id, "ci_runner_remove", { name: input.name, token }, CHANGE_DEADLINE_MS) };
};
