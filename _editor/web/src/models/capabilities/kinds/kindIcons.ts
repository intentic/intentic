import { type CapabilityKind, CapabilityKindSchema } from "@intentic/sandbox-contract/schemas/capabilities";
import type { IconName } from "@intentic/ui";

// The glyph a kind wears wherever nothing more particular is drawn: a tile with no logo or icon of its own, a map node
// whose tile is not loaded, a peer's Connect button. Total over the kinds, so a new kind picks one here; most are the
// bolt. The owner's own browser (`webext`) is the globe, as the Capabilities page drew it (the map had it `browsers`).
export const KIND_ICONS = {
    mcp: `bolt`,
    cli: `bolt`,
    plugin: `th-large`,
    extension: `bolt`,
    ssh: `bolt`,
    vpn: `bolt`,
    exit: `bolt`,
    netdisk: `bolt`,
    docker: `bolt`,
    browser: `globe`,
    identity: `user`,
    device: `desktop`,
    webext: `globe`,
    phone: `mobile`,
    agent: `sparkles`,
    endpoint: `bolt`,
    localmodel: `bolt`,
    wallet: `bolt`,
    fleet: `bolt`,
    link: `link`,
} as const satisfies Record<CapabilityKind, IconName>;

// A kind's glyph, the bolt for a kind this build does not know (a newer daemon's).
export const kindIcon = (kind: string): IconName => {
    const known = CapabilityKindSchema.options.find((candidate) => candidate === kind);
    return known === undefined ? `bolt` : KIND_ICONS[known];
};
