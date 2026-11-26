import { platform } from "node:os";
import { delimiter, join } from "node:path";
import { sleep } from "@intentic/base/async";
import { errorMessage } from "@intentic/base/errors";
import type { DeviceScopes } from "@intentic/sandbox-contract/schemas/capabilities";
import type {
    DeployStackToolArgs,
    DeployStackToolResult,
    DeviceStack,
    StackContainerState,
    StackDeployMode,
} from "@intentic/sandbox-contract/schemas/device-stacks";
import { type ExecResult, runProcess } from "../../../sync/exec.js";
import { assertScope } from "../../policy.js";
import { shellFor } from "../shell.js";
import { type HealthSeams, machineProbe, readDigests, waitHealthy } from "./deploy-health.js";
import { composeFileIn, copyIntoStack, type DeployRecord, readDeployRecord, recordDeploy, refuseOtherOwner, stagedSource } from "./stack-folder.js";
import { hideSecrets, refuseHandPlacedEnv, secretsOf, userDockerDir, writeEnv, writePins, writeRegistries } from "./stack-state.js";
import {
    clipped,
    composeArgs,
    type Docker,
    machineDocker,
    oneAtATime,
    outputOf,
    readStacks,
    READ_TIMEOUT_MS,
    runSteps,
    type StepRun,
    stacksRoot,
} from "./stacks.js";

/* DEPLOYING A STACK (deploy_stack): the pushed repository copied into the stack's folder and brought up there. A plain
   deploy is what it always was, `up --build` with any `.env` in the folder left alone. (2026-11-25) A MANAGED deploy, a
   stack the Deployments extension manages (schemas/device-stacks.ts), also brings what the daemon rendered for it:
   its `.env`, its registry logins, hooks, a health wait and image pins, and it answers with the digests it ran.
   Every deploy records the sandbox that made it, which alone may deploy, drive or read the stack from then on.

   One deadline holds the whole of it, files to digests, since the daemon waits for a device call no longer than its
   ceiling: each step is given what is left of it, rather than ten minutes of its own. */

// The daemon waits 15 minutes for a device call (DEVICE_CALL_CEILING_MS); the minute left is the answer's way back.
export const DEPLOY_DEADLINE_MS = 14 * 60_000;

// A hook, run by the machine's shell in the stack's folder.
export type HookRunner = (
    script: string,
    options: { readonly cwd: string; readonly env: Readonly<Record<string, string>>; readonly timeoutMs: number },
) => Promise<ExecResult>;

// `sh -c` where there is one; on Windows, run_command's own PowerShell (shell.ts), the shell a person there writes for.
const hookShell = (): { readonly command: string; readonly args: (script: string) => string[] } =>
    platform() === "win32" ? shellFor("win32") : { command: "/bin/sh", args: (script) => ["-c", script] };

const machineHook: HookRunner = async (script, { cwd, env, timeoutMs }) => {
    const shell = hookShell();
    return await runProcess(shell.command, shell.args(script), { cwd, timeoutMs, env: { ...process.env, ...env } });
};

// What a deploy reaches besides docker: its hooks, the health wait's URLs and clock, and where the person's own docker
// config is (its plugins and contexts, which a stack's DOCKER_CONFIG would hide).
export interface DeploySeams extends HealthSeams {
    readonly hook: HookRunner;
    readonly userDockerDir: () => string;
}

const machineDeploySeams: DeploySeams = { hook: machineHook, probe: machineProbe, sleep: async (ms) => await sleep(ms), now: Date.now, userDockerDir };

// The fields only a managed deploy sends; a deploy with none of them answers as a plain one always has.
const MANAGED_FIELDS = ["mode", "env", "registries", "hooks", "health", "pins", "adopt"] as const satisfies readonly (keyof DeployStackToolArgs)[];
const isManaged = (args: DeployStackToolArgs): boolean => MANAGED_FIELDS.some((field) => args[field] !== undefined);

// What compose runs, in order. `images` pulls what the files name and never builds; `build` is every earlier deploy's.
export const deploySteps = (name: string, files: readonly string[], mode: StackDeployMode): string[][] =>
    mode === "images"
        ? [
              [...composeArgs(name, files), "pull"],
              [...composeArgs(name, files), "up", "-d", "--remove-orphans"],
          ]
        : [[...composeArgs(name, files), "up", "-d", "--build", "--remove-orphans"]];

