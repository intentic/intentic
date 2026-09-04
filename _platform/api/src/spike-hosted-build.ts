import { setTimeout as sleep } from "node:timers/promises";
import { flyBuildMachineConfig } from "@intentic/sandbox-run/fly";
import { loadConfig } from "./config.js";
import { createApp, deleteApp, createMachine, destroyMachine, flyBuildRole, FlyError, getMachineDetail } from "./sandbox/hosted/fly.js";
import { mintAppDeployToken, organizationIdOf, revokeDeployToken } from "./sandbox/hosted/fly-tokens.js";
import { BUILD_ENV, BUILD_PATHS, buildScript, dockerConfigJson } from "./sandbox/hosted/hosted-build-script.js";
import { hostedInstanceId } from "./sandbox/hosted/hosted.js";

/* `pnpm --filter @intentic-app/api spike:build`, the spike §4 of docs/hosted-overlay-rebuild-plan.md owes,
 * run instead of remembered. The design was written against Fly's DOCUMENTED shapes: the token mutation, a
 * machine booting its own app's registry path, `files` plus an entrypoint override on moby/buildkit, the exit
 * event on a stopped machine, and what a registry does with a moving tag. Every one of those is a guess until
 * something asks Fly, and the cost of a wrong guess is an owner watching a build that cannot work.
 *
 * So this asks, against a THROWAWAY APP it creates and destroys, using the platform's OWN functions rather
 * than a parallel transcript of flyctl commands. That is the point: a spike that exercises different code from
 * production verifies nothing about production. Every call below is the one hosted-build.ts makes.
 *
 * It spends real money (one or two builder machines for the length of a real overlay build) and it writes
 * nothing to the database. Read the summary it prints into §4 of the plan, replacing the questions with the
 * answers.
 *
 *   pnpm --filter @intentic-app/api spike:build [--keep] [--rootless] [--region iad] [--report-url URL]
 *
 *   --keep        leave the app standing at the end (to poke at it by hand). It is yours to delete.
 *   --rootless    also build with `<builderImage>-rootless`, question 6, roughly doubling the run.
 *   --region      where to build; defaults to config.hosted.region.
 *   --report-url  somewhere the builder's report can actually land (a request-bin URL). Without one the
 *                 report round trip is NOT exercised here: it needs a build row for its id, and this script
 *                 writes no rows. The route's own tests cover it; this covers everything around it. */

const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(`--${name}`);
const option = (name: string): string | undefined => {
    const at = args.indexOf(`--${name}`);
    return at === -1 ? undefined : args[at + 1];
};

const config = loadConfig();
const { flyApiToken, flyOrg, image: baseImage, builderImage, builderCpuKind, builderCpus, builderMemoryMb, buildTimeoutMinutes } = config.hosted;
const region = option(`region`) ?? config.hosted.region;
const timeoutMs = buildTimeoutMinutes * 60_000;

if (flyApiToken === `` || flyOrg === ``) {
    process.stderr.write(`This spike needs a Fly credential: set HOSTED_FLY_API_TOKEN and HOSTED_FLY_ORG (a throwaway org is ideal).\n`);
    process.exit(1);
}

const out = (line: string): void => {
    process.stdout.write(`${line}\n`);
};
const say = (message: unknown): string => (message instanceof Error ? message.message : String(message));

/* THE ANSWERS, collected as they are learned and printed together at the end, because the interesting output
 * of a spike is the summary and not the two hundred lines of build log above it. Every question can end
 * `unanswered`: a probe that failed says why rather than taking the run down, so one bad answer never costs
 * the five good ones or leaves an app standing. */
const answers = new Map<string, string>();
const answer = (question: string, value: string): void => {
    answers.set(question, value);
    out(`  → §4.${question}: ${value}`);
};
const probe = async (question: string, what: string, run: () => Promise<string>): Promise<void> => {
    out(`\n§4.${question} ${what}`);
    try {
        answer(question, await run());
    } catch (error) {
        answer(question, `UNANSWERED (${say(error)})`);
    }
};

