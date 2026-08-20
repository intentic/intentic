import type { Graph, Note, NoteSummary, Overview, SearchHit } from "@intentic/ext-knowledge";
import { buildIndex, graphOf, hitsOf, neighbourhood, noteOf, type NoteFile, overviewFor, search, summaryOf } from "@intentic/ext-knowledge/notes";

/* THE KNOWLEDGE BASE for acme-shop, the things around the code that no file in the repository records: who
 * the people are, what the projects are for, and what was decided and why.
 *
 * It is the demo's argument for the surface. Every note here is the kind of fact a colleague picks up in a
 * first month and nobody writes down, and the notes are DELIBERATELY INTERCONNECTED: the point of the section
 * is not that it holds notes but that following one gets you to the next. One link points at a note nobody has
 * written, because that is the ordinary state of a real knowledge base and the panel is meant to show it as an
 * invitation rather than as damage.
 *
 * Written as raw markdown and indexed by the extension's own engine, so the demo's backlinks, graph and counts
 * are computed exactly as the product computes them, a fixture that hand-authored those answers would be
 * showing visitors behaviour the product does not have.
 *
 * MUTABLE: save, delete and starting it off really writes here, so the red pen works and the list
 * updates. It resets on reload, like every other piece of demo state. */

const md = (path: string, content: string, minutesAgo: number, now: number): NoteFile => ({
    path,
    content,
    modifiedAt: now - minutesAgo * 60_000,
    sizeBytes: content.length,
});

const seed = (now: number): NoteFile[] => [
    md(
        `_vocabulary.md`,
        `---
type: vocabulary
types: [person, project, company, decision, term]
relations: [works_on, knows, owns, decided_by, supersedes, about]
---

# Vocabulary

The words this knowledge base has agreed on. Reuse one before inventing another — four names for one relationship means
it can no longer answer questions by relationship.

- \`person\` — someone real. How to work with them matters as much as what they do.
- \`project\` — a body of work with an owner.
- \`decision\` — a choice made, and **why**. The reason is the part that is invisible in six months.
- \`term\` — a word that means something specific here and something else everywhere else.
`,
        60 * 24 * 9,
        now,
    ),
    md(
        `person/ada-okafor.md`,
        `---
type: person
title: Ada Okafor
aliases: [Ada]
tags: [colleague, reviewer]
works_on: ["[[Storefront]]"]
knows: ["[[Ravi Menon]]"]
employer: Acme
timezone: Europe/Lisbon
---

Reviews every schema change, without exception — that is a standing agreement, not a preference, and it dates
from the incident behind [[Soft delete everything]].

Prefers small PRs and will say so. Reviews on Tuesdays and Thursdays; anything landed on a Friday afternoon
will be looked at on Monday and she would rather it waited.
`,
        41,
        now,
    ),
    md(
        `person/ravi-menon.md`,
        `---
type: person
title: Ravi Menon
tags: [colleague]
works_on: ["[[Checkout API]]"]
knows: ["[[Ada Okafor]]"]
employer: Acme
---

Owns payments. The only person who has read the Stripe webhook retry semantics end to end, which is why
[[Idempotency key]] says what it says.

Asks for a diagram before a design conversation and is right to.
`,
        60 * 6,
        now,
    ),
    md(
        `project/storefront.md`,
        `---
type: project
title: Storefront
tags: [web]
owns: ["[[Ada Okafor]]"]
repo: acme-shop/web
---

The customer-facing shop. Server-rendered, no client router — a decision that predates everyone currently on
it and is still the right one for a page whose job is to load fast on a phone.

Talks to [[Checkout API]] and to nothing else directly.
`,
        60 * 30,
        now,
    ),
    md(
        `project/checkout-api.md`,
        `---
type: project
title: Checkout API
tags: [api, payments]
owns: ["[[Ravi Menon]]"]
repo: acme-shop/api
---

Takes money. Postgres is the only stateful dependency; Stripe is the only third party that can move funds.

Every write path is expected to be safe to retry — see [[Idempotency key]].
`,
        60 * 52,
        now,
    ),
    md(
        `decision/soft-delete-everything.md`,
        `---
type: decision
title: Soft delete everything
tags: [database]
about: ["[[Checkout API]]", "[[Storefront]]"]
decided_by: ["[[Ada Okafor]]"]
decided: 2026-03-11
---

Rows are never removed. Every table carries \`deleted_at\`, and every query filters on it.

**Why**, because this is the part that stops being obvious: a support request arriving four days after a
customer deletes an order used to be unanswerable, and a refund we could not prove we had made cost more than
the storage ever will. The rule is about the audit trail, not about undo.

It supersedes [[decision/hard-delete-with-backups]], which relied on a nightly dump nobody had restored.
`,
        60 * 24 * 3,
        now,
    ),
    md(
        `term/idempotency-key.md`,
        `---
type: term
title: Idempotency key
tags: [payments]
about: ["[[Checkout API]]"]
---

Here it means the **client-generated** UUID sent on every checkout mutation, not Stripe's own idempotency key,
which we also use and which is derived from it.

Confusing the two is how a duplicate charge happened in 2025: a retry reused Stripe's key across two different
carts, and Stripe correctly returned the first charge for the second cart.
`,
        60 * 24 * 12,
        now,
    ),
];

