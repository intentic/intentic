import { errorMessage } from "@intentic/base/errors";
import { defaultGit } from "@intentic/base/git";
import type { SecretStore } from "@intentic/output-cleaners/cleaners";
import type { DeviceStackManagedDeployInput, DeviceStackManagedDeployResult } from "@intentic/sandbox-contract/schemas/device-stacks";
import { parseHostConnection } from "@intentic/sandbox-contract/schemas/hosts";
import { ORPCError } from "@orpc/server";
import type { Services } from "../../composition.js";
import { fetchTracked } from "../../git/remote/follow-upstream.js";
import { opt } from "../../opt.js";
import type { SecretMarks } from "../../secrets/marks/secret-marks.js";
import { DETAIL_MAX, type SecretUse } from "../../secrets/secret-uses.js";
import type { StackGrantsStore } from "../../secrets/stack-grants/stack-grants.js";
import { committedStack, exactCommit, repoFolder, stackAtCommit } from "./device-stack-bundle.js";
import { deployManagedStack, deviceStacks, type ManagedStackFields, managedStackClient, type StackServices } from "./device-stacks.js";
import { listedNames, maskedText, renderManaged, type RenderSources, secretNamesOf } from "./managed-render.js";

/* A MANAGED DEPLOY (contracts/device-stacks.contract.ts `deployManagedDeviceStack`): the one door through which a
   secret's value reaches a server unattended. The Deployments extension holds the policy (its stacks manifest, queue,
   triggers, history, rollback) and sends a stack's definition with `{{secret:NAME}}` references; the daemon holds what
   no extension may, the values. In order, each step refusing before anything reaches the stack:
     1. the computer's agent can take a managed stack (409 when it is offline or too old);
     2. the repository and the commit, fetched from its remote when the checkout lacks it, and the compose file in it (400);
     3. the owner's grant for this stack from this repository on this computer (by its device card) covers every name
        the stack reads (403, naming the ones it does not; secrets/stack-grants/stack-grants.ts);
     4. each value fills from this sandbox's own store (412 when one cannot: managed-render.ts);
     5. no other sandbox owns a stack of this name there (403);
   then each name's use is logged (lane `deploy`), the tree is carried and `deploy_stack` runs with the filled `.env`
   and logins (device-stacks.ts `deployManagedStack`: 422 is the machine's word that the deploy failed, 502 a link that
   dropped). The answer names the secrets and marks each value (secrets/marks/secret-marks.ts) so the extension can tell
   later that one changed; no value is in it, in an error, or in a log, and whatever the machine printed has every value
   put back as its reference. */

export interface ManagedDeployDeps {
    readonly device: StackServices;
    readonly grants: Pick<StackGrantsStore, "forStack">;
    readonly secrets: RenderSources;
    readonly marks: SecretMarks;
    readonly uses: { readonly record: (use: SecretUse) => Promise<void> };
    // Fetches the repository's remote, for a commit the checkout lacks; answers why it failed, or nothing.
    readonly fetchRemote: (dir: string) => Promise<string | undefined>;
    readonly now: () => number;
}

// The commit and the compose file in it: HEAD's when no commit is named.
const resolved = async (deps: ManagedDeployDeps, dir: string, input: DeviceStackManagedDeployInput) => {
    if (input.commit === undefined) {
        return await committedStack(dir, input.repo, input.composeFile);
    }
    const commit = await exactCommit(dir, input.repo, input.commit, () => deps.fetchRemote(dir));
    return await stackAtCommit(dir, input.repo, commit, input.composeFile);
};

// Refused, naming them, unless the owner granted the stack every name it reads on this computer.
const refuseUngranted = async (deps: ManagedDeployDeps, input: DeviceStackManagedDeployInput, device: string, names: readonly string[]): Promise<void> => {
    if (names.length === 0) {
        return;
    }
    let granted: readonly string[];
    try {
        granted = (await deps.grants.forStack({ repo: input.repo, stack: input.name, device }))?.secrets ?? [];
    } catch (error) {
        throw new ORPCError("INTERNAL_SERVER_ERROR", { message: `This sandbox's stack grants could not be read (${errorMessage(error)}): nothing is filled until they can.` });
    }
    const ungranted = names.filter((name) => !granted.includes(name));
    if (ungranted.length > 0) {
        throw new ORPCError("FORBIDDEN", {
            message:
                `${listedNames(ungranted)} ${ungranted.length === 1 ? "is" : "are"} not granted to "${input.name}" from "${input.repo}" on "${device}": ` +
                `only the owner lets a stack receive a secret (\`secrets grant-stack ${input.repo} ${input.name} ${device} ${ungranted.join(" ")}\` asks them on a card).`,
        });
    }
};

