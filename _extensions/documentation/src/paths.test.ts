import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
    conversationIdOf,
    DOCS_DIR,
    INDEX_TAIL,
    mapConversationId,
    packageDocTail,
    publishedPath,
    REPO_DOC_TAIL,
    runIdAt,
    runPrefix,
    slugOf,
    splitRepo,
    STAGING_ROOT,
    stagingKey,
    stagingPath,
} from "./paths.js";

/* A workspace path back to (repo, package dir) — what a tree row's icon and a stored document tab both resolve
 * through. The root repo is "" and contains everything, so the whole correctness of this is the longest match. */
describe(`splitRepo`, () => {
    const repos = [``, `intentic`, `intentic/vendor`];

    it(`picks the deepest repo that contains the path`, () => {
        expect(splitRepo(`intentic/_apps/acp-bridge`, repos)).toEqual({ repo: `intentic`, dir: `_apps/acp-bridge` });
        // Nested inside another repo — the root and `intentic` both contain it, and neither is the answer.
        expect(splitRepo(`intentic/vendor/thing`, repos)).toEqual({ repo: `intentic/vendor`, dir: `thing` });
    });

    it(`reads a repo's own directory as that repo's overview`, () => {
        expect(splitRepo(`intentic`, repos)).toEqual({ repo: `intentic`, dir: `` });
        expect(splitRepo(``, repos)).toEqual({ repo: ``, dir: `` });
    });

    it(`does not mistake a sibling whose name starts the same`, () => {
        expect(splitRepo(`intentic-site/src`, repos)).toEqual({ repo: ``, dir: `intentic-site/src` });
    });

    it(`answers nothing when no repo contains the path`, () => {
        expect(splitRepo(`elsewhere/pkg`, [`intentic`])).toBeUndefined();
    });
});

describe(`the two document trees`, () => {
    it(`mirrors published and staged tails so publishing is a copy, never a translation`, () => {
        const tail = packageDocTail(`_libs/graph`);
        expect(publishedPath(`intentic`, tail)).toBe(`intentic/docs/architecture/_libs/graph/doc.json`);
        expect(stagingPath(`intentic`, tail)).toBe(`.intentic/docs/intentic/_libs/graph/doc.json`);
        // The tail — the part publish carries across — is identical on both sides.
        expect(publishedPath(`intentic`, tail).endsWith(tail)).toBe(true);
        expect(stagingPath(`intentic`, tail).endsWith(tail)).toBe(true);
    });

    it(`names the workspace root repo instead of collapsing its paths`, () => {
        // The root repo is the empty string, and joining "" would produce a leading slash published-side and a
        // path that lands on STAGING_ROOT itself staged-side.
        expect(publishedPath(``, REPO_DOC_TAIL)).toBe(`docs/architecture/repo.json`);
        expect(stagingKey(``)).toBe(`root`);
        expect(stagingPath(``, REPO_DOC_TAIL)).toBe(`.intentic/docs/root/repo.json`);
    });

    it(`keeps every staged path under one prefix, which is what makes the file-change push declarable`, () => {
        // contributes.files declares `.intentic/docs/` and matching is by prefix; a staged path escaping it would
        // simply never invalidate the view.
        for (const path of [stagingPath(`a/b`, INDEX_TAIL), stagingPath(``, REPO_DOC_TAIL), stagingPath(`x`, packageDocTail(`p/q`))]) {
            expect(path.startsWith(`${STAGING_ROOT}/`)).toBe(true);
        }
    });
});

describe(`slugs and conversation ids`, () => {
    it(`collapses a package path into a single id-safe segment`, () => {
        // A slug lands in a conversation id (which becomes a branch name), so a separator would make it two path
        // segments.
        expect(slugOf(`_libs/graph`)).toBe(`libs-graph`);
        expect(slugOf(`_apps/web`)).toBe(`apps-web`);
        expect(slugOf(`packages/@scope/thing`)).toBe(`packages-scope-thing`);
    });

    it(`falls back rather than producing an empty slug`, () => {
        expect(slugOf(`日本語`)).toBe(`pkg`);
        expect(slugOf(`___`)).toBe(`pkg`);
        expect(slugOf(``)).toBe(`pkg`);
    });

    it(`keeps ids inside the 64-character conversation-id ceiling`, () => {
        const id = conversationIdOf(runIdAt(1_785_000_000_000), slugOf(`_libs/${`a`.repeat(80)}`));
        expect(id.length).toBeLessThanOrEqual(64);
        // Never left with a trailing separator after truncation — the id charset allows it but it reads as broken.
        expect(id.endsWith(`-`)).toBe(false);
    });

    it(`shares one prefix across every conversation in a run, so the fleet join needs no stored ids`, () => {
        const runId = runIdAt(1_785_000_000_000);
        expect(mapConversationId(runId).startsWith(runPrefix(runId))).toBe(true);
        expect(conversationIdOf(runId, slugOf(`_libs/graph`)).startsWith(runPrefix(runId))).toBe(true);
        // And not with a different run's.
        expect(conversationIdOf(runIdAt(1_785_000_001_000), `x`).startsWith(runPrefix(runId))).toBe(false);
    });

    it(`sorts run ids chronologically as strings, which is how the runs list windows to the newest`, () => {
        const older = runIdAt(1_785_000_000_000);
        const newer = runIdAt(1_785_000_001_000);
        expect([newer, older].toSorted((left, right) => left.localeCompare(right))).toEqual([older, newer]);
    });
});

/* THE DUPLICATION GUARD. `bin/intentic-docs` is plain ESM because it is executed directly by the agent's shell
 * with no build step, so it cannot import these constants from TypeScript and declares its own copy. That is a
 * deliberate, documented duplication — and this is what stops it from being a silent one.
 *
 * Read as text rather than imported: the file is extensionless (it has to be, to be invoked as `intentic-docs`),
 * which is not something the test runner's resolver is obliged to understand. Reading it also means the assertion
 * cannot be satisfied by a re-export that happens to agree at import time. */
describe(`bin/intentic-docs constants`, () => {
    const source = readFileSync(join(import.meta.dirname, `..`, `bin`, `intentic-docs`), `utf8`);
    const declared = (name: string): string | undefined => new RegExp(`export const ${name} = "([^"]+)"`).exec(source)?.[1];

    it(`declares the same document directory as paths.ts`, () => {
        expect(declared(`DOCS_DIR`)).toBe(DOCS_DIR);
    });

    it(`declares the same staging root as paths.ts`, () => {
        expect(declared(`STAGING_ROOT`)).toBe(STAGING_ROOT);
    });
});