/* THE DOCKER REGISTRY V2 AUTH DANCE, which `docker login` hides and this script cannot. An unauthenticated
 * read answers 401 with a `WWW-Authenticate: Bearer realm=…,service=…,scope=…` challenge; the realm mints a
 * bearer against basic `x:<deploy token>`, Fly's fixed username; the retry carries it. Written out because
 * the questions about the registry (does the token reach it, does a moving tag free the old manifest, is a
 * manifest DELETE honoured) cannot be asked any other way. */
const registryAuth = async (repo: string, deployToken: string, action: string): Promise<string> => {
    const challenge = await fetch(`https://registry.fly.io/v2/${repo}/tags/list`, { method: `GET` });
    const header = challenge.headers.get(`www-authenticate`) ?? ``;
    const field = (name: string): string => new RegExp(`${name}="([^"]+)"`).exec(header)?.[1] ?? ``;
    const realm = field(`realm`);
    if (realm === ``) {
        throw new Error(`registry.fly.io did not offer a bearer challenge (got: ${header || `no header`})`);
    }
    const scope = `repository:${repo}:${action}`;
    const minted = await fetch(`${realm}?service=${encodeURIComponent(field(`service`))}&scope=${encodeURIComponent(scope)}`, {
        headers: { authorization: `Basic ${Buffer.from(`x:${deployToken}`, `utf8`).toString(`base64`)}` },
    });
    if (!minted.ok) {
        throw new Error(`the registry refused the deploy token for ${scope}: HTTP ${minted.status}`);
    }
    const body = (await minted.json()) as { token?: string; access_token?: string };
    const bearer = body.token ?? body.access_token;
    if (bearer === undefined) {
        throw new Error(`the registry's token endpoint answered without a token`);
    }
    return bearer;
};

const MANIFEST_TYPES = [
    `application/vnd.oci.image.manifest.v1+json`,
    `application/vnd.oci.image.index.v1+json`,
    `application/vnd.docker.distribution.manifest.v2+json`,
    `application/vnd.docker.distribution.manifest.list.v2+json`,
].join(`, `);

const manifest = async (repo: string, reference: string, deployToken: string, method = `GET`): Promise<{ status: number; digest: string }> => {
    const bearer = await registryAuth(repo, deployToken, method === `DELETE` ? `pull,push,delete` : `pull`);
    const response = await fetch(`https://registry.fly.io/v2/${repo}/manifests/${reference}`, {
        method,
        headers: { authorization: `Bearer ${bearer}`, accept: MANIFEST_TYPES },
    });
    return { status: response.status, digest: response.headers.get(`docker-content-digest`) ?? `` };
};

/* A REALISTIC OVERLAY, which is what question 3 asks the wall time and the disk of: the official base pulled
 * whole, an apt install and a compile, exactly the shape §2.3 lints for (one official FROM, then RUN). The
 * first step also prints what question 5 wants and nothing else can answer: how much root disk a builder
 * actually has, and how big the guest really is. `marker` moves the tag on the second build without changing
 * anything else, so the two digests differ for the question about what a moving tag leaves behind. */
const probeOverlay = (marker: string): string =>
    [
        `FROM ${baseImage}`,
        `RUN echo "--- intentic spike: the builder's own guest and disk ---" \\`,
        `    && df -h / \\`,
        `    && nproc \\`,
        `    && (free -m || true)`,
        `RUN apt-get update \\`,
        `    && apt-get install -y --no-install-recommends gnucobol \\`,
        `    && rm -rf /var/lib/apt/lists/*`,
        `RUN printf '%s\\n' 'IDENTIFICATION DIVISION.' 'PROGRAM-ID. SPIKE.' 'PROCEDURE DIVISION.' 'DISPLAY "${marker}".' 'STOP RUN.' > /tmp/spike.cob \\`,
        `    && cobc -x -free -o /usr/local/bin/spike /tmp/spike.cob \\`,
        `    && /usr/local/bin/spike`,
        ``,
    ].join(`\n`);

const appName = `${config.hosted.appPrefix}-spike-${Math.random().toString(36).slice(2, 10)}`;
const repo = appName;
const madeMachines: string[] = [];
const mintedTokens: string[] = [];

