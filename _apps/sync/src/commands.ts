import { spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { buildCommand, type CommandContext } from "@stricli/core";
import { knownHostsPath, readConfig, type SyncConfig, sshKeyPath, writeConfig } from "./config.js";
import { ensureCloudflared, ensureMutagen, mutagenCreateArgs, runMutagen, sessionName } from "./mutagen.js";
import { ensureSshKey, INCLUDE_MARKER, sanitizeId, sshAlias, sshConfigBlock, writeManagedSshConfig } from "./ssh.js";

// Enroll our SSH public key using the browser-minted pairing token (single-use). The daemon returns the tunnel's
// SSH hostname — the one and only call the agent makes over HTTP; everything after is Mutagen over SSH.
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
): Promise<string> => {
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
        const body = (await response.json()) as { sshHostname?: string };
        if (body.sshHostname === undefined) {
            throw new Error("this sandbox has no SSH tunnel configured for sync — reconnect it so its tunnel routes ssh-<id>.<zone>.");
        }
        return body.sshHostname;
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
        const sshHostname = await enrollKey(flags.url, flags.pair, publicKey, { takeover: flags.takeover });
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

        const config: SyncConfig = { sandboxUrl: flags.url, sandboxId, sshHostname, localDir };
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

export const commands = { setup, status, pause, resume, uninstall };
