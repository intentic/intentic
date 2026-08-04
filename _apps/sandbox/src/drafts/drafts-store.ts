import { join } from "node:path";
import { DraftSchema, type DraftSummary } from "@intentic/sandbox-contract";
import type { Services } from "../composition.js";
import { jsonDir } from "../store/json-dir.js";

// The post-drafts queue (<workspace>/.intentic/drafts/<id>.json, one file per draft): the AGENT creates drafts
// (taught by DRAFTS_SKILL below), the daemon edits/deletes them for the owner. Per-file — never a shared
// manifest like automations.json — because the two writers would race a read-modify-write (see json-dir.ts,
// which owns that cycle and the trust boundary around agent-written names). No secrets live here.

export interface DraftsStore {
    // Parsed drafts (scheduledAt ascending) plus the filenames that failed to parse — an agent typo must be
    // visible in the UI, not a draft that silently never posts.
    readonly list: () => Promise<{ drafts: DraftSummary[]; invalid: string[] }>;
    // Upsert by id — approve/edit/retry are all a rewrite of the whole file.
    readonly upsert: (draft: DraftSummary) => Promise<void>;
    // True when a draft of that id existed and was removed.
    readonly remove: (id: string) => Promise<boolean>;
}

// A per-file JSON store, used in production at <workspace>/.intentic/drafts/.
export const fileDraftsStore = (dir: string): DraftsStore => {
    const files = jsonDir(dir, (raw) => DraftSchema.safeParse(raw).data);
    return {
        list: async () => {
            const { entries, invalid } = await files.list();
            // scheduledAt is optional; undated drafts sort last (a plain subtraction would be NaN).
            return {
                drafts: entries.toSorted((a, b) => (a.scheduledAt ?? Number.POSITIVE_INFINITY) - (b.scheduledAt ?? Number.POSITIVE_INFINITY)),
                invalid,
            };
        },
        upsert: ({ id, ...draft }) => files.write(id, draft),
        remove: files.remove,
    };
};

// How the drafting agent learns the file format — the same auto-loaded .claude/skills mechanism every
// capability connector uses. Triggered by description, so a user prompt like "prepare social media post
// drafts" routes here without any automation change.
const DRAFTS_SKILL = `---
name: drafts
description: Create post drafts for owner approval by writing JSON files into .intentic/drafts/. Use whenever asked to prepare, draft, propose, or schedule posts (X, Reddit, YouTube, Discord, …) instead of posting immediately.
---

# Post drafts (approval queue)

Proposed or scheduled posts are NEVER posted directly — write a draft file instead; the owner approves it in
the app and the publish automation posts it when due. One JSON file per draft: .intentic/drafts/<id>.json
(id: letters, digits, dashes — it names the draft in the UI). Example:

{
  "platform": "x",
  "content": "exact post text",
  "title": "…",
  "target": "r/webdev",
  "media": [".intentic/drafts/media/chart.png"],
  "scheduledAt": 1767950400000,
  "status": "proposed",
  "createdAt": 1767800000000
}

Only "platform" and "content" are required; everything else is optional.
- platform: the skill that will post it — "x", "reddit", "youtube", "discord", …
- title (reddit needs one) and target (subreddit / Discord channel id / community).
- media: workspace-relative files; put them under .intentic/drafts/media/.
- scheduledAt: your SUGGESTED post time in epoch ms — \`date -d "2026-07-10 09:00 +02:00" +%s%3N\` (always give an
  explicit UTC offset; the sandbox clock is UTC). Omit it to let the owner pick the date at approval.
- status: defaults to "proposed" if omitted; only the owner sets "approved". Only post a draft when the publish
  automation woke you for approved, due drafts.
`;

// Drafts are native to every sandbox (like automations), so no capability owns this skill — the daemon
// converges it at boot (the composeEnvironment pattern), keeping the prose current across daemon updates.
export const ensureDraftsSkill = (services: Services): Promise<void> =>
    services.files.write(join(services.workspace.root, ".claude", "skills", "drafts", "SKILL.md"), DRAFTS_SKILL);
