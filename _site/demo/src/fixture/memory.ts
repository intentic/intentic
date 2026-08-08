import type { MemoryFile, MemoryFileEntry } from "@intentic/ext-memory";

/* WHAT THE AGENT REMEMBERS about acme-shop, across sessions — the markdown files under the workspace's
 * `.intentic/sessions/claude/projects/<project>/memory`, which is the one part of an agent's context the owner can read
 * and correct rather than infer.
 *
 * The notes are the demo's argument for the surface: they are the kind of thing a colleague learns in a first
 * week and nobody writes down — the CI incantation, the migration rule, the reviewer's standing objection. Each
 * one reads as something the agent was told once, and one of them is deliberately a little wrong, because the
 * view's point is that memory is editable and forgettable, not that it is always right.
 *
 * The fixture is MUTABLE: save and delete really write here, so the red pen works and the list updates. It
 * resets on reload, like every other piece of demo state. */

const PROJECT = `-work-acme-shop`;

interface Note {
    name: string;
    content: string;
    modifiedAt: number;
}

const seed = (now: number): Note[] => [
    {
        name: `MEMORY.md`,
        modifiedAt: now - 18 * 60_000,
        content: `# acme-shop

The storefront (\`web\`) and its API (\`api\`) in one workspace. Postgres is the only stateful dependency;
Stripe is the only third party that can take money.

- [conventions.md](conventions.md) — how this team writes code
- [ci.md](ci.md) — what green means here
- [database.md](database.md) — migrations, and the soft-delete rule
`,
    },
    {
        name: `conventions.md`,
        modifiedAt: now - 3 * 3_600_000,
        content: `# Conventions

- Tests live beside the code they cover, not in a mirrored tree.
- No barrel files. Import from the module that defines the thing.
- Server errors propagate; only the request boundary formats them.
- Ada reviews every schema change, without exception.
`,
    },
    {
        name: `ci.md`,
        modifiedAt: now - 26 * 3_600_000,
        content: `# CI

\`pnpm -C web test\` must pass before a push; the e2e suite runs on CI only.

The \`e2e (chromium)\` job has been flaky since the signup rework — a failure there is worth re-reading before
it is worth reverting for.
`,
    },
    {
        name: `database.md`,
        modifiedAt: now - 2 * 24 * 3_600_000,
        content: `# Database

Migrations are forward-only. There is no \`down\`, and rollback means writing the next migration.

Rows are **retired, never removed**: every table with user data carries \`deleted_at\`, and every read filters
on it. The users table was the last one still deleting for real.
`,
    },
];

let notes: Note[] | undefined;

const state = (now: number): Note[] => (notes ??= seed(now));

export const memoryList = (now: number): MemoryFileEntry[] =>
    state(now).map((note) => ({ project: PROJECT, name: note.name, sizeBytes: note.content.length, modifiedAt: note.modifiedAt }));

export const memoryFile = (now: number, project: string, name: string): MemoryFile | undefined => {
    const note = state(now).find((candidate) => candidate.name === name && project === PROJECT);
    return note === undefined
        ? undefined
        : { project: PROJECT, name: note.name, content: note.content, sizeBytes: note.content.length, modifiedAt: note.modifiedAt };
};

/** Write a note — an edit through the view's own editor, or a new file. */
export const saveMemoryFile = (now: number, name: string, content: string): void => {
    const all = state(now);
    const index = all.findIndex((note) => note.name === name);
    const written = { name, content, modifiedAt: now };
    if (index === -1) {
        all.push(written);
        return;
    }
    all[index] = written;
};

/** Forget one — the affordance the whole surface exists for. */
export const deleteMemoryFile = (now: number, name: string): void => {
    notes = state(now).filter((note) => note.name !== name);
};
