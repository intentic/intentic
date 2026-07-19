import { spawnSync } from "node:child_process";
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { type PortSummary, PortsListSchema } from "@intentic/sandbox-contract";
import { buildCommand, type CommandContext } from "@stricli/core";
import { knownHostsPath, readConfig, type SyncConfig, sshKeyPath, writeConfig } from "./config.js";
import { ensureCloudflared, ensureMutagen, forwardSessionName, mutagenCreateArgs, mutagenForwardArgs, runMutagen, sessionName } from "./mutagen.js";
import { ensureSshKey, INCLUDE_MARKER, sanitizeId, sshAlias, sshConfigBlock, writeManagedSshConfig } from "./ssh.js";

// Enroll our SSH public key using the browser-minted pairing token (single-use). The daemon returns the tunnel's
// SSH hostname + the sync token `mirror` reads /ports with — the only HTTP surface the agent ever touches;
// everything else is Mutagen over SSH.
// This fires right after connect.sh starts the sandbox's cloudflared sidecar, so the public tunnel may still be
// warming up: Cloudflare's edge answers before the origin is registered (transient 502/503/504), or the host
// doesn't resolve yet (fetch throws). Retry through that. 401 (pairing expired) and other 4xx are the daemon's
// own definitive answers — never retried.
// ponytail: fixed ~30s window (10 × 3s); widen only if real tunnel warmups exceed it.
export const enrollKey = async (
    sandboxUrl: string,
    pairToken: string,
    key: string,
    { attempts = 10, delayMs = 3000, takeover = false }: { attempts?: number; delayMs?: number; takeover?: boolean } = {},
): Promise<{ sshHostname: string; syncToken?: string }> => {
    const url = `${sandboxUrl.replace(/\/$/, "")}/system/authorized-key`;
    for (let attempt = 1; ; attempt++) {
        let response: Response;
        try {
            response = await fetch(url, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "x-intentic-pair": pairToken,
                    ...(takeover ? { "x-intentic-sync-takeover": "1" } : {}),
                },
                body: JSON.stringify({ key }),
            });
        } catch (error) {
            if (attempt >= attempts) throw error;
            process.stderr.write(`enrolling the sync key — sandbox tunnel not reachable yet, retrying (${attempt}/${attempts})…\n`);
            await sleep(delayMs);
            continue;
        }
        if (response.status === 401) {
            throw new Error("pairing expired — click “Enable desktop sync” again in your browser for a fresh command.");
        }
        if (response.status >= 500 && attempt < attempts) {
            process.stderr.write(
                `enrolling the sync key — sandbox tunnel warming up (HTTP ${response.status}), retrying (${attempt}/${attempts})…\n`,
            );
            await sleep(delayMs);
            continue;
        }
        // 423 = another machine already holds sync for this sandbox. The daemon won't clobber it without an
        // explicit takeover, so tell the user how to move it here rather than silently kicking the other machine.
        if (response.status === 423) {
            const held = (await response.json().catch(() => ({}))) as { machine?: string };
            const from = held.machine !== undefined ? ` from "${held.machine}"` : "";
            throw new Error(
                `desktop sync is already active on this sandbox${from}. Re-run with --takeover to move it to this machine (this stops syncing on the other one).`,
            );
        }
        if (!response.ok) {
            throw new Error(`enrolling the sync key failed (${response.status}): ${await response.text()}`);
        }
        const body = (await response.json()) as { sshHostname?: string; syncToken?: string };
        if (body.sshHostname === undefined) {
            throw new Error("this sandbox has no SSH tunnel configured for sync — reconnect it so its tunnel routes ssh-<id>.<zone>.");
        }
        // syncToken stays optional: a daemon predating port mirroring still syncs files fine — only `mirror`
        // needs it, and it reports the gap itself.
        return { sshHostname: body.sshHostname, ...(body.syncToken === undefined ? {} : { syncToken: body.syncToken }) };
    }
};

interface SetupFlags {
    readonly url: string;
    readonly pair: string;
    readonly dir?: string;
    readonly sandboxId?: string;
    readonly takeover: boolean;
}

