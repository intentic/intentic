import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { describe, expect, test } from "vitest";

// The kit is published, a different set of obligations from every other package in `_editor`. An outside author
// installs `@intentic/extension-ui` to compile a screen against, getting declarations plus a bridge to the host's
// components, deliberately no source, since the components live in the unpublished `@intentic/ui`.
//
// That arrangement's failure mode is silent: the package keeps working here, where `@intentic/ui` is a directory away,
// and breaks only for whoever installs it. `_tools/checks/publish-set.mjs` catches the version of that which would 403
// the release; these are the ones it cannot see.
//
// It lives in the web app for the same reason extensionUiNames.test.ts does: the kit is a `.vue` graph with no test
// runner of its own.

const manifestPath = join(repoRoot(import.meta.url), `_shared/extension-ui/package.json`);
const manifest = JSON.parse(readFileSync(manifestPath, `utf8`)) as {
    private?: boolean;
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    exports: Record<string, unknown>;
    files: string[];
    scripts: Record<string, string>;
};

describe(`the published shape of @intentic/extension-ui`, () => {
    // A `workspace:` runtime dependency is the trap: it resolves here, packs as a version specifier npm cannot satisfy,
    // and the failure lands on the installer rather than the release. `@intentic/ui` belongs in devDependencies since
    // the published artifact carries its declarations rather than importing it.
    test(`declares no workspace package as a runtime dependency`, () => {
        const workspaceDeps = Object.entries({ ...manifest.dependencies, ...manifest.peerDependencies })
            .filter(([, spec]) => spec.startsWith(`workspace:`))
            .map(([name]) => name);
        expect(workspaceDeps).toEqual([]);
    });

    // It is in the release set (packages.sh); `private` would make the publish a silent no-op.
    test(`is not marked private`, () => {
        expect(manifest.private).toBeUndefined();
    });

    // Every path the manifest promises an installer must sit under a directory `files` actually packs. The
    // `@intentic/src` condition is exempt by construction: it is the in-repo branch, and its whole job is to point at
    // source.
    test(`every published entry point is inside the packed files`, () => {
        const published: string[] = [];
        const collect = (value: unknown): void => {
            if (typeof value === `string`) {
                published.push(value);
            } else if (value !== null && typeof value === `object`) {
                for (const [condition, nested] of Object.entries(value)) {
                    if (condition !== `@intentic/src`) {
                        collect(nested);
                    }
                }
            }
        };
        collect(manifest.exports);
        const packed = (path: string): boolean => manifest.files.some((entry) => path.replace(/^\.\//u, ``).startsWith(entry));
        expect(published.filter((path) => !packed(path))).toEqual([]);
    });

    // Everything it publishes is built, and `dist/` is gitignored, so a pack that runs without the build having
    // happened produces a tarball containing `src/` and nothing else: no error, a real version on the registry, an
    // install whose `main` resolves to nothing. The release does build first, so this is normally a no-op; it exists so
    // that "normally" is not what a published artifact's correctness rests on.
    test(`builds itself at pack time, so a tarball cannot ship without its dist`, () => {
        expect(manifest.scripts[`prepack`]).toBe(manifest.scripts[`build`]);
        expect(Object.keys(manifest.scripts)).toContain(`build`);
    });
});
