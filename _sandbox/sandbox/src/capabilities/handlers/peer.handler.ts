import type { PeerHub } from "../../peers/peer-hub.js";
import type { PeerStore } from "../../peers/peer-store.js";
import { loadedSkillFile, removeLoadedSkill, writeLoadedSkill } from "../../settings/loaded-skills.js";
import type { CapabilityCtx, CapabilityHandler } from "../capability.js";
import { contributedSkill, contributionKey, contributionRegistry, hostOf } from "../contributions.js";

/* THE CAPABILITY HANDLER of a peer door: one capability per peer, the id being its name. `apply` writes the
 * contributed skill pack and pushes the grant to the peer if it is up; the peer itself is connected out-of-band,
 * by running the card's one-liner on it or pasting its code into an extension, which enrolls over the door's
 * enroll route and dials back in.
 *
 * The pack is per PLATFORM (an OS, a browser family), data in an installed extension's
 * `contributes.capabilities`; the tool surface it wraps, the enrollment and the scope enforcement are core. A
 * peer's credential is its enrollment token, which lives on /history and never in the manifest: rotating it is
 * re-pairing at the far end, not an edit in /secrets. So: no secret. */

export interface PeerHandlerSpec<Scopes extends { readonly platform: string }> {
    readonly kind: "host" | "webext";
    readonly noun: string;
    // Where the permissions are in force once pushed: "on that device", "in that browser".
    readonly where: string;
    // The `${tools}` note the contributed pack is rendered with: the tool surface and the rules for working there.
    readonly note: string;
    // What the owner is told to do at the far end while the peer has never connected.
    readonly pairHint: string;
    // What the card says of an enrolled peer that is not holding a socket right now.
    readonly awayHint: string;
    readonly added: (id: string) => string;
    readonly store: (ctx: CapabilityCtx) => Pick<PeerStore<unknown>, "enrolled" | "rename" | "revoke">;
    readonly hub: (ctx: CapabilityCtx) => Pick<PeerHub<never, unknown, unknown, Scopes>, "disconnect" | "online" | "pushScopes">;
    // Every field is a permission and none is secret: the card renders the grant back to the owner.
    readonly echo: (config: Scopes) => Record<string, string | number | boolean>;
}

export const peerHandler = <Scopes extends { readonly platform: string }>(spec: PeerHandlerSpec<Scopes>): CapabilityHandler => ({
    echo: (config) => spec.echo(config as Scopes),
    /* The enrollment travels with the name, so a renamed peer is not one somebody has to walk over to and
     * re-pair. Its live socket is cut instead: the far end is authenticated by a token this daemon still
     * honours, and reconnecting is what makes it announce itself under the name it now has. */
    rename: {
        carry: async (ctx, from, to) => {
            await spec.store(ctx).rename(from, to);
            spec.hub(ctx).disconnect(from, `this ${spec.noun} was renamed: reconnecting under its new name`);
            await removeLoadedSkill(ctx.files, ctx.workspace.root, from);
        },
    },
    async *apply(ctx, id, config) {
        const scopes = config as Scopes;
        const contribution = (await contributionRegistry(hostOf(ctx))).get(contributionKey(spec.kind, scopes.platform));
        if (contribution === undefined) {
            throw new Error(`no ${spec.kind} platform "${scopes.platform}": install the extension that declares it`);
        }
        const skill = await contributedSkill(contribution, id, spec.note);
        if (skill === undefined) {
            throw new Error(`the extension declaring "${scopes.platform}" has no readable skill pack: reinstall it`);
        }
        await writeLoadedSkill(ctx.files, ctx.workspace.root, id, skill);
        if (!(await spec.store(ctx).enrolled(id))) {
            yield { kind: "log", message: spec.added(id) };
            return;
        }
        // An edit of the switches is a decision about what may happen at the far end RIGHT NOW, so it travels
        // immediately rather than at the next reconnect. The peer is the enforcement point; this is the only
        // thing that moves the boundary it enforces.
        const pushed = await spec.hub(ctx).pushScopes(id, scopes);
        yield {
            kind: "log",
            message: pushed
                ? `Updated "${id}": the new permissions are in force ${spec.where} now.`
                : `Saved. "${id}" is not connected; the new permissions apply the moment it reconnects.`,
        };
    },
    // Four states, because the owner's next action differs in each: nothing applied yet, applied but never
    // connected (pair it), enrolled but away (open the lid, open the browser), working.
    status: async (ctx, id) => {
        if ((await ctx.files.read(loadedSkillFile(ctx.workspace.root, id))) === undefined) {
            return { state: "inactive" };
        }
        if (!(await spec.store(ctx).enrolled(id))) {
            return { state: "pending", detail: spec.pairHint };
        }
        return spec.hub(ctx).online(id) ? { state: "active" } : { state: "pending", detail: spec.awayHint };
    },
    // Removing the capability revokes the peer's key and cuts its socket. What stays is the software installed
    // over there, which only somebody at that keyboard can remove, and with its enrollment gone it can no
    // longer reach this sandbox at all.
    remove: async (ctx, id) => {
        spec.hub(ctx).disconnect(id, `this ${spec.noun} was disconnected from the sandbox`);
        await spec.store(ctx).revoke(id);
        await removeLoadedSkill(ctx.files, ctx.workspace.root, id);
    },
});
