import { errorMessage } from "@intentic/base/errors";
import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import { type DeployRecord, STACKS_MANIFEST_PATH, type StackSpec } from "@intentic/sandbox-contract/schemas/deploys";
import type { StackRegistryLogin } from "@intentic/sandbox-contract/schemas/device-stacks";
import { hostConnectionKey, parseHostConnection } from "@intentic/sandbox-contract/schemas/hosts";
import { ORPCError } from "@orpc/server";
import { opt } from "../opt.js";
import { repoFolder } from "../hosts/stacks/device-stack-bundle.js";
import { deployManagedStack, deviceStacks, type ManagedStackFields, managedStackClient, type StackServices } from "../hosts/stacks/device-stacks.js";
import { DETAIL_MAX, type SecretUse } from "../secrets/secret-uses.js";
import type { DeployGrantsStore } from "./deploy-grants.js";
import { manifestAt } from "./deploy-manifests.js";
import { maskedText, renderStack, type RenderSources } from "./deploy-render.js";

// ONE ATTEMPT AT ONE DEPLOY RECORD (deploys-engine.ts runs them, one per stack at a time): the commit's own manifest,
// the computer it names, the owner's grant and the render, then the machine. Every step that finds something a person
// must change answers `refused` in words they can act on, before anything reaches the stack; past that point the
// answer is the machine's. Nothing here writes a record: the engine does, with what this answers.

export interface RunDeps {
    readonly root: string;
    readonly device: StackServices;
    // The device cards, which a manifest's `device` names.
    readonly deviceCards: () => Promise<readonly Capability[]>;
    readonly grants: Pick<DeployGrantsStore, "forStack">;
    readonly secrets: RenderSources;
    readonly uses: { readonly record: (use: SecretUse) => Promise<void> };
    // Told the values the moment they are rendered, for the rotation watch's marks (deploy-rotation.ts); keeps none.
    readonly rendered?: (record: DeployRecord, values: ReadonlyMap<string, string>) => void;
    readonly now: () => number;
}

// How an attempt came out: the fields the record ends with, the stack as its commit declares it (once read), and
// whether the stack is known broken on the machine, the one case a rollback can mend.
export interface Attempted {
    readonly fields: Pick<DeployRecord, "outcome"> & Partial<Pick<DeployRecord, "error" | "digests" | "envDigest" | "healthySeconds" | "outputTail" | "secretNames">>;
    readonly spec?: StackSpec | undefined;
    readonly brokenOnMachine: boolean;
}

// The record's caps (schemas/deploys.ts): an error's head, an output's tail.
const ERROR_MAX = 4000;
const OUTPUT_MAX = 20_000;
const clipped = (text: string): string => (text.length > ERROR_MAX ? `${text.slice(0, ERROR_MAX - 1)}…` : text);
const tailOf = (text: string): string => (text.length > OUTPUT_MAX ? text.slice(-OUTPUT_MAX) : text);

const refusedWith = (error: string, spec?: StackSpec, secretNames?: readonly string[]): Attempted => ({
    fields: { outcome: "refused", error: clipped(error), ...opt("secretNames", secretNames === undefined ? undefined : [...secretNames]) },
    spec,
    brokenOnMachine: false,
});

// A manifest's `device` as the hub keys its connection: a card's id, any case, or `<card>:<environment>` for a side of
// it (a WSL distro); undefined when no card of this sandbox answers to it.
export const resolveDevice = (named: string, cards: readonly Capability[]): string | undefined => {
    const { card, environment } = parseHostConnection(named);
    const found = cards.find((capability) => capability.kind === "device" && capability.id.toLowerCase() === card.toLowerCase());
    return found === undefined ? undefined : hostConnectionKey(found.id, environment);
};

// The stack as `record.commit` declares it, or the refusal saying why there is none.
type Declared = { readonly spec: StackSpec } | { readonly refusal: string };
const declaredAt = async (deps: Pick<RunDeps, "root">, record: DeployRecord): Promise<Declared> => {
    const at = `"${record.repo}" at ${record.commit.slice(0, 12)}`;
    let dir: string;
    try {
        dir = await repoFolder(deps.root, record.repo);
    } catch (error) {
        return { refusal: errorMessage(error) };
    }
    const read = await manifestAt(dir, record.commit).catch((error: Error) => ({ kind: "broken" as const, error: error.message }));
    if (read.kind === "absent") {
        return { refusal: `${at} has no ${STACKS_MANIFEST_PATH}: nothing there declares "${record.stack}".` };
    }
    if (read.kind === "broken") {
        return { refusal: `${at}: ${read.error}` };
    }
    const spec = read.manifest.stacks.find((declared) => declared.name === record.stack);
    return spec === undefined ? { refusal: `${at} does not declare "${record.stack}" in ${STACKS_MANIFEST_PATH}.` } : { spec };
};

