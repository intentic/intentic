import { execFile, spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { packageRoot, repoRoot } from "@intentic/constants/node";
import { cloudflareApi, forgejoApi, sshExecutor } from "@intentic/providers";
import { deploymentId, deploymentPort } from "@intentic/state-resolver";
import { loadConfig } from "./env.config.js";
import { renderTemplate } from "./lib/templates.js";
import { readGeneratedSecrets } from "./secrets/generated-secrets.js";
import { shellQuote } from "@intentic/sandbox-run/quote";

// ssh2 is CommonJS; under raw Node ESM `import { utils }` can't be resolved as a named export, so load it
// through createRequire (the keygen is the only piece we need).
const { utils } = createRequire(import.meta.url)("ssh2") as {
    utils: { generateKeyPairSync: (type: string) => { private: string; public: string } };
};

// A PERSISTENT local demo of the whole intentic flow: boots a long-lived Docker-in-Docker "host" on this
// machine, drives the real CLI (init/resolve/apply) to stand up Forgejo + Komodo behind a Cloudflare tunnel
// and to WIRE the app's CI/CD (Forgejo Actions workflow + a Komodo registry deployment). intentic itself
// never builds or deploys the app, pushing the Dockerfile triggers the Action, which builds + pushes the
// image and Komodo rolls it out. Prints the live URLs + generated admin logins and LEAVES everything running
// so the services can be browsed. `demo down` tears it all back down (host container + tunnel + DNS). This is
// a dev harness, not a shipped `intentic` command, and reuses exactly what the e2e proved.

const exec = promisify(execFile);
const root = repoRoot(import.meta.url);
const cliRoot = packageRoot(import.meta.url);
const hostContext = join(cliRoot, "node_modules/@intentic/dind-host");
const cliJs = join(cliRoot, "dist/cli.js");
const stateDir = join(root, ".demo");
const stateFile = join(stateDir, "state.json");

const CONTAINER = "intentic-demo-host";
const TUNNEL = "intentic-host"; // resolver's tunnelName(host.id) — what cleanup finds it by
const ADMIN = "intentic"; // resolver's adminUsername — the Forgejo/Komodo admin login
const APP = "app";
const ENV = "production";
const APP_BODY = "intentic-demo-live";
const appPort = deploymentPort(deploymentId(APP, ENV));

const config = loadConfig();
const zone = config.cloudflareZone;
const sshPort = config.demo.sshPort;
// Forgejo (3000) and Komodo (9120) are also published straight to localhost so the stack can be browsed
// and the app repo seeded WITHOUT waiting on public DNS, the tunnel/public URLs come up alongside.
const forgejoPort = config.demo.forgejoPort;
const komodoPort = config.demo.komodoPort;

const GIT_URL = `https://git.${zone}`;
const KOMODO_URL = `https://deploy.${zone}`;
const APP_URL = `https://app.${zone}`;

const log = (message: string): void => {
    process.stdout.write(`${message}\n`);
};

// The engine reaches Forgejo/Komodo over their public URLs; route the CLI children's lookups for the demo
// zone through Cloudflare DoH so the just-created records resolve despite this machine's negative cache.
const dohHook = pathToFileURL(join(cliRoot, "doh-lookup.mjs")).href;
const cliEnv: NodeJS.ProcessEnv = {
    ...process.env,
    DEMO_DOH_ZONE: zone,
    NODE_OPTIONS: `${config.nodeOptions} --import=${dohHook}`.trim(),
};

// Stream a child's output so the operator watches the real apply progress; reject on non-zero exit.
const run = (command: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> =>
    new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd: root, env, stdio: ["ignore", "inherit", "inherit"] });
        child.on("error", reject);
        child.on("exit", (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`${command} ${args.join(" ")} exited ${code}`));
            }
        });
    });
const runCli = (...args: string[]): Promise<void> => run(process.execPath, [cliJs, ...args], cliEnv);
const quiet = async (command: string, args: string[]): Promise<boolean> => {
    try {
        await exec(command, args, { maxBuffer: 16 * 1024 * 1024 });
        return true;
    } catch {
        return false;
    }
};

