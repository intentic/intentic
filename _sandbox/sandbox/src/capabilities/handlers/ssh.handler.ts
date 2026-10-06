import type { SshConfig } from "@intentic/sandbox-contract";
import { readFile, writeFile } from "node:fs/promises";
import { removeLoadedSkill, writeLoadedSkill } from "../../store/loaded-skills.js";
import type { CapabilityHandler } from "../capability.js";
import { publicKeyOf, publicLineOf } from "../credentials/ssh-keys.js";
import {
    hostConfPath,
    hostKeyFilePath,
    hostPassPath,
    hostPublicKeyPath,
    removeSshHost,
    writeHostKeyFile,
    writeHostPublicKey,
    writeSshHost,
} from "../ssh-hosts.js";

// An SSH capability: give the AGENT a remote machine to operate. One capability = one machine; the id is its
// ssh-config Host alias, so the agent just runs `ssh <id> "…"`. `apply` writes a per-machine config block (via the
// shared ssh-hosts writer) under ~/.ssh/intentic-hosts and puts the credential where it belongs:
//   - a key: into the daemon's key store, with only its public half beside the config. The sandbox's ssh agent signs
//     with it (capabilities/broker/ssh-agent.ts), so the agent's ssh connects and never holds the key, and each
//     signature a conversation asks for passes the card's gate and lands in the use ledger.
//   - a key with a passphrase: a 0600 file, as before, since the agent cannot sign with it and the passphrase protects
//     it where it sits.
//   - a password: a 0600 file sshpass reads. Nothing can sign for a password, so the agent does hold this one; the
//     Secrets view says so.
// Unlike `cli`, nothing rides the agent's env but the agent socket, so many machines never collide. One shared skill
// (below) covers them all.

const SSH_SKILL = `---
name: ssh
description: Run commands and copy files on the connected remote machines over SSH. Use when the user asks to operate on, deploy to, inspect, or run something on a server / host / machine.
---

# SSH machines (connected)

Each connected machine is an ssh-config Host alias in \`~/.ssh/intentic-hosts/\`. There is no separate credential
to manage: \`ssh <alias>\` is already configured (host, user, port, key).

- List connected machines: \`grep -h '^Host ' ~/.ssh/intentic-hosts/*.conf\`
- Run a command: \`ssh <alias> "uptime"\`
- Copy a file up: \`scp ./local.txt <alias>:/remote/path\`, down: \`scp <alias>:/remote/path ./\`
- Sync a directory: \`rsync -az ./dir/ <alias>:/remote/dir/\`

Keys are held by the sandbox's ssh agent, which your shell reaches through \`SSH_AUTH_SOCK\`: ssh, scp, rsync and git
use it without any flag, and there is no private key file to read or pass with \`-i\`. Keep \`SSH_AUTH_SOCK\` as it is.
A machine whose owner gated it raises an approval card the first time you connect; if that signature is refused, ssh
says "agent refused operation": do not retry, say what you left undone.

If a machine uses password auth, a \`~/.ssh/intentic-hosts/<alias>.pass\` file exists: prefix the command with
\`sshpass -f ~/.ssh/intentic-hosts/<alias>.pass\`, e.g. \`sshpass -f ~/.ssh/intentic-hosts/<alias>.pass ssh <alias> "uptime"\`.

Notes: first connect to a machine auto-accepts its host key (accept-new). \`<alias>\` is the name the machine was
connected under.
`;

// Where an ssh card's credential lives, which decides the IdentityFile its alias names.
const keyPlacement = async (ctx: Parameters<CapabilityHandler["apply"]>[0], id: string, privateKey: string): Promise<string> => {
    const publicLine = publicLineOf(privateKey);
    if (publicLine === undefined) {
        // A passphrase-protected key (or one ssh2 cannot read): a file, as before, and nothing in the store.
        await ctx.sshKeys.remove(id);
        await writeHostKeyFile(id, privateKey);
        return hostKeyFilePath(id);
    }
    await ctx.sshKeys.put(id, privateKey);
    await writeHostPublicKey(id, publicLine);
    return hostPublicKeyPath(id);
};

// A generated key and a pasted one differ only in where they came from; both sign in with a key file.
export const sshHandler: CapabilityHandler = {
    secret: (config) => ((config as SshConfig).auth === "password" ? "password" : "privateKey"),
    echo: (config) => {
        const ssh = config as SshConfig;
        const echoed = { host: ssh.host, port: ssh.port, user: ssh.user, auth: ssh.auth };
        // The public half, read off the key, so an edit form can show what to authorize on a server again.
        const publicKey = ssh.auth === "password" ? undefined : publicKeyOf(ssh.privateKey);
        return publicKey === undefined ? echoed : { ...echoed, publicKey };
    },
    // The id IS the ssh-config alias, so the re-apply writes the new machine block and this drops the old one,
    // otherwise `ssh <old-name>` would go on working, which is a second machine as far as anyone reading the
    // config is concerned. The skill is shared by every alias and says nothing about any one of them.
    rename: {
        carry: async (ctx, from) => {
            await removeSshHost(from);
            await ctx.sshKeys.remove(from);
        },
    },
    async *apply(ctx, id, config) {
        const ssh = config as SshConfig;
        // Every file of a previous apply goes first: a machine switched from a key to a password (or back) must not keep
        // the credential it no longer uses.
        await removeSshHost(id);
        if (ssh.auth === "password") {
            await ctx.sshKeys.remove(id);
            await writeSshHost(id, { host: ssh.host, user: ssh.user, port: ssh.port });
            await writeFile(hostPassPath(id), ssh.password, { mode: 0o600 });
        } else {
            const identityFile = await keyPlacement(ctx, id, ssh.privateKey);
            await writeSshHost(id, { host: ssh.host, user: ssh.user, port: ssh.port, identityFile });
        }
        await writeLoadedSkill(ctx.files, ctx.workspace.root, "ssh", SSH_SKILL);
        yield { kind: "log", message: `Connected ${id}. The agent can reach it next turn via \`ssh ${id}\`.` };
    },
    status: async (_ctx, id) =>
        (await readFile(hostConfPath(id), "utf8").catch(() => undefined)) !== undefined ? { state: "active" } : { state: "inactive" },
    remove: async (ctx, id) => {
        await removeSshHost(id);
        await ctx.sshKeys.remove(id);
        // The skill is shared by every ssh machine, drop it only when this was the last one. The route removes
        // the manifest entry AFTER this handler, so `id` is still counted here.
        const sshCount = (await ctx.capabilities.list()).filter((capability) => capability.kind === "ssh").length;
        if (sshCount <= 1) {
            await removeLoadedSkill(ctx.files, ctx.workspace.root, "ssh");
        }
    },
};
