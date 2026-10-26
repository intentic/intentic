import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type BundleChunk, offlineFiles, OFFLINE_VIEWS, PRECACHE_MARKER, withPrecache } from "../vite.offline";

// What the build tells public/sw.js to fetch when it installs (vite.offline.ts): the shell, the stylesheet, the entry
// and the outage path's views with what they import statically, and nothing a view only loads lazily.

const ROOT = `/repo/_editor/web`;
const chunk = (fileName: string, options: Partial<BundleChunk> = {}): BundleChunk => ({ fileName, isEntry: false, imports: [], moduleIds: [], ...options });

const BUNDLE: BundleChunk[] = [
    chunk(`assets/index-e1.js`, { isEntry: true, imports: [`assets/vue-v1.js`], moduleIds: [`${ROOT}/src/main.ts`] }),
    chunk(`assets/vue-v1.js`, { moduleIds: [`/repo/node_modules/vue/index.js`] }),
    chunk(`assets/PlatformUnavailable-p1.js`, {
        imports: [`assets/DirectSandboxes-d1.js`, `assets/vue-v1.js`],
        moduleIds: [`${ROOT}/src/features/setup/PlatformUnavailable.vue?vue&type=script&setup=true&lang.ts`],
    }),
    chunk(`assets/DirectSandboxes-d1.js`, { moduleIds: [`${ROOT}/src/features/sandbox/recovery/DirectSandboxes.vue`] }),
    chunk(`assets/WorkspaceShell-w1.js`, { imports: [`assets/vue-v1.js`], moduleIds: [`${ROOT}/src/shell/WorkspaceShell.vue`] }),
    chunk(`assets/Settings-s1.js`, { imports: [`assets/Heavy-h1.js`], moduleIds: [`${ROOT}/src/features/settings/SettingsHub.vue`] }),
    chunk(`assets/Heavy-h1.js`, { moduleIds: [`/repo/node_modules/heavy/index.js`] }),
];

describe(`offlineFiles`, () => {
    it(`lists the shell, the runtime config, the stylesheet, the entry and the outage path's views with their static imports, and nothing else`, () => {
        expect(offlineFiles(BUNDLE, [`assets/index-c1.css`], [`src/features/setup/PlatformUnavailable.vue`, `src/shell/WorkspaceShell.vue`])).toEqual([
            `/`,
            `/assets/js/env.js`,
            `/assets/index-c1.css`,
            `/assets/DirectSandboxes-d1.js`,
            `/assets/PlatformUnavailable-p1.js`,
            `/assets/WorkspaceShell-w1.js`,
            `/assets/index-e1.js`,
            `/assets/vue-v1.js`,
        ]);
    });

    it(`matches a view by its whole path, so a file that only ends the same way is not taken`, () => {
        const lookalike = [chunk(`assets/x-1.js`, { moduleIds: [`${ROOT}/src/other/MyWorkspaceShell.vue`] })];
        expect(offlineFiles(lookalike, [], [`src/shell/WorkspaceShell.vue`])).toEqual([`/`, `/assets/js/env.js`]);
    });

    it(`names views that exist in this package`, () => {
        for (const view of OFFLINE_VIEWS) {
            expect(() => readFileSync(resolve(import.meta.dirname, `..`, view)), view).not.toThrow();
        }
    });
});

describe(`withPrecache`, () => {
    it(`writes the list where the marker stands, as a value the worker reads`, () => {
        const written = withPrecache(`const PRECACHE = ${PRECACHE_MARKER};`, { build: `17`, urls: [`/`, `/assets/a.js`] });
        expect(written).toBe(`const PRECACHE = {"build":"17","urls":["/","/assets/a.js"]};`);
    });

    it(`refuses a worker without the marker, or with two`, () => {
        expect(() => withPrecache(`const PRECACHE = null;`, { build: `1`, urls: [] })).toThrow(`exactly once (found 0)`);
        expect(() => withPrecache(`${PRECACHE_MARKER}${PRECACHE_MARKER}`, { build: `1`, urls: [] })).toThrow(`exactly once (found 2)`);
    });

    it(`finds exactly one marker in the real public/sw.js`, () => {
        const worker = readFileSync(resolve(import.meta.dirname, `../public/sw.js`), `utf8`);
        expect(worker.split(PRECACHE_MARKER).length).toBe(2);
    });
});
