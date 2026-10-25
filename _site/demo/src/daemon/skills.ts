import type { SkillBody, SkillDraft, SkillSummary, SkillSwitch } from "@intentic/sandbox-contract/schemas/settings";
import { refuse } from "@intentic/contract-serve";
import { deskEdition, freshEdition } from "../mode";

// What the agent knows how to do, one of each kind the Skills group draws differently: two of the owner's own (one
// switched off), a baked tool, and one an extension brought. The list is the store, so writing or deleting one of the
// owner's own is in the next read, as against a daemon.

type DemoSkill = SkillSummary & { body: string };

const own = (name: string, description: string, body: string, enabled = true): DemoSkill => ({
    id: name,
    name,
    description,
    origin: `own`,
    enabled,
    switchable: true,
    editable: true,
    removable: true,
    body,
});

const codeSkills: DemoSkill[] = [
    own(
        `release-notes`,
        `Use when the user asks to draft release notes or a changelog entry for a version.`,
        `# Release notes\n\n1. Read the merged pull requests since the last tag: \`gh pr list --state merged --base main\`.\n2. Group them under **Added**, **Changed** and **Fixed**.\n3. One line each, written for the customer, not the reviewer.\n\nNever mention internal ticket numbers.`,
    ),
    own(
        `refund-policy`,
        `Use when a customer asks for a refund, a return label or a partial credit.`,
        `# Refunds\n\nFull refund inside 30 days, store credit after. Over 200 USD goes to Priya first.`,
        false,
    ),
    {
        id: `fileq`,
        name: `fileq`,
        description: `Read binary files (docx, xlsx, pdf, images) as budgeted markdown.`,
        origin: `builtin`,
        enabled: true,
        switchable: true,
        editable: false,
        removable: false,
        body: `# fileq\n\nRun \`fileq <path>\` to read a document as markdown.`,
    },
    {
        id: `extension:storefront:product-copy`,
        name: `product-copy`,
        description: `Use when writing or rewriting a product page's title, bullets or description.`,
        origin: `extension`,
        owner: `Storefront`,
        enabled: true,
        switchable: false,
        editable: false,
        removable: false,
        body: `# Product copy\n\nLead with what it does for the buyer, then what it is made of.`,
    },
];

// A fresh sandbox has written nothing yet, and the desk carries no code workspace's skills.
const store: DemoSkill[] = deskEdition || freshEdition ? [] : codeSkills;

const summary = ({ body: _body, ...skill }: DemoSkill): SkillSummary => skill;

const read = ({ id }: { id: string }): SkillBody => {
    const skill = store.find((entry) => entry.id === id);
    if (skill === undefined) {
        return refuse(`No skill called ${id} here.`);
    }
    return { id: skill.id, name: skill.name, body: skill.body };
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