// A stack of this name another sandbox deployed there is that sandbox's alone; the machine would refuse it too, but as
// a failed deploy, which a caller would take for a broken stack.
const refuseOthers = async (deps: ManagedDeployDeps, input: DeviceStackManagedDeployInput): Promise<void> => {
    const found = (await deviceStacks(deps.device, input.id)).stacks.find((stack) => stack.name === input.name);
    if (found?.owner !== undefined && !found.owner.you) {
        throw new ORPCError("FORBIDDEN", {
            message: `"${input.name}" on "${input.id}" was deployed by another sandbox (${found.owner.sandbox}): only that one may deploy it. Deploy it under another name, or have it taken down there first.`,
        });
    }
};

// What deploy_stack is sent besides the tree: each managed part the caller sent, filled, and nothing it did not.
const fieldsOf = (input: DeviceStackManagedDeployInput, env: string | undefined, registries: ManagedStackFields["registries"]): ManagedStackFields => ({
    mode: input.mode,
    ...opt("env", env),
    ...opt("registries", registries !== undefined && registries.length > 0 ? registries : undefined),
    ...opt("hooks", input.hooks),
    ...opt("health", input.health),
    ...opt("pins", input.pins),
    ...opt("adopt", input.adopt),
});

export const deployManaged = async (deps: ManagedDeployDeps, input: DeviceStackManagedDeployInput): Promise<DeviceStackManagedDeployResult> => {
    managedStackClient(deps.device, input.id);
    const dir = await repoFolder(deps.device.workspace.root, input.repo);
    const { commit, composeFile } = await resolved(deps, dir, input);
    // A grant is for the computer, by its card: every environment of it (a WSL distro) is the same computer.
    const device = parseHostConnection(input.id).card;
    const spec = { env: input.env ?? {}, registries: input.registries ?? [] };
    await refuseUngranted(deps, input, device, secretNamesOf(spec));
    const rendered = await renderManaged(spec, deps.secrets);
    if (!rendered.ok) {
        throw new ORPCError("PRECONDITION_FAILED", { message: rendered.error });
    }
    await refuseOthers(deps, input);
    // Each name leaves the store here, into the `.env` or a registry login: the uses log says so, names only.
    const detail = `${input.name} on ${device}`.slice(0, DETAIL_MAX);
    for (const name of rendered.secretNames) {
        await deps.uses.record({ name, lane: "deploy", detail, at: deps.now() });
    }
    const mark = await deps.marks.marker();
    const secretMarks = Object.fromEntries([...rendered.values].map(([name, value]) => [name, mark(name, value)]));
    const result = await deployManagedStack(
        deps.device,
        { id: input.id, name: input.name, repo: input.repo, commit, composeFile, fields: fieldsOf(input, rendered.env, [...rendered.registries]) },
        (text) => maskedText(text, rendered.values),
    );
    return { ...result, stack: input.name, commit, secretNames: [...rendered.secretNames], secretMarks };
};

// What holds a name this sandbox's own store does not, in a refusal's words; undefined for the store itself.
const heldBy = (source: SecretStore["source"]): string | undefined => {
    switch (source) {
        case "capability":
            return "a connection's vault";
        case "copy":
            return "a copy a keyring on one of your computers shares here";
        case "device":
            return "a keyring on one of your computers";
        case "sandbox":
            return undefined;
    }
};

const secretSources = (services: Services): RenderSources => ({
    own: (name) => services.sandboxSecrets.get(name),
    heldElsewhere: async (name) => {
        const held = (await services.secretRegistry()).find((secret) => secret.name === name);
        const elsewhere = held === undefined ? undefined : heldBy(held.source);
        if (elsewhere !== undefined) {
            return elsewhere;
        }
        // allow(silent-catch): only the refusal's words lose where the name lives; it is refused as not stored either way
        const pointer = (await services.deviceSecrets.listed().catch(() => [])).find((entry) => entry.pointer.name === name);
        return pointer === undefined ? undefined : `the keyring on ${pointer.machine}`;
    },
    gates: () => services.credentialGates.list(),
});

// The remote a commit is fetched from: `origin`, else the first one the repository names.
const remoteOf = async (dir: string): Promise<string | undefined> => {
    const { stdout } = await defaultGit(dir, ["remote"]);
    const remotes = stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");
    return remotes.includes("origin") ? "origin" : remotes[0];
};

const fetchRemoteOf =
    (services: Services) =>
    async (dir: string): Promise<string | undefined> => {
        try {
            const remote = await remoteOf(dir);
            if (remote === undefined) {
                return "it has no remote";
            }
            const fetched = await fetchTracked(dir, remote, await services.daemonGitEnv());
            return fetched.ok ? undefined : fetched.reason;
        } catch (error) {
            return errorMessage(error);
        }
    };

// The managed deploy as the route composes it, over the daemon's own stores.
export const managedDeployDeps = (services: Services): ManagedDeployDeps => ({
    device: services,
    grants: services.stackGrants,
    secrets: secretSources(services),
    marks: services.secretMarks,
    uses: services.secretUses,
    fetchRemote: fetchRemoteOf(services),
    now: Date.now,
});