// The states a container is not running in: a project is adopted only when every container of it is in one.
const STOPPED: ReadonlySet<StackContainerState> = new Set(["exited", "created", "dead"]);

// A project of this name that no deploy put in the stacks folder is somebody else's: an `up --remove-orphans` under its
// name would replace its containers with the repository's and remove the rest. One with no container left has nothing
// to replace. (2026-11-25) `adopt` takes over one whose containers are all stopped (a stack another tool ran, such as
// Komodo, stopped for the move), its named volumes carrying over; a running one stays refused, and a sandbox's always.
export const refuseTakeover = (existing: DeviceStack | undefined, adopt: boolean): void => {
    if (existing === undefined || existing.managed) {
        return;
    }
    if (existing.sandbox) {
        throw new Error(`"${existing.name}" is an Intentic sandbox's own compose project on this device: deploy under another name.`);
    }
    if (existing.workingDir === undefined) {
        return;
    }
    const running = existing.services.filter((service) => !STOPPED.has(service.state));
    if (adopt && running.length === 0) {
        return;
    }
    const replacing = `A compose project called "${existing.name}" already runs on this device from ${existing.workingDir}, which no deploy put there: deploying under its name would replace its containers.`;
    throw new Error(
        adopt
            ? `${replacing} It is adopted only once none of its containers is running, and ${running.map((service) => `${service.container} is ${service.state}`).join(", ")}: stop it on this device, then deploy again.`
            : `${replacing} Deploy under another name. A project whose containers are all stopped can be taken over with adopt.`,
    );
};

// Where a deploy stands while it runs.
interface DeployRun {
    readonly owner: string;
    readonly docker: Docker;
    readonly seams: DeploySeams;
    readonly deadline: number;
}

// What the managed fields put in the stack's folder.
interface Placed {
    readonly envDigest: string | undefined;
    readonly env: Readonly<Record<string, string>> | undefined;
    readonly pins: string | undefined;
}

// The `.env` last, just before the record that vouches for it: a `.env` written and then left unrecorded by a refusal
// after it would read to the next deploy as one a person put there.
const placeState = async (dir: string, args: DeployStackToolArgs, seams: DeploySeams): Promise<Placed> => {
    const config = await writeRegistries(dir, args.registries ?? [], seams.userDockerDir());
    const pins = await writePins(dir, args.pins);
    const envDigest = args.env === undefined ? undefined : await writeEnv(dir, args.env);
    return { envDigest, env: config === undefined ? undefined : { DOCKER_CONFIG: config }, pins };
};

// The record a deploy leaves: the `.env` digest is the one it wrote, or, when it wrote none, the one there before (that
// `.env` is still the agent's).
const recordOf = (args: DeployStackToolArgs, owner: string, envDigest: string | undefined): DeployRecord => {
    const record: DeployRecord = { commit: args.commit, composeFile: args.composeFile, deployedAt: new Date().toISOString(), owner };
    if (envDigest !== undefined) {
        record.envDigest = envDigest;
    }
    return record;
};

const HOOK_AFTER = {
    preDeploy: "so compose was not run: the containers that ran before still run, and the folder holds the new files",
    postDeploy: "after the stack came up",
} as const;

const hookFailure = (which: keyof typeof HOOK_AFTER, result: ExecResult, timeoutMs: number): string => {
    const said = outputOf(result);
    const how =
        result.spawnCode === undefined
            ? result.status === null
                ? `did not finish: it was stopped at the deploy's deadline (${Math.round(timeoutMs / 1000)} s were left), or by a signal`
                : `failed (exit ${result.status})`
            : `could not start (${result.spawnCode}): this device has no shell to run it with`;
    return `The ${which} hook ${how}, ${HOOK_AFTER[which]}.${said === "" ? "" : `\n\n${clipped(said)}`}`;
};

const runHook = async (which: keyof typeof HOOK_AFTER, script: string, dir: string, env: Readonly<Record<string, string>>, run: DeployRun): Promise<string> => {
    const timeoutMs = Math.max(run.deadline - run.seams.now(), 1_000);
    const result = await run.seams.hook(script, { cwd: dir, env, timeoutMs });
    if (result.status !== 0) {
        throw new Error(hookFailure(which, result, timeoutMs));
    }
    return outputOf(result);
};

