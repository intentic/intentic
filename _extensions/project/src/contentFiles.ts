import type { WorkspaceTreeEntry } from "@intentic/sandbox-contract";

// The files a maker came for, out of a folder's listing: documents, media, pages and the source that makes them, with
// tooling left out. The same judgement the workspace tree's technical filter makes, kept here in full since an
// extension cannot import the app's own (the listing it reads is the same daemon answer).

const LOCKFILES = new Set([
    `package-lock.json`,
    `pnpm-lock.yaml`,
    `yarn.lock`,
    `bun.lockb`,
    `bun.lock`,
    `Cargo.lock`,
    `poetry.lock`,
    `uv.lock`,
    `Gemfile.lock`,
    `composer.lock`,
    `go.sum`,
]);
const MANIFESTS = new Set([
    `package.json`,
    `pnpm-workspace.yaml`,
    `tsconfig.json`,
    `jsconfig.json`,
    `Dockerfile`,
    `docker-compose.yml`,
    `docker-compose.yaml`,
    `Makefile`,
    `go.mod`,
    `Cargo.toml`,
    `pyproject.toml`,
    `requirements.txt`,
    `setup.py`,
    `setup.cfg`,
    `Gemfile`,
    `composer.json`,
    `LICENSE`,
    `LICENSE.md`,
    `CODEOWNERS`,
]);
const TOOLING_DIRS = new Set([`node_modules`, `dist`, `build`, `out`, `coverage`, `target`, `vendor`, `__pycache__`, `venv`]);
const TEST_DIRS = new Set([`__tests__`, `__test__`, `test`, `tests`, `spec`, `specs`, `e2e`]);
const TEST_FILE = /\.(test|spec)\.|^test_|_test\./;
const TOOLING_FILE = /^tsconfig\..*\.json$|\.config\.(js|ts|mjs|cjs|mts|cts)$|\.d\.ts$|\.map$|\.tsbuildinfo$/;

export const isTechnical = (entry: Pick<WorkspaceTreeEntry, "name" | "type" | "ignored">): boolean => {
    if (entry.ignored === true || entry.name.startsWith(`.`)) {
        return true;
    }
    if (entry.type === `dir`) {
        return TOOLING_DIRS.has(entry.name) || TEST_DIRS.has(entry.name);
    }
    return LOCKFILES.has(entry.name) || MANIFESTS.has(entry.name) || TOOLING_FILE.test(entry.name) || TEST_FILE.test(entry.name);
};

// What a folder's listing shows a maker: folders first, then files, each alphabetical, tooling out.
export const contentEntries = (entries: readonly WorkspaceTreeEntry[]): WorkspaceTreeEntry[] =>
    entries
        .filter((entry) => !isTechnical(entry))
        .toSorted((left, right) => (left.type === right.type ? left.name.localeCompare(right.name) : left.type === `dir` ? -1 : 1));

// A file's kind for the icon beside it, by extension; anything unknown is a document.
export type ContentKind = "folder" | "document" | "image" | "media" | "sheet" | "page" | "code";

const IMAGE = /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i;
const MEDIA = /\.(mp3|wav|ogg|m4a|flac|mp4|webm|mov|mkv)$/i;
const SHEET = /\.(csv|tsv|xlsx|xls|ods)$/i;
const PAGE = /\.(html?|astro|vue|jsx|tsx)$/i;
const CODE = /\.(ts|js|mjs|cjs|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|cs|php|sh|css|scss|less|sql)$/i;

export const kindOf = (entry: Pick<WorkspaceTreeEntry, "name" | "type">): ContentKind => {
    if (entry.type === `dir`) {
        return `folder`;
    }
    if (IMAGE.test(entry.name)) {
        return `image`;
    }
    if (MEDIA.test(entry.name)) {
        return `media`;
    }
    if (SHEET.test(entry.name)) {
        return `sheet`;
    }
    if (PAGE.test(entry.name)) {
        return `page`;
    }
    return CODE.test(entry.name) ? `code` : `document`;
};

// The first paragraph of a README that is not a heading, a badge line or a blank: what the project page says a project
// is. Empty when the file has none.
export const summaryOf = (readme: string): string => {
    const first = readme
        .replace(/\r\n/g, `\n`)
        .split(/\n\s*\n/)
        .map((block) => block.trim())
        .find((block) => block !== `` && !block.startsWith(`#`) && !block.startsWith(`[![`) && !block.startsWith(`<`) && !block.startsWith(`---`));
    return (first ?? ``).replace(/\s+/g, ` `);
};