const readToken = async (): Promise<string> => {
    if (config.cloudflareApiToken !== "") {
        return config.cloudflareApiToken.replace(/\\/g, "").trim();
    }
    const envText = await readFile(join(root, "desired-state/.env"), "utf8");
    const match = /^CLOUDFLARE_API_TOKEN=(.*)$/m.exec(envText);
    if (match?.[1] === undefined) {
        throw new Error("CLOUDFLARE_API_TOKEN is not set and was not found in desired-state/.env");
    }
    return match[1].replace(/\\/g, "").trim();
};

const deployConfig = (): string =>
    renderTemplate("demo/deploy.config.ts", { sshPort, app: APP, env: ENV, domain: `app.${zone}`, appPort: String(appPort) });

// Only the externals intentic can't invent; the Forgejo/Komodo admin passwords are intentic-generated into
// desired-state/.secrets.json by resolve/apply (we read them back below to sign in).
const envFile = (privateKey: string, apiToken: string): string => renderTemplate("demo/env", { privateKey, apiToken });

// A trivial buildable app: busybox httpd serving a known body on $PORT (Komodo sets PORT to appPort).
const DOCKERFILE = renderTemplate("demo/Dockerfile", { appBody: APP_BODY });

const ssh = async (command: string): Promise<string> => {
    const session = await sshExecutor.connect({ address: "127.0.0.1", port: sshPort, user: "root", privateKey });
    try {
        const result = await session.exec(command);
        return `${result.stdout}${result.stderr}`;
    } finally {
        await session.dispose();
    }
};

let privateKey = "";

