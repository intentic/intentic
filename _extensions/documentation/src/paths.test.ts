import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
    conversationIdOf,
    DOCS_DIR,
    holdsDraft,
    INDEX_TAIL,
    mapConversationId,
    packagePageTail,
    publishedPath,
    README_TAIL,
    REPO_DOC_TAIL,
    REPO_PROSE_TAIL,
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
        expect(splitRepo(`intentic/_sandbox/acp-bridge`, repos)).toEqual({ repo: `intentic`, dir: `_sandbox/acp-bridge` });
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
    /* A package's page is its own README, in the package — while the MAP still lives under `docs/architecture/`.
     * That split is the whole layout, and it is expressed once, here, so publishing stays a copy per tail. */
    it(`publishes a package page onto the package, not into the docs directory`, () => {
        const tail = packagePageTail(`_deploy/graph`);
        expect(publishedPath(`intentic`, tail)).toBe(`intentic/_deploy/graph/README.md`);
        expect(publishedPath(``, tail)).toBe(`_deploy/graph/README.md`);
    });

    it(`publishes the map's own tails under the docs directory`, () => {
        expect(publishedPath(`intentic`, REPO_DOC_TAIL)).toBe(`intentic/docs/architecture/repo.json`);
        expect(publishedPath(`intentic`, REPO_PROSE_TAIL)).toBe(`intentic/docs/architecture/repo.md`);
        expect(publishedPath(`intentic`, INDEX_TAIL)).toBe(`intentic/docs/architecture/index.json`);
    });

    it(`mirrors staged tails so publishing is a copy, never a translation`, () => {
        const tail = packagePageTail(`_deploy/graph`);
        expect(stagingPath(`intentic`, tail)).toBe(`.intentic/docs/intentic/_deploy/graph/README.md`);
        // The tail — the part publish carries across — is the end of the path on both sides.
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
        // simply never invalidate the view. A package page stages here too — only PUBLISHING sends it elsewhere.
        for (const path of [stagingPath(`a/b`, INDEX_TAIL), stagingPath(``, REPO_DOC_TAIL), stagingPath(`x`, packagePageTail(`p/q`))]) {
            expect(path.startsWith(`${STAGING_ROOT}/`)).toBe(true);
        }
    });
});

/* What makes a staging directory a DRAFT. This decides whether the area offers the Published/Draft toggle at all
 * and whether it opens on the draft, so getting it wrong takes the whole reading experience with it. */
describe(`holdsDraft`, () => {
    it(`does not call a derived index a draft`, () => {
        // The regression: `intentic-docs check --write` defaults to the staged tree, so updating a README that is
        // already in the repository drops an index here — and every reader got an empty draft instead of the docs.
        expect(holdsDraft([INDEX_TAIL])).toBe(false);
        expect(holdsDraft([])).toBe(false);
    });

    it(`counts the map`, () => {
        expect(holdsDraft([INDEX_TAIL, REPO_DOC_TAIL, REPO_PROSE_TAIL])).toBe(true);
    });

    it(`counts a run that is still writing`, () => {
        // A draft mid-flight is exactly what the banner exists to explain, so one package directory is enough.
        expect(holdsDraft([`_deploy`])).toBe(true);
    });
});

describe(`slugs and conversation ids`, () => {
    it(`collapses a package path into a single id-safe segment`, () => {
        // A slug lands in a conversation id (which becomes a branch name), so a separator would make it two path
        // segments.
        expect(slugOf(`_deploy/graph`)).toBe(`deploy-graph`);
        expect(slugOf(`_editor/web`)).toBe(`editor-web`);
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
        expect(conversationIdOf(runId, slugOf(`_deploy/graph`)).startsWith(runPrefix(runId))).toBe(true);
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

    // The tool decides which directories are documented by looking for this filename, and the browser reads the
    // page back from it. They disagreeing would show up as "no documentation yet" on a package that has one.
    it(`declares the same page filename as paths.ts`, () => {
        expect(declared(`README_TAIL`)).toBe(README_TAIL);
    });
});