// What the computer's stack list says of this stack before anything is sent: owned by another sandbox (refused), or a
// compose project no deploy put there, which the first deploy from here takes over (`adopt`; the machine still refuses
// while any of its containers runs). A list the machine refuses is refused in its words; one the link drops fails.
type Listed = { readonly kind: "ok"; readonly unmanaged: boolean } | { readonly kind: "refused" | "failed"; readonly error: string };
const listedOn = async (deps: Pick<RunDeps, "device">, id: string, spec: StackSpec): Promise<Listed> => {
    try {
        const found = (await deviceStacks(deps.device, id)).stacks.find((stack) => stack.name === spec.name);
        if (found?.owner !== undefined && !found.owner.you) {
            return {
                kind: "refused",
                error: `"${spec.name}" on "${spec.device}" was deployed by another sandbox (${found.owner.sandbox}): only that one may deploy it. Deploy it under another name, or have it taken down there first.`,
            };
        }
        return { kind: "ok", unmanaged: found !== undefined && !found.managed };
    } catch (error) {
        const cut = error instanceof ORPCError && error.code === "BAD_GATEWAY";
        return { kind: cut ? "failed" : "refused", error: errorMessage(error) };
    }
};

// What deploy_stack is sent besides the tree: each managed part the stack declares, and nothing it does not.
const fieldsOf = (
    spec: StackSpec,
    record: DeployRecord,
    rendered: { readonly env: string | undefined; readonly registries: readonly StackRegistryLogin[] },
    adopt: boolean,
): ManagedStackFields => ({
    mode: spec.mode,
    ...opt("env", rendered.env),
    ...opt("registries", rendered.registries.length > 0 ? [...rendered.registries] : undefined),
    ...opt("hooks", spec.hooks.preDeploy !== undefined || spec.hooks.postDeploy !== undefined ? spec.hooks : undefined),
    ...opt("health", spec.health),
    ...opt("pins", record.pins),
    ...opt("adopt", adopt ? true : undefined),
});

// The attempt. `firstHere`: no deploy of this stack from this sandbox has succeeded yet, which is when an unmanaged
// project of its name is taken over rather than refused.
export const attemptDeploy = async (deps: RunDeps, record: DeployRecord, firstHere: boolean): Promise<Attempted> => {
    const declared = await declaredAt(deps, record);
    if ("refusal" in declared) {
        return refusedWith(declared.refusal);
    }
    const { spec } = declared;
    const id = resolveDevice(spec.device, await deps.deviceCards());
    if (id === undefined) {
        return refusedWith(`"${spec.device}" is not a computer paired with this sandbox: pair it on Devices, or name another in ${STACKS_MANIFEST_PATH}.`, spec);
    }
    try {
        managedStackClient(deps.device, id);
    } catch (error) {
        return refusedWith(errorMessage(error), spec);
    }
    const listed = await listedOn(deps, id, spec);
    if (listed.kind !== "ok") {
        return listed.kind === "refused" ? refusedWith(listed.error, spec) : { fields: { outcome: "failed", error: clipped(listed.error) }, spec, brokenOnMachine: false };
    }
    let granted: readonly string[];
    try {
        granted = (await deps.grants.forStack(record.repo, record.stack, spec.device))?.secrets ?? [];
    } catch (error) {
        return refusedWith(`This sandbox's deploy grants could not be read (${errorMessage(error)}): nothing is rendered until they can.`, spec);
    }
    const rendered = await renderStack(record.repo, spec, { sha: record.commit, ref: record.ref, stack: spec.name }, granted, deps.secrets);
    if (!rendered.ok) {
        return refusedWith(rendered.error, spec, rendered.secretNames);
    }
    // Each name leaves the store here, into the `.env` or a registry login: the uses log says so, names only.
    const detail = `${spec.name} on ${spec.device}`.slice(0, DETAIL_MAX);
    for (const name of rendered.secretNames) {
        await deps.uses.record({ name, lane: "deploy", detail, at: deps.now() });
    }
    const secretNames = [...rendered.secretNames];
    deps.rendered?.(record, rendered.values);
    const outcome = await deployManagedStack(deps.device, {
        id,
        name: spec.name,
        repo: record.repo,
        commit: record.commit,
        composeFile: spec.compose,
        fields: fieldsOf(spec, record, rendered, firstHere && listed.unmanaged),
    });
    if (outcome.kind === "deployed") {
        const { result } = outcome;
        return {
            fields: {
                outcome: "succeeded",
                secretNames,
                ...opt("digests", result.digests),
                ...opt("envDigest", result.envDigest),
                ...opt("healthySeconds", result.healthySeconds),
                outputTail: tailOf(maskedText(result.output, rendered.values)),
            },
            spec,
            brokenOnMachine: false,
        };
    }
    const error = clipped(maskedText(outcome.error, rendered.values));
    if (outcome.kind === "refused") {
        return { fields: { outcome: "refused", error, secretNames }, spec, brokenOnMachine: false };
    }
    return { fields: { outcome: "failed", error, secretNames }, spec, brokenOnMachine: outcome.kind === "machine" };
};