const up = async (): Promise<void> => {
    const apiToken = await readToken();
    const keys = utils.generateKeyPairSync("ed25519");
    privateKey = keys.private;
    // Filled after the platform apply, from the secrets intentic generated into desired-state/.secrets.json.
    let forgejoPassword = "";
    let komodoPassword = "";

    log(`▶ building the demo host image (${CONTAINER}) from @intentic/dind-host …`);
    await run("docker", ["build", "-t", CONTAINER, hostContext]);

    log("▶ starting the persistent Docker-in-Docker host …");
    await quiet("docker", ["rm", "-f", CONTAINER]);
    await run("docker", [
        "run",
        "-d",
        "--privileged",
        // dockerd resolves git.<zone> for the registry-token realm (Forgejo's public ROOT_URL); point the host
        // at Cloudflare's resolver so it never hits the negative-caching Docker Desktop DNS (192.168.65.7).
        // This is the docker-daemon counterpart of the DoH hook the CLI children use for the same zone.
        "--dns",
        "1.1.1.1",
        "--dns",
        "1.0.0.1",
        "--name",
        CONTAINER,
        "-e",
        "DOCKER_TLS_CERTDIR=",
        "-p",
        `${sshPort}:22`,
        "-p",
        `${forgejoPort}:3000`,
        "-p",
        `${komodoPort}:9120`,
        CONTAINER,
    ]);

    log("▶ injecting the demo SSH key …");
    for (let i = 0; i < 60 && !(await quiet("docker", ["exec", CONTAINER, "true"])); i++) {
        await sleep(1000);
    }
    await exec("docker", [
        "exec",
        CONTAINER,
        "sh",
        "-c",
        `mkdir -p /root/.ssh && chmod 700 /root/.ssh && printf '%s\\n' ${shellQuote(keys.public)} > /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys`,
    ]);

    log(`▶ waiting for SSH on 127.0.0.1:${sshPort} …`);
    for (let i = 0; ; i++) {
        try {
            await (await sshExecutor.connect({ address: "127.0.0.1", port: sshPort, user: "root", privateKey })).dispose();
            break;
        } catch (error) {
            if (i >= 90) {
                throw new Error(`host SSH never came up: ${String(error)}`, { cause: error });
            }
            await sleep(1000);
        }
    }

    // Bootstrap into the repo's own gitignored scratch dirs (intent/, desired-state/) instead of a throwaway
    // /tmp workspace, so the generated .secrets.json lands at desired-state/.secrets.json, exactly where
    // `pnpm intentic deploy adopt` (default repo-root paths) reads the Forgejo admin password from.
    const workspace = root;
    const configPath = join(workspace, "intent", "deploy.config.ts");
    const artifactPath = join(workspace, "desired-state", "desired-state.json");

    // Persist enough state up front that `demo down` can always clean up, even if a later step fails.
    await mkdir(stateDir, { recursive: true });
    await writeFile(
        stateFile,
        JSON.stringify(
            {
                zone,
                apiToken,
                container: CONTAINER,
                sshPort,
                urls: { git: GIT_URL, komodo: KOMODO_URL, app: APP_URL },
                local: { git: `http://127.0.0.1:${forgejoPort}`, komodo: `http://127.0.0.1:${komodoPort}` },
            },
            null,
            2,
        ),
    );

    log("▶ scaffolding the intent (deploy init --link) …");
    await runCli("deploy", "init", "--dir", workspace, "--link");
    await writeFile(configPath, deployConfig());
    await writeFile(join(workspace, "desired-state", ".env"), envFile(privateKey, apiToken));

    log("▶ resolve + apply — Forgejo + Komodo + tunnel + the app's CI/CD wiring …");
    await runCli("deploy", "resolve", "--config", configPath, "--out", artifactPath);
    await runCli("deploy", "apply", "--yes", "--artifact", artifactPath, "--maxIterations", "8");

    // Read the admin passwords intentic generated (resolve wrote desired-state/.secrets.json), so the rest of
    // the demo signs in with exactly what bootstrapped Forgejo/Komodo.
    const secrets = await readGeneratedSecrets(join(workspace, "desired-state"));
    forgejoPassword = secrets["FORGEJO_ADMIN_PASSWORD"] ?? "";
    komodoPassword = secrets["KOMODO_ADMIN_PASSWORD"] ?? "";

    const running = await ssh("docker ps --format '{{.Names}}'");
    for (const name of ["intentic-forgejo", "intentic-forgejo-runner", "komodo-core"]) {
        if (!running.includes(name)) {
            throw new Error(`platform container "${name}" is not running on the host:\n${running}`);
        }
    }
    log(`✅ platform up — host containers: ${running.split("\n").filter(Boolean).join(", ")}`);

    log("▶ seeding the app repo (intentic/app @ main) with a Dockerfile …");
    let appDeployed = false;
    try {
        await forgejoApi.commitFile({
            baseUrl: `http://127.0.0.1:${forgejoPort}`,
            user: ADMIN,
            password: forgejoPassword,
            owner: ADMIN,
            name: APP,
            branch: "main",
            path: "Dockerfile",
            content: DOCKERFILE,
            message: "seed demo app",
        });
        // intentic only WIRES CI/CD, the apply above committed the Forgejo Actions workflow + repo secrets and
        // registered the Komodo deployment; it does NOT build or deploy. CI seeded a placeholder Dockerfile, so
        // pushing the real one above triggers the Action: build -> push to the registry -> Komodo rolls it out.
        log(`▶ CI builds + pushes the image and Komodo rolls it out — polling http://127.0.0.1:${appPort} …`);
        const deadline = Date.now() + 5 * 60_000;
        while (!appDeployed && Date.now() < deadline) {
            const hit = (await ssh(`wget -q -T 5 -O- http://127.0.0.1:${appPort} 2>/dev/null || true`)).trim();
            appDeployed = hit.includes(APP_BODY);
            if (!appDeployed) {
                await sleep(2000);
            }
        }
        log(
            appDeployed
                ? `✅ app deployed by CI/CD — serving "${APP_BODY}" on the host`
                : `⚠ app not live yet on :${appPort} (CI/CD may still be running)`,
        );
    } catch (error) {
        log(`⚠ app phase skipped (platform stays up): ${String(error)}`);
    }

    log("");
    log("════════════════════════════════════════════════════════════════════");
    log("  intentic demo is UP and will stay up until you run `pnpm demo:down`");
    log("════════════════════════════════════════════════════════════════════");
    log("  Public (through the Cloudflare tunnel — DNS/edge may take ~1 min):");
    log(`    Forgejo : ${GIT_URL}`);
    log(`    Komodo  : ${KOMODO_URL}`);
    if (appDeployed) {
        log(`    App     : ${APP_URL}`);
    }
    log("  Local (instant, no DNS needed):");
    log(`    Forgejo : http://127.0.0.1:${forgejoPort}`);
    log(`    Komodo  : http://127.0.0.1:${komodoPort}`);
    log("  Admin login (intentic-generated):");
    log(`    user     : ${ADMIN}`);
    log(`    Forgejo pw: ${forgejoPassword}`);
    log(`    Komodo pw : ${komodoPassword}`);
    log(`    (saved in ${join(workspace, "desired-state", ".secrets.json")})`);
    log(`  SSH into the host:  ssh -p ${sshPort} root@127.0.0.1   (key in ${join(workspace, "desired-state", ".env")})`);
    log("  Push the control-plane repos to Forgejo:  pnpm intentic deploy adopt   (once git DNS is live)");
    log("  Stop (reuses tunnel + DNS, fast re-up) :  pnpm demo:down");
    log("  Full teardown (also removes tunnel+DNS):  pnpm demo:clear");
    log("  Note: keep this machine + Docker running; the public URLs share the");
    log("        tunnel name 'intentic-host', so don't run the e2e at the same time.");
    log("════════════════════════════════════════════════════════════════════");
};

