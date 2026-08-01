import { join } from "node:path";
import type { HostConfig } from "@intentic/sandbox-contract";
import { hostSkill } from "../../hosts/host-skills.js";
import type { CapabilityHandler } from "../capability.js";

// A computer of the user's OWN — one capability per machine, the id being its name. `apply` writes the platform's
// skill pack and pushes the scopes to the machine if it is up; the machine itself is connected out-of-band, by
// running the card's one-liner on it (which enrolls over /system/hosts/enroll and dials back in). Distinct from
// `ssh`, where the sandbox does the dialling and there is nothing to install on the far end.
const skillDir = (root: string, id: string): string => join(root, ".claude", "skills", id);
const skillPath = (root: string, id: string): string => join(skillDir(root, id), "SKILL.md");

export const hostHandler: CapabilityHandler = {
    apply: async function* (ctx, id, config) {
        const host = config as HostConfig;
        await ctx.files.write(skillPath(ctx.workspace.root, id), hostSkill(id, host.platform));
        if (!(await ctx.hosts.enrolled(id))) {
            yield {
                kind: "log",
                message: `Added "${id}". Open its card and click Connect, then run the one-liner on that computer — the agent can work on it from the next turn.`,
            };
            return;
        }
        // An edit of the scopes is a decision about what may happen on somebody's computer RIGHT NOW, so it
        // travels immediately rather than at the machine's next reconnect. The machine is the enforcement point;
        // this is the only thing that moves the boundary it enforces.
        const pushed = await ctx.hostHub.pushScopes(id, host);
        yield {
            kind: "log",
            message: pushed
                ? `Updated "${id}" — the new permissions are in force on that computer now.`
                : `Saved. "${id}" is offline; the new permissions apply the moment it reconnects.`,
        };
    },
    // Four distinct states, because the user's next action differs in each: nothing applied yet, applied but the
    // computer was never connected (run the one-liner), connected but asleep (open the lid), working.
    status: async (ctx, id) => {
        if ((await ctx.files.read(skillPath(ctx.workspace.root, id))) === undefined) {
            return { state: "inactive" };
        }
        if (!(await ctx.hosts.enrolled(id))) {
            return { state: "pending", detail: "click Connect and run the one-liner on that computer" };
        }
        return ctx.hostHub.online(id) ? { state: "active" } : { state: "pending", detail: "the computer is offline" };
    },
    // Removing the capability revokes the machine's key and cuts its socket. What stays is the agent binary
    // installed over there — only somebody at that machine can uninstall it, and with its enrollment gone it can
    // no longer reach this sandbox at all.
    remove: async (ctx, id) => {
        ctx.hostHub.disconnect(id, "this computer was disconnected from the sandbox");
        await ctx.hosts.revoke(id);
        await ctx.files.remove(skillDir(ctx.workspace.root, id));
    },
};
