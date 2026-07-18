import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DraftSchema, type DraftSummary } from "@intentic/sandbox-contract";
import type { Services } from "../composition.js";

// The post-drafts queue (<workspace>/.intentic/drafts/<id>.json, one file per draft): the AGENT creates drafts
// (taught by DRAFTS_SKILL below), the daemon edits/deletes them for the owner. Per-file — never a shared
// manifest like automations.json — because the two writers would race a read-modify-write. The id IS the
// filename; no secrets live here.

// Same charset as the contract's entryId — a filename that doesn't match is reported invalid, never trusted.
const FILE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,59}$/;

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
export const fileDraftsStore = (dir: string): DraftsStore => ({
    list: async () => {
        let names: string[];
        try {
            names = await readdir(dir);
        } catch {
            return { drafts: [], invalid: [] };
        }
        const drafts: DraftSummary[] = [];
        const invalid: string[] = [];
        for (const file of names.filter((name) => name.endsWith(".json"))) {
            const id = file.slice(0, -".json".length);
            if (!FILE_ID.test(id)) {
                invalid.push(file);
                continue;
            }
            try {
                const parsed = DraftSchema.safeParse(JSON.parse(await readFile(join(dir, file), "utf8")));
                if (parsed.success) {
                    drafts.push({ ...parsed.data, id });
                } else {
                    invalid.push(file);
                }
            } catch {
                invalid.push(file);
            }
        }
        // scheduledAt is optional; undated drafts sort last (a plain subtraction would be NaN).
        return {
            drafts: drafts.toSorted((a, b) => (a.scheduledAt ?? Number.POSITIVE_INFINITY) - (b.scheduledAt ?? Number.POSITIVE_INFINITY)),
            invalid,
        };
    },
    upsert: async ({ id, ...draft }) => {
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, `${id}.json`), `${JSON.stringify(draft, undefined, 2)}\n`);
    },
    remove: async (id) => {
        try {
            await unlink(join(dir, `${id}.json`));
            return true;
        } catch {
            return false;
        }
    },
});

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
