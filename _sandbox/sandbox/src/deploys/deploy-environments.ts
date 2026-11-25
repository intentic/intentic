import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import { type DeployEnvironment, type DeployEnvironmentsResponse, type DeployGrant, type DeployRecord, stackSecretNames } from "@intentic/sandbox-contract/schemas/deploys";
import {
    DEVICE_FEATURE_PROGRAMS,
    DEVICE_FEATURE_STACKS,
    DEVICE_FEATURE_STACKS_MANAGED,
    type DeviceFeature,
    deviceSupports,
} from "@intentic/sandbox-contract/schemas/hosts";
import { opt } from "../opt.js";
import type { StackServices } from "../hosts/stacks/device-stacks.js";
import { type DeclaredStack, workspaceManifests } from "./deploy-manifests.js";
import { resolveDevice } from "./deploy-run.js";
import type { StackState } from "./deploys-engine.js";

// THE BOARD'S READ (contract `deploys.environments`): every stack the workspace's repositories declare at HEAD, joined
// with its records, the owner's grant for it, what the monitor last read on its computer and which of its secrets
// changed since its last deploy (deploy-watch.ts), plus each reason it cannot deploy now or is not seen on its forge.
// Display only: an unreadable grants file shows every secret as ungranted here, while a deploy refuses.

export interface EnvironmentsDeps {
    readonly root: string;
    readonly device: Pick<StackServices, "hostHub">;
    readonly deviceCards: () => Promise<readonly Capability[]>;
    readonly records: () => Promise<readonly DeployRecord[]>;
    readonly grants: () => Promise<readonly DeployGrant[]>;
    readonly stackState: (repo: string, stack: string) => StackState;
    readonly secretsChanged: (repo: string, stack: string) => readonly string[];
    // Why the repository's forge does not show its deploys, when a report there was refused (deploy-forge.ts).
    readonly forgeProblem: (repo: string) => string | undefined;
}

// What a managed deploy needs of the computer's agent, by the words its card's update says.
const NEEDED: readonly (readonly [DeviceFeature, string])[] = [
    [DEVICE_FEATURE_STACKS, "read or drive Docker compose stacks"],
    [DEVICE_FEATURE_PROGRAMS, "receive what this sandbox sends"],
    [DEVICE_FEATURE_STACKS_MANAGED, "take a stack this sandbox manages"],
];

// Why the stack's computer cannot take it now, as far as this sandbox can tell without asking it.
const deviceProblems = (deps: Pick<EnvironmentsDeps, "device">, named: string, id: string | undefined): string[] => {
    if (id === undefined) {
        return [`"${named}" is not a computer paired with this sandbox: pair it on Devices, or name another in the stacks manifest.`];
    }
    const state = deps.device.hostHub.state(id);
    // An offline computer's agent is read again when it connects; what it advertised last is all there is till then.
    if (state.facts === undefined) {
        return [];
    }
    return NEEDED.filter(([feature]) => !deviceSupports(state.facts, feature)).map(
        ([, to]) => `The agent on "${id}" is too old to ${to}: update it there (\`intentic-machine upgrade\`, or Update on its Devices card).`,
    );
};

const environmentOf = (
    deps: Pick<EnvironmentsDeps, "device" | "stackState" | "secretsChanged" | "forgeProblem">,
    declared: DeclaredStack,
    records: readonly DeployRecord[],
    grants: readonly DeployGrant[],
    cards: readonly Capability[],
): DeployEnvironment => {
    const { repo, spec } = declared;
    const own = records.filter((record) => record.repo === repo && record.stack === spec.name);
    const secrets = stackSecretNames(spec);
    const granted = grants.find((grant) => grant.repo === repo && grant.stack === spec.name && grant.device === spec.device)?.secrets ?? [];
    const deviceId = resolveDevice(spec.device, cards);
    const state = deps.stackState(repo, spec.name);
    const forge = deps.forgeProblem(repo);
    return {
        repo,
        stack: spec.name,
        device: spec.device,
        ...opt("deviceId", deviceId),
        mode: spec.mode,
        ...opt("description", spec.description),
        triggers: spec.triggers,
        secrets,
        ungranted: secrets.filter((name) => !granted.includes(name)),
        secretsChanged: [...deps.secretsChanged(repo, spec.name)],
        ...opt("current", own.find((record) => record.outcome === "succeeded")),
        ...opt("active", own.find((record) => record.outcome === "running") ?? own.find((record) => record.outcome === "queued")),
        ...opt("latest", own[0]),
        state: state.state,
        ...opt("stateSince", state.since),
        ownedElsewhere: state.ownedElsewhere,
        problems: [...deviceProblems(deps, spec.device, deviceId), ...(forge === undefined ? [] : [forge])],
    };
};

export const deployEnvironments = async (deps: EnvironmentsDeps): Promise<DeployEnvironmentsResponse> => {
    const [manifests, records, grants, cards] = await Promise.all([
        workspaceManifests(deps.root),
        deps.records(),
        // allow(silent-catch): display only, as the header says; every deploy reads the grants again and refuses on an unreadable file
        deps.grants().catch((): readonly DeployGrant[] => []),
        deps.deviceCards(),
    ]);
    return {
        environments: manifests.stacks.map((declared) => environmentOf(deps, declared, records, grants, cards)),
        manifestErrors: [...manifests.errors],
    };
};
