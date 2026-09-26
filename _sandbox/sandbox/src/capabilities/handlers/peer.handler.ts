import type { PeerHub } from "../../peers/peer-hub.js";
import type { PeerStore } from "../../peers/peer-store.js";
import { loadedSkillFile, removeLoadedSkill, writeLoadedSkill } from "../../store/loaded-skills.js";
import type { CapabilityCtx, CapabilityHandler } from "../capability.js";
import { contributedSkill, contributionKey, contributionRegistry, hostOf } from "../contributions.js";

// One capability per peer (id is its name): apply writes the contributed skill and pushes the grant if the peer is up.
// The peer connects out-of-band (its one-liner, or code pasted into an extension). Its credential is an enrollment
// token on /history, never the manifest: rotating means re-pairing, not a /secrets edit.

export interface PeerHandlerSpec<Scopes extends { readonly platform: string }> {
    readonly kind: "device" | "webext";
    readonly noun: string;
    // Where the permissions take effect once pushed: "on that device", "in that browser".
    readonly where: string;
    // The `${tools}` note the pack renders with: the tool surface and the rules for working there.
    readonly note: string;
    // What the owner is told to do at the far end while the peer has never connected.
    readonly pairHint: string;
    // What the entry says of an enrolled peer not holding a socket right now.
    readonly awayHint: string;
    readonly added: (id: string) => string;
    readonly store: (ctx: CapabilityCtx) => Pick<PeerStore<unknown>, "enrolled" | "relabelCard" | "revokeCard">;
    readonly hub: (ctx: CapabilityCtx) => Pick<PeerHub<never, unknown, unknown, Scopes>, "disconnect" | "online" | "pushScopes" | "rekey">;
    // Every field is a permission, none secret: the entry renders the grant back to the owner.
    readonly echo: (config: Scopes) => Record<string, string | number | boolean>;
}

export const peerHandler = <Scopes extends { readonly platform: string }>(spec: PeerHandlerSpec<Scopes>): CapabilityHandler => ({
    echo: (config) => spec.echo(config as Scopes),
    // THE NAME IS A LABEL. Enrollment travels with it, no re-pairing needed: every enrollment the card holds (each OS
    // install of a machine) is relabelled in one write, each keeping its own token, and each live connection is held
    // under its new id with its socket untouched. The grant is the card's config, which a rename does not change, so
    // there is nothing to push either.
    rename: {
        carry: async (ctx, from, to) => {
            for (const moved of await spec.store(ctx).relabelCard(from, to)) {
                spec.hub(ctx).rekey(moved.from, moved.to);
            }
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
        // Travels immediately, not at next reconnect: the peer enforces the boundary, and this is what moves it.
        const pushed = await spec.hub(ctx).pushScopes(id, scopes);
        yield {
            kind: "log",
            message: pushed
                ? `Updated "${id}": the new permissions are in force ${spec.where} now.`
                : `Saved. "${id}" is not connected; the new permissions apply the moment it reconnects.`,
        };
    },
    // Four states, since the owner's next action differs: never applied, applied but never connected (pair it),
    // enrolled but away, or working.
    status: async (ctx, id) => {
        if ((await ctx.files.read(loadedSkillFile(ctx.workspace.root, id))) === undefined) {
            return { state: "inactive" };
        }
        if (!(await spec.store(ctx).enrolled(id))) {
            return { state: "pending", detail: spec.pairHint };
        }
        return spec.hub(ctx).online(id) ? { state: "active" } : { state: "pending", detail: spec.awayHint };
    },
    // Revokes the peer's key and cuts its socket; the software installed over there stays; only someone at that
    // keyboard can remove it, and it can no longer reach this sandbox once revoked.
    // Every enrollment of the card goes in one write, before any socket is cut: a failure leaves the card whole rather
    // than some of its keys live with no card listing them.
    remove: async (ctx, id) => {
        for (const held of await spec.store(ctx).revokeCard(id)) {
            spec.hub(ctx).disconnect(held, `this ${spec.noun} was disconnected from the sandbox`);
        }
        await removeLoadedSkill(ctx.files, ctx.workspace.root, id);
    },
});
