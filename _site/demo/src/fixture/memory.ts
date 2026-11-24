// The agent's memory in acme-shop: the workspace's own AGENTS.md (the rules the Instructions page's system prompt note
// quotes, plus a block brought over from another assistant), a short one for the web repo, and the api's, grown long
// enough that a turn starting in `api` has to leave it out: the one failure Settings ▸ Agent ▸ Memory draws in red.

const ROOT = `# acme-shop

- No legacy support – make clean breaking changes; update all usages.
- No migration logic – assume fresh state; remove compatibility layers.
- Prices are integers in cents everywhere; format only at the edge.

<!-- intentic:imported-memory:start -->
## Imported memory

## About me
Ada, founder of acme-shop. Writes in English, reads Polish.

## Preferences & working style
- Short answers first, detail on request.
- Show the diff before explaining it.
<!-- intentic:imported-memory:end -->
`;

const WEB = `# web

- Components in PascalCase files, one per file.
- Every page works without JavaScript for the first paint.
`;

// Every endpoint's contract, pasted in whole by someone who meant well: past the ceiling once the root's is counted.
const API = [
    `# api`,
    ``,
    ...Array.from(
        { length: 185 },
        (_, index) =>
            `- \`/v1/route-${String(index + 1).padStart(3, `0`)}\`: validates its body with zod, answers 422 with the first issue, and logs the request id.`,
    ),
].join(`\n`);

export const memoryFiles = (): [string, string][] => [
    [`AGENTS.md`, ROOT],
    [`web/AGENTS.md`, WEB],
    [`api/AGENTS.md`, API],
];
