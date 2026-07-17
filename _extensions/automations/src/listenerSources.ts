import type { IconName } from "@intentic/extension-ui";

// Live sources the daemon can hold a realtime connection to, the event kinds each emits, per-source wording
// for the shared filter fields, and a starter prompt. Grows alongside each gateway extension's
// contributes.listener declaration.
export type ListenerEventType = `message` | `voice_transcript` | `flags` | `expunge`;

export interface ListenerSource {
    readonly label: string;
    // A simple-icons brand slug, or an app Icon fallback when no brand glyph fits (email has no brand).
    readonly logo?: string;
    readonly icon?: IconName;
    readonly events: readonly { value: ListenerEventType; label: string }[];
    // The `mentioned` filter's meaning in this source's vocabulary (shown only for `message` events).
    readonly mentionLabel: string;
    readonly channel: { label: string; placeholder: string };
    readonly starterPrompt: string;
}

export const LISTENER_SOURCES: Record<`discord` | `imap`, ListenerSource> = {
    discord: {
        label: `Discord`,
        logo: `discord`,
        events: [
            { value: `message`, label: `Messages` },
            { value: `voice_transcript`, label: `Voice transcripts` },
        ],
        mentionLabel: `Only when the bot is mentioned (@mention or reply)`,
        channel: { label: `Channel ID (optional)`, placeholder: `all channels the bot can read` },
        starterPrompt: `Discord events just arrived — each line of the event payload is one JSON event: type \`message\` (a new message: author, channelId, content; \`mentioned: true\` when the bot was tagged or replied to) or \`voice_transcript\` (a finished voice session — read the transcript at its \`extra.path\`). Handle messages that need attention with your Discord capability; turn transcripts into notes and action items in the workspace.`,
    },
    imap: {
        label: `Email (IMAP)`,
        icon: `envelope`,
        events: [
            { value: `message`, label: `New mail` },
            { value: `flags`, label: `Flag changes` },
            { value: `expunge`, label: `Deletions` },
        ],
        mentionLabel: `Only mail addressed directly to you (your address in To)`,
        channel: { label: `Mailbox (optional)`, placeholder: `the watched mailbox, e.g. INBOX` },
        starterPrompt: `Email events just arrived — each line of the payload is one JSON event: type \`message\` (new mail: the author is the sender, content holds the subject and a text excerpt, extra carries uid/messageId/attachments), \`flags\` (a message's flags changed) or \`expunge\` (a message was deleted). Triage the new mail and summarize anything urgent; fetch a full message over IMAP (curl imaps://, by its extra.uid) when the excerpt isn't enough.`,
    },
};
