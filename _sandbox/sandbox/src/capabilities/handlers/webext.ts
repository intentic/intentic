import type { WebExtConfig } from "@intentic/sandbox-contract";
import { WEBEXT_TOOLS_NOTE } from "../../webext/webext-skills.js";
import { loadedSkillFile, removeLoadedSkill, writeLoadedSkill } from "../../settings/loaded-skills.js";
import type { CapabilityHandler } from "../capability.js";
import { contributedSkill, contributionKey, contributionRegistry, hostOf } from "../contributions.js";

/* A BROWSER OF THE USER'S OWN, reached through the extension they installed in it. One capability per browser,
 * the id being its name; `apply` writes the family's skill pack and pushes the switches to the extension if it
 * is connected. The browser itself is paired out-of-band: the owner opens the extension and pastes the code the
 * card is offering, which enrolls over /system/webext/enroll and dials back in.
 *
 * The `host` handler's twin, and the differences are all downstream of what the far end is:
 *   · no `fragment` — there is nothing to install in the sandbox for this; the software is in their browser;
 *   · the pack is per FAMILY (chrome, firefox) rather than per OS, and is data in an installed extension's
 *     `contributes.capabilities`, so a new browser is one manifest entry and no daemon release;
 *   · removal cannot reach into the browser. It revokes the key and cuts the socket; the extension is still
 *     installed over there, and only the person at that keyboard can remove it — which is the correct shape,
 *     since it is their browser and their decision. */
export const webextHandler: CapabilityHandler = {
    // The credential is the extension's enrollment token, which lives on /history (webext-store.ts) and never
    // in the manifest: rotating it is re-pairing in the browser, not an edit in /secrets. So: no secret.
    echo: (config) => {
        // Every field is a permission and none is secret: the card renders the grant back to the owner.
        const browser = config as WebExtConfig;
        return {
            platform: browser.platform,
            read: browser.read,
            act: browser.act,
            screenshot: browser.screenshot,
            cookies: browser.cookies,
            confirm: browser.confirm,
        };
    },
    /* The enrollment travels with the name, so a renamed browser is not one somebody has to go and re-pair.
     * Its live socket is cut instead: the extension is authenticated by a token this daemon still honours, and
     * reconnecting is what makes it announce itself under the name it now has. */
    rename: {
        carry: async (ctx, from, to) => {
            await ctx.webexts.rename(from, to);
            ctx.webextHub.disconnect(from, "this browser was renamed: reconnecting under its new name");
            await removeLoadedSkill(ctx.files, ctx.workspace.root, from);
        },
    },
    async *apply(ctx, id, config) {
        const browser = config as WebExtConfig;
        const contribution = (await contributionRegistry(hostOf(ctx))).get(contributionKey("webext", browser.platform));
        if (contribution === undefined) {
            throw new Error(`no browser family "${browser.platform}": install the extension that declares it`);
        }
        const skill = await contributedSkill(contribution, id, WEBEXT_TOOLS_NOTE);
        if (skill === undefined) {
            throw new Error(`the extension declaring "${browser.platform}" has no readable skill pack: reinstall it`);
        }
        await writeLoadedSkill(ctx.files, ctx.workspace.root, id, skill);
        if (!(await ctx.webexts.enrolled(id))) {
            yield {
                kind: "log",
                message: `Added "${id}". Install the extension in that browser and paste the code its card is offering; the agent can work in it from the next turn.`,
            };
            return;
        }
        // An edit of the switches decides what may happen inside somebody's signed-in browser RIGHT NOW, so it
        // travels immediately rather than at the next reconnect. The extension is the enforcement point; this
        // is the only thing that moves the boundary it enforces.
        const pushed = await ctx.webextHub.pushScopes(id, browser);
        yield {
            kind: "log",
            message: pushed
                ? `Updated "${id}": the new permissions are in force in that browser now.`
                : `Saved. "${id}" is not connected; the new permissions apply the moment it reconnects.`,
        };
    },
    // Four states, because the reader's next action differs in each: nothing applied yet, applied but never
    // paired (paste the code), paired but the browser is shut (open it), working.
    status: async (ctx, id) => {
        if ((await ctx.files.read(loadedSkillFile(ctx.workspace.root, id))) === undefined) {
            return { state: "inactive" };
        }
        if (!(await ctx.webexts.enrolled(id))) {
            return { state: "pending", detail: "click Connect and paste the code into the extension" };
        }
        return ctx.webextHub.online(id) ? { state: "active" } : { state: "pending", detail: "that browser is closed" };
    },
    remove: async (ctx, id) => {
        ctx.webextHub.disconnect(id, "this browser was disconnected from the sandbox");
        await ctx.webexts.revoke(id);
        await removeLoadedSkill(ctx.files, ctx.workspace.root, id);
    },
};
