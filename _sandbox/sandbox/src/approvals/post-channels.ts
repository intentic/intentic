import type { CapabilityContribution } from "@intentic/extension-manifest";
import type { PostApprovalSummary } from "@intentic/sandbox-contract/schemas/approvals";
import { cachedEnabledExtensions } from "../capabilities/contributions.js";
import type { ExtensionHost, InstalledExtension } from "../capabilities/extension-inventory/installed-extensions.js";

// WHO PUBLISHES A POST, read off the enabled extensions' cards (2026-11-26): a post's `platform` names a card's id, and
// that card's `channel` facts say whether its extension's backend publishes approved posts there itself and to which
// targets, and what a publishing turn should know about the platform. Replaced a core table of the one platform the
// daemon posted to itself (Discord) and its channel-id pattern, and a Reddit rule written into every turn's brief.

export interface PostChannel {
    readonly extension: InstalledExtension;
    readonly card: CapabilityContribution;
}

// Every card id an enabled extension declares, to its first declarer in enumeration order (built-in, git-installed, then
// workspace), as the listener's provider is owned.
export const postChannels = async (host: ExtensionHost): Promise<ReadonlyMap<string, PostChannel>> => {
    const channels = new Map<string, PostChannel>();
    for (const extension of await cachedEnabledExtensions(host)) {
        for (const card of extension.manifest.contributes?.capabilities ?? []) {
            if (!channels.has(card.id)) {
                channels.set(card.id, { extension, card });
            }
        }
    }
    return channels;
};

export const channelOf = (channels: ReadonlyMap<string, PostChannel>, platform: string): PostChannel | undefined => channels.get(platform.toLowerCase());

// The extension whose backend publishes this post itself, or undefined when a turn has to: no card declares it publishes
// there, its extension has no backend, the target is not one its pattern addresses (a channel named rather than
// numbered), or the post attaches files, which a turn uploads from the workspace.
export const publisherOf = (channels: ReadonlyMap<string, PostChannel>, post: Pick<PostApprovalSummary, "platform" | "target" | "media">): PostChannel | undefined => {
    const channel = channelOf(channels, post.platform);
    const publish = channel?.card.channel?.publish;
    if (channel === undefined || publish === undefined || channel.extension.manifest.server === undefined) {
        return undefined;
    }
    if (post.target === undefined || (post.media ?? []).length > 0) {
        return undefined;
    }
    // Whole-target match: a declared `\d{5,}` must not let `#releases 12345` through.
    return new RegExp(`^(?:${publish.target})$`, "u").test(post.target) ? channel : undefined;
};

// What each platform in a turn's batch adds to its brief: the card's name and its `channel.posting`, for the platforms
// that declare one.
export const postingNotes = (channels: ReadonlyMap<string, PostChannel>, platforms: readonly string[]): { readonly platform: string; readonly note: string }[] =>
    [...new Set(platforms.map((platform) => platform.toLowerCase()))].flatMap((platform) => {
        const card = channels.get(platform)?.card;
        const posting = card?.channel?.posting;
        return posting === undefined || card === undefined ? [] : [{ platform: card.catalog.name, note: posting }];
    });
