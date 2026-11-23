import type { SkillBody, SkillDraft, SkillSummary, SkillSwitch } from "@intentic/sandbox-contract/schemas/settings";
import { STATE_DIR } from "@intentic/constants";
import { refuse } from "@intentic/contract-serve";
import { deskEdition, freshEdition } from "../../mode";

// What the agent knows how to do, one of each kind the Skills catalog draws differently: the owner's own (one switched
// off, one whose trigger line is a label rather than an occasion), a role's kit, a file dropped into the workspace with a
// folder of references, then what connections, an extension, a plugin and the image brought, each shelved under its
// tile's catalog section. The list is the store, so writing or deleting one of the owner's own is in the next read, as
// against a daemon.

type DemoSkill = SkillSummary & { body: string; folder?: string; files?: readonly string[] };

const HOUR = 3_600_000;
const ago = (hours: number): string => new Date(Date.now() - hours * HOUR).toISOString();

const own = (name: string, description: string, body: string, enabled = true, uses: SkillSummary[`uses`] = { week: 0 }): DemoSkill => ({
    id: name,
    name,
    description,
    origin: `own`,
    enabled,
    switchable: true,
    editable: true,
    removable: true,
    uses,
    body,
});

// What arrived with something else: on because its owner is, so nothing here switches it.
const brought = (origin: `capability` | `extension` | `plugin`, owner: string, name: string, description: string, week: number): DemoSkill => ({
    id: origin === `capability` ? name : `${origin}:${owner}:${name}`,
    name,
    description,
    origin,
    owner,
    enabled: true,
    switchable: false,
    editable: false,
    removable: false,
    uses: week > 0 ? { week, last: ago(week) } : { week: 0 },
    body: `# ${name}\n\n${description}\n\n## Commands\n\nEach command is run from the sandbox's shell with the credential the connection holds.`,
    ...(origin === `capability` ? { folder: `.agents/skills/${name}`, files: [] } : { files: [`reference.md`] }),
});

