import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { FACE_BUILD, FACE_PACKAGE } from "./stack.js";

// Builds the local face the way the desktop app's own build does (`vite build --config vite.local.config.ts`, the last
// step of its `build` script), on every run: it takes seconds, and a CI workspace keeps its `dist` across checkouts, so
// a build that merely exists may be of another commit. LOCAL_FACE_REUSE_BUILD=1 keeps one that exists, for iterating
// on the spec alone.
export default function globalSetup(): void {
    if (process.env[`LOCAL_FACE_REUSE_BUILD`] === `1` && existsSync(FACE_BUILD)) {
        process.stdout.write(`local face: reusing ${FACE_BUILD} (LOCAL_FACE_REUSE_BUILD=1)\n`);
        return;
    }
    const built = spawnSync(process.execPath, [`node_modules/vite/bin/vite.js`, `build`, `--config`, `vite.local.config.ts`, `--logLevel`, `warn`], {
        cwd: FACE_PACKAGE,
        stdio: `inherit`,
        env: { ...process.env, NO_COLOR: `1` },
    });
    if (built.status !== 0 || !existsSync(FACE_BUILD)) {
        throw new Error(`the local face did not build (vite build --config vite.local.config.ts in ${FACE_PACKAGE}, exit ${String(built.status)})`);
    }
}