// What a managed deploy does once compose is up: the health wait, the post-deploy hook, the digests it ran.
const afterUp = async (args: DeployStackToolArgs, dir: string, hookEnv: Readonly<Record<string, string>>, run: DeployRun) => {
    const healthySeconds = args.health === undefined ? undefined : await waitHealthy(args.name, args.health, run.docker, run.seams, run.deadline);
    const post = args.hooks?.postDeploy;
    const printed = post === undefined ? "" : await runHook("postDeploy", post, dir, hookEnv, run);
    const digests = await readDigests(args.name, run.docker, Math.max(Math.min(READ_TIMEOUT_MS, run.deadline - run.seams.now()), 1_000));
    return { healthySeconds, printed, digests };
};

const deployInto = async (args: DeployStackToolArgs, source: string, run: DeployRun): Promise<DeployStackToolResult> => {
    const dir = join(stacksRoot(), args.name);
    const record = await readDeployRecord(dir);
    refuseOtherOwner(args.name, record, run.owner);
    refuseTakeover((await readStacks(run.docker)).stacks.find((stack) => stack.name === args.name), args.adopt === true);
    if (args.env !== undefined) {
        await refuseHandPlacedEnv(args.name, dir, record?.envDigest);
    }
    await copyIntoStack(source, dir);
    const placed = await placeState(dir, args, run.seams);
    await recordDeploy(dir, recordOf(args, run.owner, placed.envDigest ?? record?.envDigest));
    const files = [await composeFileIn(dir, args.composeFile, "the stack's folder"), ...(placed.pins === undefined ? [] : [placed.pins])];
    // A hook's `docker compose` reaches the same project, files and registries as the deploy's own.
    const hookEnv = { ...placed.env, COMPOSE_PROJECT_NAME: args.name, COMPOSE_FILE: files.join(delimiter) };
    const pre = args.hooks?.preDeploy;
    const before = pre === undefined ? [] : [await runHook("preDeploy", pre, dir, hookEnv, run)];
    const steps: StepRun = { cwd: dir, env: placed.env, deadline: run.deadline, now: run.seams.now };
    const what = (step: readonly string[]): string => `docker compose ${step.at(-1) === "pull" ? "pull" : "up"} for ${args.name} in ${dir}`;
    const composed = await runSteps(deploySteps(args.name, files, args.mode ?? "build"), steps, run.docker, what, before);
    if (!isManaged(args)) {
        return { path: dir, output: composed };
    }
    const after = await afterUp(args, dir, hookEnv, run);
    const result: DeployStackToolResult = { path: dir, output: clipped([...before, composed, after.printed].filter((text) => text !== "").join("\n")) };
    if (after.digests !== undefined) {
        result.digests = after.digests;
    }
    if (placed.envDigest !== undefined) {
        result.envDigest = placed.envDigest;
    }
    if (after.healthySeconds !== undefined) {
        result.healthySeconds = after.healthySeconds;
    }
    return result;
};

export const deployStack = async (
    args: DeployStackToolArgs,
    scopes: DeviceScopes,
    sandboxUrl: string,
    docker: Docker = machineDocker,
    seams: DeploySeams = machineDeploySeams,
): Promise<string> => {
    assertScope(scopes, "shell");
    assertScope(scopes, "programs");
    // From the moment the call arrived: a deploy waiting for the stack's lock spends the same minutes the daemon counts.
    const deadline = seams.now() + DEPLOY_DEADLINE_MS;
    const source = await stagedSource(args.source, sandboxUrl);
    // Checked before the stack's folder is touched, so a wrong name changes nothing there.
    await composeFileIn(source, args.composeFile, "the pushed repository");
    const secrets = secretsOf(args);
    return await oneAtATime(args.name, async () => {
        try {
            const answer = await deployInto(args, source, { owner: sandboxUrl, docker, seams, deadline });
            return JSON.stringify({ ...answer, output: hideSecrets(answer.output, secrets) });
        } catch (error) {
            // A failure's words with every secret the deploy carried taken out, its kind kept (a refusal stays a refusal).
            if (error instanceof Error) {
                error.message = hideSecrets(error.message, secrets);
                throw error;
            }
            throw new Error(hideSecrets(errorMessage(error), secrets), { cause: error });
        }
    });
};
