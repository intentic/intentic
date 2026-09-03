import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { describe, expect, test } from "vitest";

/* THE KIT IS PUBLISHED, and that is a different set of obligations from every other package in `_editor`.
 *
 * An extension author outside this monorepo installs `@intentic/extension-ui` to compile a screen against.
 * What they get is declarations plus a bridge to the host's own components: deliberately no source, because
 * the components live in `@intentic/ui`, which is the whole app design system and is not published (doing so
 * would put a semver promise on all of it instead of on the curated slice this kit IS).
 *
 * That arrangement has one failure mode, and it is silent: the package keeps working HERE, where `@intentic/ui`
 * is a directory away, and breaks only for whoever installs it. `_tools/checks/publish-set.mjs` catches the version of
 * that which would 403 the release; these are the ones it cannot see.
 *
 * It lives in the web app rather than beside the kit for the same reason extensionUiNames.test.ts does: the kit
 * is a `.vue` graph with no test runner of its own, and the app is where its guards already are. */

const manifestPath = join(repoRoot(import.meta.url), `_editor/extension-ui/package.json`);
const manifest = JSON.parse(readFileSync(manifestPath, `utf8`)) as {
    private?: boolean;
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    exports: Record<string, unknown>;
    files: string[];
    scripts: Record<string, string>;
};

describe(`the published shape of @intentic/extension-ui`, () => {
    /* A `workspace:` RUNTIME dependency is the trap. It resolves here, packs as a version specifier npm cannot
     * satisfy, and the failure lands on the installer rather than on the release. `@intentic/ui` belongs in
     * devDependencies precisely because the published artifact carries its DECLARATIONS rather than importing
     * it: if it ever climbs back into `dependencies`, this is the sentence that says why it must not. */
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

    /* Every path the manifest promises an installer must sit under a directory `files` actually packs. An entry
     * pointing at `src/` would resolve in this repo and 404 in a consumer's node_modules. The `@intentic/src`
     * condition is exempt by construction: it is the in-repo branch, and its whole job is to point at source. */
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

    /* EVERYTHING IT PUBLISHES IS BUILT, AND `dist/` IS GITIGNORED, so a pack that runs without the build
     * having happened produces a valid tarball containing `src/` and `names.mjs` and NOTHING ELSE. No error, no
     * warning, a real version on the registry, and an install whose `main` resolves to a file that is not
     * there. That is measured rather than imagined: it is exactly what `pnpm pack` did here before `prepack`
     * existed. The release does build first, so this is normally a three-second no-op: it exists so that
     * "normally" is not what the correctness of a published artifact rests on. */
    test(`builds itself at pack time, so a tarball cannot ship without its dist`, () => {
        expect(manifest.scripts[`prepack`]).toBe(manifest.scripts[`build`]);
        expect(Object.keys(manifest.scripts)).toContain(`build`);
    });
});
