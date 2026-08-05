import type { SshConfig } from "@intentic/sandbox-contract";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CapabilityHandler } from "../capability.js";
import { hostConfPath, hostKeyPath, hostPassPath, removeSshHost, writeSshHost } from "../ssh-hosts.js";

// An SSH capability: give the AGENT a remote machine to operate. One capability = one machine; the id is its
// ssh-config Host alias, so the agent just runs `ssh <id> "…"`. `apply` writes a per-machine config block (via the
// shared ssh-hosts writer) plus a 0600 key/password file under ~/.ssh/intentic-hosts. Unlike `cli`, nothing rides
// the agent's env, so many machines never collide. One shared skill (below) covers them all.

const skillDir = (root: string): string => join(root, ".claude", "skills", "ssh");
const skillPath = (root: string): string => join(skillDir(root), "SKILL.md");

const SSH_SKILL = `---
name: ssh
description: Run commands and copy files on the connected remote machines over SSH. Use when the user asks to operate on, deploy to, inspect, or run something on a server / host / machine.
---

# SSH machines (connected)

Each connected machine is an ssh-config Host alias in \`~/.ssh/intentic-hosts/\`. There is no separate credential
to manage — \`ssh <alias>\` is already configured (host, user, port, key).

- List connected machines: \`grep -h '^Host ' ~/.ssh/intentic-hosts/*.conf\`
- Run a command: \`ssh <alias> "uptime"\`
- Copy a file up: \`scp ./local.txt <alias>:/remote/path\` — down: \`scp <alias>:/remote/path ./\`
- Sync a directory: \`rsync -az ./dir/ <alias>:/remote/dir/\`

If a machine uses password auth, a \`~/.ssh/intentic-hosts/<alias>.pass\` file exists — prefix the command with
\`sshpass -f ~/.ssh/intentic-hosts/<alias>.pass\`, e.g. \`sshpass -f ~/.ssh/intentic-hosts/<alias>.pass ssh <alias> "uptime"\`.

Notes: first connect to a machine auto-accepts its host key (accept-new). \`<alias>\` is the name the machine was
connected under.
`;

export const sshHandler: CapabilityHandler = {
    secret: (config) => ((config as SshConfig).auth === "key" ? "privateKey" : "password"),
    echo: (config) => {
        const ssh = config as SshConfig;
        return { host: ssh.host, port: ssh.port, user: ssh.user, auth: ssh.auth };
    },
    apply: async function* (ctx, id, config) {
        const ssh = config as SshConfig;
        await writeSshHost(id, { host: ssh.host, user: ssh.user, port: ssh.port, ...(ssh.auth === "key" ? { identityFile: hostKeyPath(id) } : {}) });
        if (ssh.auth === "key") {
            await writeFile(hostKeyPath(id), ssh.privateKey.endsWith("\n") ? ssh.privateKey : `${ssh.privateKey}\n`, { mode: 0o600 });
        } else {
            await writeFile(hostPassPath(id), ssh.password, { mode: 0o600 });
        }
        await ctx.files.write(skillPath(ctx.workspace.root), SSH_SKILL);
        yield { kind: "log", message: `Connected ${id}. The agent can reach it next turn via \`ssh ${id}\`.` };
    },
    status: async (_ctx, id) =>
        (await readFile(hostConfPath(id), "utf8").catch(() => undefined)) !== undefined ? { state: "active" } : { state: "inactive" },
    remove: async (ctx, id) => {
        await removeSshHost(id);
        // The skill is shared by every ssh machine — drop it only when this was the last one. The route removes
        // the manifest entry AFTER this handler, so `id` is still counted here.
        const sshCount = (await ctx.capabilities.list()).filter((capability) => capability.kind === "ssh").length;
        if (sshCount <= 1) {
            await ctx.files.remove(skillDir(ctx.workspace.root));
        }
    },
};
