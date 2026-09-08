import type { CapabilityStatus, IntenticLine } from "@intentic/sandbox-contract";
import type { CapabilityHandler } from "../capabilities/capability.js";
import { removeLoadedSkill, writeLoadedSkill } from "../settings/loaded-skills.js";
import type { TunnelEntry, TunnelKindName } from "./tunnel-links.js";

// Capability handler stores a tunnel kind's manifest data (credentials, pool, boot flag); the kind's own links layer
// does every dial, so the operator card, agent CLI, apply, and boot restore share one implementation. A kind declares
// its data and the three verbs its links layer already owns.

// On-disk half of a driver; both kinds' SPIs carry exactly these three.
export interface TunnelDriverFiles<Config> {
    readonly write: (id: string, config: Config) => Promise<void>;
    readonly erase: (id: string, config: Config) => Promise<void>;
    readonly missingTool: () => Promise<string | undefined>;
}

export interface TunnelKind<Config> {
    readonly kind: TunnelKindName;
    // Skill the agent drives this kind through: shared by every entry of the kind, dropped with the last.
    readonly skill: { readonly name: string; readonly text: string };
    readonly secret: NonNullable<CapabilityHandler["secret"]>;
    readonly echo: CapabilityHandler["echo"];
    readonly fragment: NonNullable<CapabilityHandler["fragment"]>;
    readonly driverOf: (config: Config) => TunnelDriverFiles<Config>;
    // Whether the manifest says this one should be up on its own (auto-connect, auto-start).
    readonly wanted: (config: Config) => boolean;
    readonly up: (entry: TunnelEntry<Config>) => AsyncGenerator<IntenticLine>;
    readonly down: (entry: TunnelEntry<Config>) => Promise<void>;
    readonly status: (entry: TunnelEntry<Config>) => Promise<CapabilityStatus>;
    // What an apply says when it stored the entry but dialled nothing: waiting on a click, or on a rebuild.
    readonly stored: (id: string) => string;
    readonly afterRebuild: string;
}

// Maps a live link onto the grid's four states. Mid-dial and pre-rebuild both read as `pending`, since neither is
// finished and the grid's pending affordance already says so.
export const tunnelStatus = (
    link: { readonly state: string; readonly detail?: string | undefined },
    live: { readonly active: string; readonly pending: string },
): CapabilityStatus => {
    if (link.state === live.active) {
        return { state: "active" };
    }
    if (link.state === live.pending) {
        return { state: "pending", detail: link.detail ?? live.pending };
    }
    if (link.state === "unavailable") {
        return { state: "pending", detail: "rebuild required" };
    }
    if (link.state === "failed") {
        return { state: "error", ...(link.detail === undefined ? {} : { detail: link.detail }) };
    }
    return { state: "inactive" };
};

export const tunnelHandler = <Config>(spec: TunnelKind<Config>): CapabilityHandler => ({
    secret: spec.secret,
    echo: spec.echo,
    fragment: spec.fragment,
    // Files are written per name by the driver; a rename only takes the old name down and erases it, since re-apply
    // writes fresh ones under the new name.
    rename: {
        carry: async (_ctx, from, _to, raw) => {
            const config = raw as Config;
            await spec.down({ id: from, config }).catch(() => undefined);
            await spec.driverOf(config).erase(from, config);
        },
    },
    async *apply(ctx, id, raw) {
        const config = raw as Config;
        const entry = { id, config };
        const driver = spec.driverOf(config);
        // Persist first: the manifest entry puts the fragment into the overlay before the client is installed.
        await driver.write(id, config);
        await writeLoadedSkill(ctx.files, ctx.workspace.root, spec.skill.name, spec.skill.text);
        // Re-applying must never leave the old instance running: take it down, then bring it back below if wanted.
        await spec.down(entry).catch(() => undefined);
        if (!spec.wanted(config)) {
            yield { kind: "log", message: spec.stored(id) };
            return;
        }
        const missing = await driver.missingTool();
        if (missing !== undefined) {
            // Missing client is a soft outcome, not a failed add: this very add's overlay is what installs it.
            yield { kind: "log", message: `Stored ${id}, this sandbox doesn't carry ${missing} yet. Rebuild it from the Environment card; ${spec.afterRebuild}.` };
            return;
        }
        yield* spec.up(entry);
    },
    status: async (_ctx, id, raw) => await spec.status({ id, config: raw as Config }),
    remove: async (ctx, id, raw) => {
        const config = raw as Config;
        await spec.down({ id, config }).catch(() => undefined);
        await spec.driverOf(config).erase(id, config);
        // Skill is shared by the kind, so it goes only with the last entry; the route removes the manifest entry after
        // this handler runs, so `id` still counts here.
        const left = (await ctx.capabilities.list()).filter((capability) => capability.kind === spec.kind).length;
        if (left <= 1) {
            await removeLoadedSkill(ctx.files, ctx.workspace.root, spec.skill.name);
        }
    },
});