let seeded: NoteFile[] | undefined;

const noteFiles = (now: number): NoteFile[] => {
    seeded ??= seed(now);
    return seeded;
};

// Save (and create). Returns false for a path the real backend would refuse, so the demo's error state is the
// product's error state rather than an optimistic success.
export const saveKnowledgeNote = (now: number, path: string, content: string): boolean => {
    if (path.split(`/`).includes(`..`) || path.startsWith(`/`) || !path.toLowerCase().endsWith(`.md`)) {
        return false;
    }
    const notes = noteFiles(now);
    const existing = notes.findIndex((candidate) => candidate.path === path);
    const written = { path, content, modifiedAt: now, sizeBytes: content.length };
    if (existing === -1) {
        notes.push(written);
    } else {
        notes[existing] = written;
    }
    return true;
};

export const deleteKnowledgeNote = (now: number, path: string): boolean => {
    const notes = noteFiles(now);
    const at = notes.findIndex((candidate) => candidate.path === path);
    if (at === -1) {
        return false;
    }
    notes.splice(at, 1);
    return true;
};

// Where the demo's notes "are", the folder the panel names, and the same default a real sandbox uses.
const KNOWLEDGE_DIR = `knowledge`;

/* THE ANSWERS, computed by the extension's own engine over the notes above, not hand-authored. The backlinks,
 * the map and the drift report a visitor sees are the ones the product computes; a fixture that wrote them out
 * by hand would be showing behaviour the product does not have, and would go quietly wrong the first time the
 * engine improved. Everything below is one index build and one shaping call, exactly as the backend does it. */
const index = (now: number) => buildIndex(noteFiles(now));

export const knowledgeOverview = (): Overview => overviewFor(index(Date.now()), KNOWLEDGE_DIR);

export const knowledgeNotes = (): NoteSummary[] => {
    const built = index(Date.now());
    return built.notes.map((note) => summaryOf(note, built));
};

export const knowledgeSearch = (params: URLSearchParams): SearchHit[] => {
    const limit = Number(params.get(`limit`));
    return hitsOf(
        search(index(Date.now()), {
            query: params.get(`q`) ?? undefined,
            type: params.get(`type`) ?? undefined,
            tag: params.get(`tag`) ?? undefined,
            linkedTo: params.get(`linkedTo`) ?? undefined,
            limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
        }),
    );
};

// Undefined is a 404 at the route, the same as the real backend's, a note the visitor deleted a moment ago
// should read as gone, not as empty.
export const knowledgeNoteAt = (path: string): Note | undefined => {
    const built = index(Date.now());
    const note = built.byPath.get(path) ?? built.resolve(path);
    return note === undefined ? undefined : noteOf(note, built);
};

export const knowledgeGraph = (params: URLSearchParams): Graph => {
    const depth = Number(params.get(`depth`));
    return graphOf(neighbourhood(index(Date.now()), params.get(`focus`) ?? ``, Number.isFinite(depth) && depth > 0 ? depth : 2));
};
