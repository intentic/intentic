import { main } from "./cli/main.js";

// The CLI entry vite bundles to dist/cli.js; bin/e-urzad runs it.
process.exitCode = await main(process.argv.slice(2), process.env, (text) => {
    process.stdout.write(text);
});
