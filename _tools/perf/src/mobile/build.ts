import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Builds `_site/demo` for production into `outDir`, with sourcemaps so a CPU profile can name the source it spent time
 * in. A phone is measured against the build a phone gets: minified, split and compressed, never the dev server's one
 * module per file. The config is a wrapper written beside `outDir`, outside the repository, so a run leaves nothing in
 * the tree; it resolves workspace packages to their source (`@intentic/src`), as the dev server does, so a package whose
 * `dist` was never built (`@intentic/contract-serve`) still builds.
 */
export const buildDemo = async (repo: string, outDir: string): Promise<string> => {
    const demo = join(repo, "_site", "demo");
    const config = join(outDir, "..", "perf-mobile.demo.config.mjs");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(
        config,
        [
            `import base from ${JSON.stringify(join(demo, "vite.config.ts"))};`,
            `export default {`,
            `    ...base,`,
            `    resolve: { ...base.resolve, conditions: ["@intentic/src", "module", "browser", "production"] },`,
            `    build: { ...base.build, outDir: ${JSON.stringify(outDir)}, emptyOutDir: true, sourcemap: true },`,
            `};`,
            ``,
        ].join("\n"),
    );
    let output = "";
    const code = await new Promise<number | null>((resolve) => {
        const child = spawn(process.execPath, [join(demo, "node_modules", "vite", "bin", "vite.js"), "build", "--config", config], {
            cwd: demo,
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
        });
        child.stdout.on("data", (chunk: Buffer) => void (output += chunk.toString()));
        child.stderr.on("data", (chunk: Buffer) => void (output += chunk.toString()));
        child.once("exit", resolve);
    });
    if (code !== 0) {
        throw new Error(`the demo build failed (${code}):\n${output.slice(-4000)}`);
    }
    return outDir;
};
