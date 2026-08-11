// The extension bundle: one CJS file the editor loads (`main` in package.json), vscode left external as the
// host provides it. The app assets (media/app) and the engine bundle (engine/) are assembled by their own
// scripts — this builds only the extension host code.
import { build } from "esbuild";

await build({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    outfile: "dist/extension.cjs",
    external: ["vscode"],
    sourcemap: true,
});