// Poll a machine to a state that costs nothing more, the reconcile's own reading of what has ended. Returns
// the last detail seen either way, so a machine still running at the deadline is reported as exactly that.
const ENDED = new Set([`stopped`, `failed`, `destroyed`, `suspended`]);
const waitForEnd = async (machineId: string, deadline: number): Promise<Awaited<ReturnType<typeof getMachineDetail>>> => {
    for (;;) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- a poll is a loop of waits by definition
        const detail = await getMachineDetail(flyApiToken, appName, machineId);
        if (ENDED.has(detail.state) || Date.now() > deadline) {
            return detail;
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- as above
        await sleep(5_000);
    }
};

/* One builder, the way hosted-build.ts makes one: the same config composer, the same script, the same file
 * set, the same metadata stamp. Answers the wall time and what the machine's exit event said. */
const runBuild = async (
    label: string,
    overlay: string,
    deployToken: string,
    image: string,
    builder: string,
): Promise<{ ms: number; exit: string; machineId: string }> => {
    const started = Date.now();
    const created = await createMachine(flyApiToken, appName, {
        name: `${appName}-${label}`,
        region,
        config: {
            ...flyBuildMachineConfig({
                image: builder,
                guest: { cpuKind: builderCpuKind, cpus: builderCpus, memoryMb: builderMemoryMb },
                files: [
                    { path: BUILD_PATHS.dockerfile, content: overlay },
                    { path: BUILD_PATHS.script, content: buildScript() },
                    { path: BUILD_PATHS.dockerConfig, content: dockerConfigJson(`registry.fly.io`, deployToken) },
                ],
                entrypoint: [`/bin/sh`, BUILD_PATHS.script],
                env: [
                    [BUILD_ENV.image, image],
                    [BUILD_ENV.cache, `registry.fly.io/${appName}:env-cache`],
                    [BUILD_ENV.timeoutSeconds, String(buildTimeoutMinutes * 60)],
                    [BUILD_ENV.reportUrl, option(`report-url`) ?? `${config.api.url}/sandbox/hosted-build-report/spike-has-no-row`],
                    [BUILD_ENV.secret, `spike`],
                ],
            }),
            metadata: flyBuildRole(`spike`, hostedInstanceId(config)),
        },
    });
    madeMachines.push(created.machineId);
    out(`  builder ${created.machineId} building (up to ${buildTimeoutMinutes}m); logs: fly logs -a ${appName} -i ${created.machineId}`);
    const detail = await waitForEnd(created.machineId, started + timeoutMs);
    const ms = Date.now() - started;
    const exit =
        detail.exitCode === undefined
            ? `state ${detail.state}, NO exit code readable off events[].request.exit_event`
            : `exit_code ${detail.exitCode}${detail.oomKilled ? ` (OOM killed)` : ``}, read off events[].request.exit_event`;
    out(`  ${label} ended after ${Math.round(ms / 1000)}s: ${exit}`);
    return { ms, exit, machineId: created.machineId };
};

const minutes = (ms: number): string => `${Math.floor(ms / 60_000)}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, `0`)}s`;

out(
    `Spike app ${appName} in ${region}, org ${flyOrg}. Base ${baseImage}, builder ${builderImage} (${builderCpuKind}/${builderCpus}/${builderMemoryMb}MB).`,
);
out(`Nothing is written to the database. ${flag(`keep`) ? `--keep: the app is LEFT STANDING at the end.` : `The app is destroyed at the end.`}`);

let deployToken = ``;
const imageRef = `registry.fly.io/${appName}:env`;
let firstDigest = ``;
let firstBuilder = ``;