const setup = buildCommand<SetupFlags>({
    docs: { brief: "Enroll an SSH key with a pairing token and start a Mutagen sync of the local dir ↔ sandbox /work" },
    parameters: {
        flags: {
            url: { kind: "parsed", parse: String, brief: "The sandbox's public URL (e.g. https://sandbox-xxx.example.dev)" },
            pair: { kind: "parsed", parse: String, brief: "The one-time pairing token from the Desktop sync card" },
            dir: { kind: "parsed", parse: String, optional: true, brief: "Local directory to sync (default: ~/intentic/<sandbox>)" },
            sandboxId: { kind: "parsed", parse: String, optional: true, brief: "Session/alias id (default: the sandbox URL host)" },
            takeover: { kind: "boolean", brief: "Take over sync from another machine already enrolled on this sandbox (revokes its key)" },
        },
    },
    async func(this: CommandContext, flags: SetupFlags) {
        const out = (message: string): void => void this.process.stdout.write(`${message}\n`);
        const publicKey = await ensureSshKey();
        const { sshHostname, syncToken } = await enrollKey(flags.url, flags.pair, publicKey, { takeover: flags.takeover });
        out(`enrolled SSH key; sandbox reachable at ${sshHostname}`);

        const sandboxId = flags.sandboxId ?? sanitizeId(new URL(flags.url).host);
        // A `~` prefix can reach us verbatim (SYNC_DIR travels as data from the setup wizard's claim payload —
        // no shell ever expands it), so expand it here where every entry path converges.
        const localDir = resolve(flags.dir === undefined ? join(homedir(), "intentic", sandboxId) : flags.dir.replace(/^~(?=[\\/]|$)/, homedir()));
        // Create the local root up front — Mutagen only materializes it once content propagates, and an
        // immediately-visible folder is the user's anchor that setup worked.
        await mkdir(localDir, { recursive: true });
        const cloudflaredPath = await ensureCloudflared();
        const mutagen = await ensureMutagen();
        await writeManagedSshConfig(
            sshConfigBlock({
                alias: sshAlias(sandboxId),
                hostname: sshHostname,
                identityFile: sshKeyPath,
                knownHostsFile: knownHostsPath,
                cloudflaredPath,
            }),
        );

        const config: SyncConfig = { sandboxUrl: flags.url, sandboxId, sshHostname, localDir, ...(syncToken === undefined ? {} : { syncToken }) };
        await writeConfig(config);

        // Terminate any previous session of the same name so re-running setup (a fresh pairing) replaces it
        // instead of failing on the name collision. Silent: "no session found" is the common case.
        spawnSync(mutagen, ["sync", "terminate", sessionName(sandboxId)], { stdio: "ignore" });
        runMutagen(
            mutagen,
            mutagenCreateArgs({ name: sessionName(sandboxId), localDir: config.localDir, alias: sshAlias(sandboxId), remoteDir: "/work" }),
        );
        // Register the Mutagen daemon to autostart at login and resume sessions across reboots (its own native
        // mechanism — launchd/Task Scheduler; Mutagen has no register on Linux, where the daemon parent command
        // would just dump its help). Best-effort: already-registered is not an error worth failing on.
        if (process.platform !== "linux") {
            try {
                runMutagen(mutagen, ["daemon", "register"]);
            } catch (error) {
                out(
                    `note: could not register the Mutagen daemon for autostart (${error instanceof Error ? error.message : String(error)}); it still runs while you're logged in.`,
                );
            }
        }
        out(`Sync started: ${config.localDir} ↔ ${sshHostname}:/work. Check it with \`intentic-sync status\`.`);
    },
});

const withMutagen = async (run: (mutagen: string, name: string) => void): Promise<void> => {
    const config = await readConfig();
    run(await ensureMutagen(), sessionName(config.sandboxId));
};

// The sandbox's currently-listening WORKSPACE ports (dev servers, terminal processes, published containers) —
// what `mirror` reconciles against. Authenticated by the enrollment-minted sync token, which the daemon scopes
// to exactly this read. System ports (the sandbox's own machinery) are never mirrored.
export const fetchWorkspacePorts = async (sandboxUrl: string, syncToken: string): Promise<PortSummary[]> => {
    const response = await fetch(`${sandboxUrl.replace(/\/$/, "")}/ports`, { headers: { "x-intentic-sync": syncToken } });
    if (response.status === 401 || response.status === 403) {
        throw new Error("the sandbox rejected the sync token — click “Enable desktop sync” in your browser and re-run setup to mint a fresh one.");
    }
    if (!response.ok) {
        throw new Error(`reading the sandbox's ports failed (${response.status}): ${await response.text()}`);
    }
    return PortsListSchema.parse(await response.json()).ports.filter((port) => port.kind === "workspace");
};

// Whether the local loopback port is free to bind — checked after terminating our own prior forward (which
// held it), so a remaining conflict is genuinely foreign (something else on this machine owns the port).
const localPortFree = (port: number): Promise<boolean> =>
    new Promise((resolvePort) => {
        const probe = net.createServer();
        probe.once("error", () => resolvePort(false));
        probe.listen(port, "127.0.0.1", () => probe.close(() => resolvePort(true)));
    });

interface MirrorFlags {
    readonly stop: boolean;
}

