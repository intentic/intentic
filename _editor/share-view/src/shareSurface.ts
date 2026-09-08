import type { ChatSurface } from "@intentic/web/features/chat/tools/chatToolSurface";

// Only pictures are reachable from a published page; everything else (file contents, shell attachments,
// delegations) stays undefined so the card draws a generic record instead of a live link. Paths are already
// copied and relative to this page, so this is identity, not lookup; anything absolute-looking is refused.
export const shareSurface: ChatSurface = {
    imageUrl: (path) => (path.startsWith("/") || path.includes("://") || path.includes("..") ? undefined : path),
};