try {
    await createApp(flyApiToken, flyOrg, appName);
    out(`\nApp created.`);

    await probe(`1`, `the org id lookup and createLimitedAccessToken, and that its token reaches the registry`, async () => {
        const organizationId = await organizationIdOf(flyApiToken, flyOrg);
        const minted = await mintAppDeployToken(flyApiToken, organizationId, {
            app: appName,
            name: `intentic spike ${appName}`,
            expiryMinutes: buildTimeoutMinutes + 15,
        });
        mintedTokens.push(minted.id);
        deployToken = minted.token;
        // Proof the token reaches this app's own repository, before a build is spent finding out it does not.
        // A repository with nothing pushed yet answers 404 THROUGH the auth, which is itself the answer.
        const reach = await manifest(repo, `env`, deployToken, `GET`).then(
            (result) => `the registry accepted it (manifest read answered HTTP ${result.status})`,
            (error: unknown) => `MINTED BUT THE REGISTRY REFUSED IT: ${say(error)}`,
        );
        return `organizationIdOf answered a node id, profile \`deploy\` + profileParams.app_id minted token ${minted.id}; ${reach}`;
    });

    if (deployToken === ``) {
        throw new Error(`no deploy token, so there is nothing further to ask: fix §4.1 first`);
    }

    await probe(`3`, `a moby/buildkit machine with \`files\` and an entrypoint override, building a realistic overlay`, async () => {
        const first = await runBuild(`build-a`, probeOverlay(`spike-a`), deployToken, imageRef, builderImage);
        firstBuilder = first.machineId;
        const pushed = await manifest(repo, `env`, deployToken, `GET`);
        firstDigest = pushed.digest;
        return `${builderImage} took ${minutes(first.ms)} for base pull + apt install + cobc compile; ${first.exit}; the tag answers ${
            pushed.status
        } at ${firstDigest || `no digest header`}. Root disk and guest size are in the build log's first RUN step.`;
    });

    await probe(`2`, `a machine in this app booting registry.fly.io/<app> by digest with no further auth`, async () => {
        if (firstDigest === ``) {
            throw new Error(`nothing was pushed, so there is no digest to boot`);
        }
        const booted = await createMachine(flyApiToken, appName, {
            name: `${appName}-boot`,
            region,
            config: flyBuildMachineConfig({
                image: `registry.fly.io/${appName}@${firstDigest}`,
                guest: { cpuKind: `shared`, cpus: 1, memoryMb: 512 },
                files: [],
                entrypoint: [`/bin/sh`, `-c`, `spike || echo "the overlay's binary is not on PATH"`],
            }),
        });
        madeMachines.push(booted.machineId);
        const detail = await waitForEnd(booted.machineId, Date.now() + 5 * 60_000);
        return `booted with no registry credential of its own; state ${detail.state}, image_ref.digest ${
            detail.imageDigest === undefined ? `ABSENT on the machine after boot` : `present (${detail.imageDigest})`
        }`;
    });

    await probe(`4`, `the exit event still on a stopped builder, and force-destroying a running machine`, async () => {
        // The reconcile's fallback for a builder that never reported reads the exit off the machine LONG after
        // it stopped, so the question is not whether the code can parse an exit event but whether Fly still
        // carries one by the time anybody asks.
        const stopped = await (firstBuilder === ``
            ? Promise.resolve(`no builder ran, so there was nothing to re-read`)
            : getMachineDetail(flyApiToken, appName, firstBuilder).then(
                  (detail) =>
                      detail.exitCode === undefined
                          ? `the stopped builder carries NO events[].request.exit_event.exit_code, so the reconcile's fallback is blind`
                          : `the stopped builder still carries exit_event.exit_code ${detail.exitCode}`,
                  (error: unknown) => `the stopped builder could not be re-read: ${say(error)}`,
              ));
        const stray = await createMachine(flyApiToken, appName, {
            name: `${appName}-stray`,
            region,
            config: flyBuildMachineConfig({
                image: builderImage,
                guest: { cpuKind: `shared`, cpus: 1, memoryMb: 512 },
                files: [],
                entrypoint: [`/bin/sh`, `-c`, `sleep 600`],
            }),
        });
        await sleep(10_000);
        await destroyMachine(flyApiToken, appName, stray.machineId, { force: true });
        const gone = await getMachineDetail(flyApiToken, appName, stray.machineId).then(
            (detail) => `still listed in state ${detail.state}`,
            (error: unknown) => (error instanceof FlyError && error.status === 404 ? `404, gone` : `unreadable: ${say(error)}`),
        );
        return `${stopped}. DELETE /apps/{app}/machines/{id}?force=true killed a RUNNING machine; asking about it after answers ${gone}`;
    });

    await probe(`5`, `what a moving tag leaves behind, and whether a manifest DELETE is honoured`, async () => {
        if (firstDigest === ``) {
            throw new Error(`the first build pushed nothing, so there is no old manifest to look for`);
        }
        const second = await runBuild(`build-b`, probeOverlay(`spike-b`), deployToken, imageRef, builderImage);
        const moved = await manifest(repo, `env`, deployToken, `GET`);
        const oldOne = await manifest(repo, firstDigest, deployToken, `GET`);
        const deleted = await manifest(repo, firstDigest, deployToken, `DELETE`).then(
            (result) => `DELETE /v2/<app>/manifests/<digest> answered ${result.status}`,
            (error: unknown) => `DELETE could not be attempted: ${say(error)}`,
        );
        return `the second build took ${minutes(second.ms)} with the layer cache warm; the tag now names ${moved.digest || `nothing`}; the first digest ${
            oldOne.status === 200 ? `IS STILL THERE unreferenced (HTTP 200)` : `is gone on its own (HTTP ${oldOne.status})`
        }; ${deleted}`;
    });

    if (flag(`rootless`)) {
        await probe(`6`, `the same build on the rootless buildkit image`, async () => {
            const rootless = `${builderImage}-rootless`;
            const run = await runBuild(`build-rootless`, probeOverlay(`spike-rootless`), deployToken, imageRef, rootless);
            return `${rootless} took ${minutes(run.ms)}; ${run.exit}. \`files\` and the entrypoint override ${
                run.exit.includes(`exit_code 0`) ? `work under it` : `DID NOT get a clean build: read the log before believing either way`
            }`;
        });
    } else {
        answers.set(`6`, `not run (pass --rootless; it repeats the whole build on <builderImage>-rootless)`);
    }
} catch (error) {
    out(`\nThe spike stopped early: ${say(error)}`);
} finally {
    // Teardown order is load-bearing: the last question is asked of the REGISTRY, with the deploy token, after
    // the app is gone, so the token is revoked at the very end. Revoking first would answer it with a refusal
    // that says nothing about whether the repository outlived its app.
    if (flag(`keep`)) {
        out(`\n--keep: ${appName} is still standing with ${madeMachines.length} machine(s). Delete it yourself: fly apps destroy ${appName}`);
    } else {
        await deleteApp(flyApiToken, appName).then(
            () => out(`\nApp ${appName} destroyed.`),
            (error: unknown) => out(`\nCOULD NOT DESTROY ${appName}: ${say(error)} — delete it by hand, it is costing money.`),
        );
        // The last question, and it can only be asked after the app is gone: does its registry repository go
        // with it, or does the platform keep paying for images of sandboxes that no longer exist?
        if (firstDigest !== `` && deployToken !== ``) {
            const after = await manifest(repo, `env`, deployToken, `GET`).then(
                (result) =>
                    result.status === 200 ? `NO: the repository outlived its app (HTTP 200)` : `yes, the repository answers HTTP ${result.status}`,
                (error: unknown) => `the repository could not be read after the app went: ${say(error)}`,
            );
            answers.set(`4 (repository)`, `deleting the app removes its registry repository? ${after}`);
        }
    }
    for (const id of mintedTokens) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- a handful at most, and teardown is not hot
        await revokeDeployToken(flyApiToken, id).catch((error: unknown) => out(`  could not revoke token ${id}: ${say(error)}`));
    }
}

out(`\n${`─`.repeat(110)}\nPASTE INTO §4 OF docs/hosted-overlay-rebuild-plan.md\n${`─`.repeat(110)}`);
for (const [question, value] of [...answers.entries()].toSorted(([left], [right]) => left.localeCompare(right))) {
    out(`\n${question}. ${value}`);
}
out(``);
