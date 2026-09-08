import { VOCABULARY_PATH } from "./vocabulary.js";

// A brand-new knowledge base gets exactly one seed note: an agreed vocabulary, not example content that would need
// cleaning up later. It's prose, since the agent reads it; its example links are fenced so they don't add real edges to
// the graph.
const STARTER_VOCABULARY = `---
type: vocabulary
types: [person, project, company, decision, meeting, term, source]
relations: [works_on, knows, owns, part_of, decided_by, supersedes, about, source_of]
---

# Vocabulary

The words this knowledge base has agreed on. Reuse one before inventing another: four names for one relationship means
the knowledge base can no longer answer questions by relationship, which is most of what it is for.

Nothing here is enforced. A new word works the moment it is written and simply shows up as *not in the
vocabulary yet*: to adopt here, or to rename. Capture never fails.

## Kinds

| Kind | What it is |
| --- | --- |
| \`person\` | Someone real. How to work with them belongs here as much as what they do. |
| \`project\` | A body of work with an end or an owner. |
| \`company\` | An organisation: an employer, a customer, a vendor. |
| \`decision\` | A choice made, and **why**. The reason is the part that is invisible in six months. |
| \`meeting\` | A conversation worth remembering the outcome of. |
| \`term\` | A word that means something specific here and something else everywhere else. |
| \`source\` | Where a fact came from: an article, a thread, a document. |

## Relationships

| Relationship | Reads as |
| --- | --- |
| \`works_on\` | person → project |
| \`knows\` | person → person |
| \`owns\` | person or company → project |
| \`part_of\` | anything → the larger thing it belongs to |
| \`decided_by\` | decision → the person or meeting that made it |
| \`supersedes\` | decision → the decision it replaces |
| \`about\` | anything → what it concerns |
| \`source_of\` | source → the fact it supports |

## How a note is shaped

\`\`\`markdown
---
type: person
aliases: [Ada]
tags: [colleague]
works_on: ["[[Intentic]]"]
employer: Analytical Engines Ltd
---

Wrote the first program. Prefers short PRs, reviews on Tuesdays.
Came round to [[Why extensions]] eventually.
\`\`\`

- **\`type:\` is what makes a note a thing** rather than a page. Without one it is invisible to every question
  asked by kind.
- **A link in a header field is a named relationship.** The double brackets are what the graph sees: a bare
  \`works_on: Intentic\` is a string that connects nothing, and it looks perfectly fine while doing so.
- **A link in the prose is an ordinary connection.** Use it freely, mid-sentence.
- **The header holds what you would look something up BY**; the prose holds what you would want to read. Both
  are searched.

A link to a note nobody has written yet is fine and deliberate: it is this knowledge base's to-do list.
`;

// One note at the conventional path; a list since what a starter kb contains may change.
export const starterNotes = (): readonly { readonly path: string; readonly content: string }[] => [
    { path: VOCABULARY_PATH, content: STARTER_VOCABULARY },
];