interface DemoState {
    readonly zone: string;
    readonly apiToken: string;
}

// Stop the demo without touching Cloudflare: remove the host container (which kills the cloudflared
// connector). The tunnel + DNS records are LEFT intact, so the next `up` reuses the tunnel by name and the
// records already point at it, the connector reconnects in seconds with no DNS delete/recreate, so resolvers
// never cache NXDOMAIN (which would make the domains look dead for up to the zone's negative-TTL). Use `clear`
// to also purge the Cloudflare tunnel + DNS.
const down = async (): Promise<void> => {
    log(`▶ stopping the demo host container (${CONTAINER}) — leaving the Cloudflare tunnel + DNS for a fast re-up …`);
    await quiet("docker", ["rm", "-f", CONTAINER]);
    log("✅ demo stopped. `pnpm demo:up` reconnects in seconds (tunnel + DNS reused); `pnpm demo:clear` tears down Cloudflare too.");
};

// Full teardown: remove the host container AND purge the live Cloudflare resources this demo created (the
// tunnel + DNS records), then drop the local state.
const clear = async (): Promise<void> => {
    const state: Partial<DemoState> = await readFile(stateFile, "utf8")
        .then((text) => JSON.parse(text) as DemoState)
        .catch(() => ({}));
    const zoneName = state.zone ?? zone;
    const apiToken = state.apiToken ?? (await readToken());

    log(`▶ removing the demo host container (${CONTAINER}) …`);
    await quiet("docker", ["rm", "-f", CONTAINER]);

    log("▶ deleting the Cloudflare tunnel + DNS records …");
    // Account + zone id both come from resolving the zone name (the same discovery resolve does), so the
    // teardown needs only the zone name + token, no separately-configured account.
    const cfZone = await cloudflareApi.getZone({ apiToken, zone: zoneName }).catch(() => undefined);
    if (cfZone !== undefined) {
        const tunnel = await cloudflareApi.findTunnel({ accountId: cfZone.accountId, apiToken, name: TUNNEL }).catch(() => undefined);
        if (tunnel !== undefined) {
            await fetch(`https://api.cloudflare.com/client/v4/accounts/${cfZone.accountId}/cfd_tunnel/${tunnel.id}/connections`, {
                method: "DELETE",
                headers: { Authorization: `Bearer ${apiToken}` },
            }).catch(() => {});
            await cloudflareApi
                .deleteTunnel({ accountId: cfZone.accountId, apiToken, tunnelId: tunnel.id })
                .catch((error) => log(`  tunnel: ${String(error)}`));
        }
        for (const name of [`git.${zoneName}`, `deploy.${zoneName}`, `app.${zoneName}`]) {
            const record = await cloudflareApi.findDnsRecord({ apiToken, zoneId: cfZone.id, name }).catch(() => undefined);
            if (record !== undefined) {
                await cloudflareApi
                    .deleteDnsRecord({ apiToken, zoneId: cfZone.id, recordId: record.id })
                    .catch((error) => log(`  dns ${name}: ${String(error)}`));
            }
        }
    }

    // intent/ + desired-state/ are gitignored scratch dirs holding the generated .secrets.json, left in place
    // so `intentic deploy adopt` can still run after teardown.
    await rm(stateDir, { recursive: true, force: true }).catch(() => {});
    log("✅ demo cleared — host container, tunnel, and DNS records removed (intent/ + desired-state/ kept).");
};

const mode = process.argv[2];
if (mode === "up") {
    await up();
} else if (mode === "down") {
    await down();
} else if (mode === "clear" || mode === "clean") {
    await clear();
} else {
    log("usage: demo <up|down|clear>");
    process.exit(1);
}
