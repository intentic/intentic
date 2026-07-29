import type { IconName } from "@intentic/extension-ui";

// Live sources whose events can wake an automation instantly, the event kinds each emits, per-source wording
// for the shared filter fields, and a starter prompt. Grows alongside each gateway extension's
// contributes.listener declaration — plus the daemon's own core sources (`ci`, fed by its pipeline webhook
// receiver rather than a gateway process).
export type ListenerEventType = `message` | `voice_transcript` | `flags` | `expunge` | `pipeline_failed` | `pipeline_succeeded` | `pipeline_fixed`;

export interface ListenerSource {
    readonly label: string;
    // A simple-icons brand slug, or an app Icon fallback when no brand glyph fits (email has no brand).
    readonly logo?: string;
    readonly icon?: IconName;
    // The capability providers (any of) that make this source available; absent ⇒ the source key itself is the
    // capability provider. `ci` listens on whichever git host is connected, so it names both.
    readonly providers?: readonly string[];
    readonly events: readonly { value: ListenerEventType; label: string }[];
    // The `mentioned` filter's meaning in this source's vocabulary (shown only for `message` events).
    readonly mentionLabel: string;
    readonly channel: { label: string; placeholder: string };
    readonly starterPrompt: string;
}

export const LISTENER_SOURCES: Record<`discord` | `imap` | `ci`, ListenerSource> = {
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
    ci: {
        label: `CI/CD`,
        icon: `bolt`,
        providers: [`github`, `gitlab`],
        events: [
            { value: `pipeline_failed`, label: `Pipeline failed` },
            { value: `pipeline_succeeded`, label: `Pipeline passed` },
            { value: `pipeline_fixed`, label: `Pipeline fixed` },
        ],
        // CI has no message events, so this never renders — worded anyway so a future event kind fails obvious.
        mentionLabel: `Only pipelines this sandbox pushed`,
        channel: { label: `Repository (optional)`, placeholder: `all workspace repos` },
        starterPrompt: `CI pipeline results just arrived — each line of the event payload is one JSON event: type \`pipeline_failed\`, \`pipeline_succeeded\` or \`pipeline_fixed\`, with extra carrying repo (the workspace repo dir), branch, sha, url and failedJobs. For a failure: fetch the failing jobs' logs with your GitHub/GitLab capability (the url points at the run), reproduce the failure locally in that repo, fix the cause, and push the fix. For a pass or a fix, no action is usually needed — summarize briefly.`,
    },
};