const codeSkills: DemoSkill[] = [
    own(
        `release-notes`,
        `Use when the user asks to draft release notes or a changelog entry for a version.`,
        `# Release notes\n\n1. Read the merged pull requests since the last tag: \`gh pr list --state merged --base main\`.\n2. Group them under **Added**, **Changed** and **Fixed**.\n3. One line each, written for the customer, not the reviewer.\n\nNever mention internal ticket numbers.`,
        true,
        { week: 9, last: ago(2) },
    ),
    own(
        `refund-policy`,
        `Use when a customer asks for a refund, a return label or a partial credit.`,
        `# Refunds\n\nFull refund inside 30 days, store credit after. Over 200 USD goes to Priya first.`,
        false,
        { week: 0, last: ago(24 * 12) },
    ),
    own(
        `storefront-copy-review`,
        `The storefront copy review brief`,
        `# Storefront copy review\n\nRead every product page changed this week and flag claims we can't back up.`,
        true,
        { week: 1, last: ago(30) },
    ),
    {
        id: `role:support:triage`,
        name: `triage`,
        description: `Use when a new support ticket arrives: label it, set its priority and draft the first reply.`,
        origin: `role`,
        owner: `Support`,
        enabled: true,
        switchable: false,
        editable: false,
        removable: false,
        uses: { week: 4, last: ago(5) },
        body: `# Triage\n\nLabel, prioritise, draft. Never promise a date.`,
        folder: `${STATE_DIR}/config/roles/support/skills/triage`,
        files: [],
    },
    {
        id: `unsloppify`,
        name: `unsloppify`,
        description: `Remove AI writing tells from text. Use when a text artifact is the deliverable or a major part of one, such as documentation, PR or commit text, release notes, reports, marketing copy, code comments, or when asked to de-slop, humanize, or clean up text.`,
        origin: `dropped`,
        enabled: true,
        switchable: false,
        editable: false,
        removable: true,
        uses: { week: 6, last: ago(20) },
        body: `# unsloppify\n\nSlop is text that performs instead of informs. The fix is never decoration. State the plain version.\n\n## When to load\n\nLoad this skill when a text artifact is the deliverable or a major part of one: a document, PR or commit text, release notes, a report, marketing copy.\n\n## Procedure\n\n1. Read the draft once for what it says.\n2. Strike every sentence that only performs.\n3. Say the rest plainly.`,
        folder: `.agents/skills/unsloppify`,
        files: [`references/patterns.md`, `references/phrases.txt`, `scripts/scan.sh`, `LICENSE`],
    },
    brought(`capability`, `github`, `github`, `Read and manage GitHub repos, issues, pull requests, and code search via the GitHub REST API.`, 12),
    brought(`capability`, `postgres`, `postgres`, `Query the shop's Postgres read replica: schema, slow queries and row counts.`, 3),
    brought(`capability`, `sentry`, `sentry`, `Read Sentry issues, events and releases for the storefront and the API.`, 2),
    brought(`capability`, `discord`, `discord`, `Read, post, and react in the connected Discord server via the Discord REST API.`, 0),
    brought(`capability`, `stripe`, `stripe`, `Look up Stripe customers, charges and refunds, and issue a refund under the policy.`, 1),
    brought(`capability`, `ada-pc`, `ada-pc`, `Operate "ada-pc", one of the user's own computers: run commands, read and write files, capture its screen.`, 0),
    brought(`capability`, `ops-box`, `ops-box`, `Run commands and copy files on the ops box over SSH.`, 0),
    brought(`capability`, `x-brand`, `x`, `Read, reply, post, like, repost and follow on X as the brand account, through a real browser.`, 0),
    brought(`capability`, `reddit`, `reddit`, `Read, comment, reply, vote and post on Reddit as the logged-in user, through a real browser.`, 0),
    brought(`extension`, `Storefront`, `product-copy`, `Use when writing or rewriting a product page's title, bullets or description.`, 2),
    brought(`plugin`, `webq`, `webq`, `Web pages as token-budgeted markdown via the webq CLI.`, 0),
    {
        id: `fileq`,
        name: `fileq`,
        description: `Read binary files (docx, xlsx, pdf, images) as budgeted markdown.`,
        origin: `builtin`,
        enabled: true,
        switchable: true,
        editable: false,
        removable: false,
        uses: { week: 3, last: ago(8) },
        body: `# fileq\n\nRun \`fileq <path>\` to read a document as markdown.`,
    },
    {
        id: `lsp`,
        name: `lsp`,
        description: `Rename a TypeScript/JavaScript symbol across the project and read compiler diagnostics with the lsp CLI.`,
        origin: `builtin`,
        enabled: false,
        switchable: true,
        editable: false,
        removable: false,
        uses: { week: 0 },
        body: `# lsp\n\nRun \`lsp rename <file> <symbol> <new>\`.`,
    },
];

// A fresh sandbox has written nothing yet, and the desk carries no code workspace's skills.
const store: DemoSkill[] = deskEdition || freshEdition ? [] : codeSkills;

const summary = ({ body: _body, folder: _folder, files: _files, ...skill }: DemoSkill): SkillSummary => skill;

const read = ({ id }: { id: string }): SkillBody => {
    const skill = store.find((entry) => entry.id === id);
    if (skill === undefined) {
        return refuse(`No skill called ${id} here.`);
    }
    const answer: SkillBody = { id: skill.id, name: skill.name, body: skill.body, files: [...(skill.files ?? [])] };
    if (skill.folder !== undefined) {
        answer.folder = skill.folder;
    }
    return answer;
};

const OK = { ok: true } as const;

const ownIndex = (name: string): number => store.findIndex((entry) => entry.origin === `own` && entry.name === name);

// Upsert by name as the daemon does: a new one starts on, a rewrite keeps its switch.
const save = (draft: SkillDraft) => {
    const index = ownIndex(draft.name);
    const kept = store[index];
    if (kept === undefined) {
        store.push(own(draft.name, draft.description, draft.body));
    } else {
        store[index] = { ...kept, description: draft.description, body: draft.body };
    }
    return OK;
};

const remove = ({ name }: { name: string }) => {
    const index = ownIndex(name);
    if (index !== -1) {
        store.splice(index, 1);
    }
    return OK;
};

const switchOwn = ({ name, on }: SkillSwitch) => {
    const skill = store[ownIndex(name)];
    if (skill !== undefined) {
        skill.enabled = on;
    }
    return OK;
};

/** The `skills` group of the fixture daemon, each door shaped like the contract's. */
export const skillDoors = { list: (): SkillSummary[] => store.map(summary), read, save, switch: switchOwn, remove };
