import type { HostConfig } from "@intentic/sandbox-contract";
import { HOST_TOOLS_NOTE } from "../../hosts/host-skills.js";
import { loadedSkillFile, removeLoadedSkill, writeLoadedSkill } from "../../settings/loaded-skills.js";
import type { CapabilityHandler } from "../capability.js";
import { contributedSkill, contributionKey, contributionRegistry, hostOf } from "../contributions.js";

// A device of the user's OWN, one capability per machine, the id being its name. `apply` writes the platform's
// skill pack and pushes the scopes to the machine if it is up; the machine itself is connected out-of-band, by
// running the card's one-liner on it (which enrolls over /system/hosts/enroll and dials back in). Distinct from
// `ssh`, where the sandbox does the dialling and there is nothing to install on the far end.
//
// The OS pack is data in an installed extension's `contributes.capabilities`; the tool surface it wraps, the
// enrollment and the scope enforcement are core (host-skills.ts, hosts/).

export const hostHandler: CapabilityHandler = {
    // A connected device's credential is its enrollment token, which lives on /history (hosts-store.ts) and is
    // never in the manifest, rotating it is re-running the installer there, not an edit in /secrets. So: no secret.
    echo: (config) => {
        // Every field is a permission and none is secret: the card renders the grant back to the owner.
        const host = config as HostConfig;
        return {
            platform: host.platform,
            shell: host.shell,
            write: host.write,
            screen: host.screen,
            control: host.control,
            sandboxes: host.sandboxes,
            sandboxRemove: host.sandboxRemove,
            destructive: host.destructive,
            ...(host.roots !== undefined ? { roots: host.roots } : {}),
        };
    },
    /* The enrollment travels with the name, so a renamed device is not a device somebody has to walk over
     * to and re-pair. Its live socket is cut instead: the machine is authenticated by a token this daemon still
     * honours, and reconnecting is what makes it announce itself under the name it now has. */
    rename: {
        carry: async (ctx, from, to) => {
            await ctx.hosts.rename(from, to);
            ctx.hostHub.disconnect(from, "this device was renamed: reconnecting under its new name");
            await removeLoadedSkill(ctx.files, ctx.workspace.root, from);
        },
    },
    async *apply(ctx, id, config) {
        const host = config as HostConfig;
        const contribution = (await contributionRegistry(hostOf(ctx))).get(contributionKey("host", host.platform));
        if (contribution === undefined) {
            throw new Error(`no host platform "${host.platform}": install the extension that declares it`);
        }
        const skill = await contributedSkill(contribution, id, HOST_TOOLS_NOTE);
        if (skill === undefined) {
            throw new Error(`the extension declaring "${host.platform}" has no readable skill pack: reinstall it`);
        }
        await writeLoadedSkill(ctx.files, ctx.workspace.root, id, skill);
        if (!(await ctx.hosts.enrolled(id))) {
            yield {
                kind: "log",
                message: `Added "${id}". Run the one-time command its card is offering on that device, the agent can work on it from the next turn.`,
            };
            return;
        }
        // An edit of the scopes is a decision about what may happen on somebody's device RIGHT NOW, so it
        // travels immediately rather than at the machine's next reconnect. The machine is the enforcement point;
        // this is the only thing that moves the boundary it enforces.
        const pushed = await ctx.hostHub.pushScopes(id, host);
        yield {
            kind: "log",
            message: pushed
                ? `Updated "${id}": the new permissions are in force on that device now.`
                : `Saved. "${id}" is offline; the new permissions apply the moment it reconnects.`,
        };
    },
    // Four distinct states, because the user's next action differs in each: nothing applied yet, applied but the
    // device was never connected (run the one-liner), connected but asleep (open the lid), working.
    status: async (ctx, id) => {
        if ((await ctx.files.read(loadedSkillFile(ctx.workspace.root, id))) === undefined) {
            return { state: "inactive" };
        }
        if (!(await ctx.hosts.enrolled(id))) {
            return { state: "pending", detail: "click Connect and run the one-liner on that device" };
        }
        return ctx.hostHub.online(id) ? { state: "active" } : { state: "pending", detail: "the device is offline" };
    },
    // Removing the capability revokes the machine's key and cuts its socket. What stays is the agent binary
    // installed over there, only somebody at that machine can uninstall it, and with its enrollment gone it can
    // no longer reach this sandbox at all.
    remove: async (ctx, id) => {
        ctx.hostHub.disconnect(id, "this device was disconnected from the sandbox");
        await ctx.hosts.revoke(id);
        await removeLoadedSkill(ctx.files, ctx.workspace.root, id);
    },
};