// Port mirroring: every workspace port listening in the sandbox becomes the SAME port on this machine's
// localhost, over Mutagen TCP forward sessions riding the enrolled SSH transport. This is what makes remote
// development feel local — a frontend baked with `https://localhost:6480` just works, cookies and CORS
// included, because localhost IS serving it. One-shot reconcile (Mutagen's daemon keeps the pipes alive):
// re-run after starting/stopping dev servers; sessions for vanished ports are terminated, live ones recreated.
const mirror = buildCommand<MirrorFlags>({
    docs: { brief: "Mirror the sandbox's workspace ports onto this machine's localhost (re-run to refresh; --stop to end)" },
    parameters: {
        flags: {
            stop: { kind: "boolean", brief: "Terminate every mirror forward session" },
        },
    },
    async func(this: CommandContext, flags: MirrorFlags) {
        const out = (message: string): void => void this.process.stdout.write(`${message}\n`);
        const config = await readConfig();
        const mutagen = await ensureMutagen();
        const current = config.mirroredPorts ?? [];
        // Terminate silently — "no session found" (user cleaned up by hand) is not an error worth surfacing.
        const terminate = (port: number): void =>
            void spawnSync(mutagen, ["forward", "terminate", forwardSessionName(config.sandboxId, port)], { stdio: "ignore" });

        if (flags.stop) {
            for (const port of current) {
                terminate(port);
            }
            await writeConfig({ ...config, mirroredPorts: [] });
            out(current.length === 0 ? "nothing was mirrored." : `stopped mirroring ${current.length} port(s).`);
            return;
        }

        if (config.syncToken === undefined) {
            throw new Error("this pairing predates port mirroring — click “Enable desktop sync” in your browser and re-run setup.");
        }
        const ports = await fetchWorkspacePorts(config.sandboxUrl, config.syncToken);
        for (const port of current.filter((candidate) => !ports.some(({ port: live }) => live === candidate))) {
            terminate(port);
        }
        const mirrored: number[] = [];
        for (const summary of ports) {
            // Recreate rather than diff: terminating our own prior session frees the local bind, and a fresh
            // create picks up a listener that moved between loopback families. Mid-connection re-runs drop
            // active sockets for a moment — an explicit user action, not a background surprise.
            terminate(summary.port);
            // oxlint-disable-next-line eslint/no-await-in-loop -- a handful of ports; sequenced keeps output readable
            if (!(await localPortFree(summary.port))) {
                out(`  localhost:${summary.port} is busy on this machine — skipped (${summary.command ?? "unknown process"})`);
                continue;
            }
            runMutagen(
                mutagen,
                mutagenForwardArgs({
                    name: forwardSessionName(config.sandboxId, summary.port),
                    port: summary.port,
                    alias: sshAlias(config.sandboxId),
                    host: summary.host,
                }),
            );
            mirrored.push(summary.port);
            out(`  localhost:${summary.port} ← ${summary.command ?? "unknown process"}`);
        }
        await writeConfig({ ...config, mirroredPorts: mirrored });
        if (mirrored.length === 0) {
            out("nothing to mirror — no workspace ports are listening in the sandbox.");
            return;
        }
        out(`mirroring ${mirrored.length} port(s). Re-run \`intentic-sync mirror\` after starting/stopping dev servers; \`--stop\` ends it.`);
    },
});

const status = buildCommand<Record<string, never>>({
    docs: { brief: "Show Mutagen sync status" },
    parameters: { flags: {} },
    async func() {
        runMutagen(await ensureMutagen(), ["sync", "list"]);
    },
});

const pause = buildCommand<Record<string, never>>({
    docs: { brief: "Pause syncing" },
    parameters: { flags: {} },
    async func() {
        await withMutagen((mutagen, name) => runMutagen(mutagen, ["sync", "pause", name]));
    },
});

const resume = buildCommand<Record<string, never>>({
    docs: { brief: "Resume syncing" },
    parameters: { flags: {} },
    async func() {
        await withMutagen((mutagen, name) => runMutagen(mutagen, ["sync", "resume", name]));
    },
});

const uninstall = buildCommand<Record<string, never>>({
    docs: { brief: "Terminate the sync session and remove the managed ssh-config include" },
    parameters: { flags: {} },
    async func(this: CommandContext) {
        await withMutagen((mutagen, name) => runMutagen(mutagen, ["sync", "terminate", name]));
        const userConfig = join(homedir(), ".ssh", "config");
        const current = await readFile(userConfig, "utf8").catch(() => "");
        const stripped = current
            .split("\n")
            .filter((line) => line.trim() !== INCLUDE_MARKER)
            .join("\n");
        if (stripped !== current) {
            await writeFile(userConfig, stripped, { mode: 0o600 });
        }
        this.process.stdout.write(
            "Sync terminated; ssh-config include removed. (The Mutagen daemon stays registered — `mutagen daemon unregister` to remove it.)\n",
        );
    },
});

export const commands = { setup, mirror, status, pause, resume, uninstall };
