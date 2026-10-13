import type { PeerKind } from "../../peers/peer.js";
import type { PeerHub } from "../../peers/peer-hub.js";
import type { PeerStore } from "../../peers/peer-store.js";
import { loadedSkillFile, removeLoadedSkill, stampSkill, writeLoadedSkill } from "../../store/loaded-skills.js";
import type { CapabilityCtx, CapabilityHandler } from "../capability.js";
import { contributedSkill, contributionKey, contributionRegistry, hostOf } from "../contributions.js";

// One capability per peer (id is its name): apply writes the contributed skill and pushes the grant if the peer is up.
// The peer connects out-of-band (its one-liner, or code pasted into an extension). Its credential is an enrollment
// token on /history, never the manifest: rotating means re-pairing, not a /secrets edit.

export interface PeerHandlerSpec<Scopes extends { readonly platform: string }> {
    readonly kind: PeerKind;
    readonly noun: string;
    // Where the permissions take effect once pushed: "on that device", "in that browser".
    readonly where: string;
    // The `${tools}` note the pack renders with: the tool surface and the rules for working there.
    readonly note: string;
    // The note for one peer, when it depends on what that peer said of itself (a device's facts), read whenever its
    // skill is written; `note` otherwise.
    readonly noteFor?: (ctx: CapabilityCtx, id: string) => string;
    // What the owner is told to do at the far end while the peer has never connected.
    readonly pairHint: string;
    // What the entry says of an enrolled peer not holding a socket right now.
    readonly awayHint: string;
    readonly added: (id: string) => string;
    readonly store: (ctx: CapabilityCtx) => Pick<PeerStore<unknown>, "enrolled" | "relabelCard" | "revokeCard">;
    readonly hub: (ctx: CapabilityCtx) => Pick<PeerHub<never, unknown, unknown, Scopes>, "disconnect" | "online" | "pushScopes" | "rekey">;
    // Every field is a permission, none secret: the entry renders the grant back to the owner.
    readonly echo: (config: Scopes) => Record<string, string | number | boolean>;
    // What else the door keeps per peer outside its enrollment (a phone's wake channel), moved with a rename and
    // dropped with a removal.
    // Whether an enrolled peer holding no socket is still within reach: a phone the sandbox can wake is, and its card
    // reads active rather than away, since the agent's first call brings it.
    readonly wakeable?: (ctx: CapabilityCtx, id: string) => Promise<boolean>;
    readonly kept?: {
        readonly rekey: (ctx: CapabilityCtx, from: string, to: string) => Promise<void>;
        readonly forget: (ctx: CapabilityCtx, id: string) => Promise<void>;
    };
    // What else a removed card's computers hold here under another door (a device's desktop-sync key): read BEFORE the
    // card's enrollments go, since they are what says which computers those were, and revoked once they have gone.
    readonly alsoRevoke?: (ctx: CapabilityCtx, card: string) => Promise<() => Promise<void>>;
}

// The peer's skill as its platform's pack renders it with the note; undefined when no installed extension declares the
// platform or its pack cannot be read, which apply refuses and a refresh leaves alone.
const renderPeerSkill = async <Scopes extends { readonly platform: string }>(
    spec: PeerHandlerSpec<Scopes>,
    ctx: CapabilityCtx,
    id: string,
    scopes: Scopes,
): Promise<{ readonly skill: string | undefined; readonly declared: boolean }> => {
    const contribution = (await contributionRegistry(hostOf(ctx))).get(contributionKey(spec.kind, scopes.platform));
    if (contribution === undefined) {
        return { skill: undefined, declared: false };
    }
    return { skill: await contributedSkill(contribution, id, spec.noteFor?.(ctx, id) ?? spec.note), declared: true };
};

/**
 * Writes the peer's skill again when what its note says has changed since it was written (a device that said at connect
 * that it boots Intentic OS). A peer whose skill was never written (never applied), or whose pack is gone, is left
 * alone; answers whether it wrote.
 */
export const refreshPeerSkill = async <Scopes extends { readonly platform: string }>(
    spec: PeerHandlerSpec<Scopes>,
    ctx: CapabilityCtx,
    id: string,
    scopes: Scopes,
): Promise<boolean> => {
    const written = await ctx.files.read(loadedSkillFile(ctx.workspace.root, id));
    if (written === undefined) {
        return false;
    }
    const { skill } = await renderPeerSkill(spec, ctx, id, scopes);
    if (skill === undefined || stampSkill(skill, "peer") === written) {
        return false;
    }
    await writeLoadedSkill(ctx.files, ctx.workspace.root, id, skill, "peer");
    return true;
};

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
                await spec.kept?.rekey(ctx, moved.from, moved.to);
            }
            await removeLoadedSkill(ctx.files, ctx.workspace.root, from);
        },
    },
    async *apply(ctx, id, config) {
        const scopes = config as Scopes;
        const { skill, declared } = await renderPeerSkill(spec, ctx, id, scopes);
        if (!declared) {
            throw new Error(`no ${spec.kind} platform "${scopes.platform}": install the extension that declares it`);
        }
        if (skill === undefined) {
            throw new Error(`the extension declaring "${scopes.platform}" has no readable skill pack: reinstall it`);
        }
        await writeLoadedSkill(ctx.files, ctx.workspace.root, id, skill, "peer");
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
        if (spec.hub(ctx).online(id)) {
            return { state: "active" };
        }
        return (await spec.wakeable?.(ctx, id)) === true ? { state: "active", detail: spec.awayHint } : { state: "pending", detail: spec.awayHint };
    },
    // Revokes the peer's key and cuts its socket; the software installed over there stays; only someone at that
    // keyboard can remove it, and it can no longer reach this sandbox once revoked.
    // Every enrollment of the card goes in one write, before any socket is cut: a failure leaves the card whole rather
    // than some of its keys live with no card listing them.
    remove: async (ctx, id) => {
        const companions = await spec.alsoRevoke?.(ctx, id);
        for (const held of await spec.store(ctx).revokeCard(id)) {
            spec.hub(ctx).disconnect(held, `this ${spec.noun} was disconnected from the sandbox`);
            await spec.kept?.forget(ctx, held);
        }
        await companions?.();
        await removeLoadedSkill(ctx.files, ctx.workspace.root, id);
    },
});
