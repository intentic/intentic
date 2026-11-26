// The widget a customer's page loads (dist/widget.js, served at /door/intentic.visitor-chat/widget.js by the backend) is
// the @intentic/webchat-widget package in _sandbox/webchat-widget, a browser bundle that shares its embed helpers with
// the bug reporter through the wire contract's `embed` module, which an extension may not import. It is built there and
// copied here, last in `pnpm build`, after vite has emptied and refilled dist/; this package's turbo.json builds it
// first. A checkout where it was never built gets no copy, and the backend then answers the script tag with a console
// line saying so. The repository's root is found by its workspace file, as @intentic/constants' repoRoot finds it, which
// an extension may not depend on.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const here = import.meta.dirname;

const rootAbove = (dir) => {
    if (existsSync(join(dir, `pnpm-workspace.yaml`))) {
        return dir;
    }
    const parent = dirname(dir);
    return parent === dir ? undefined : rootAbove(parent);
};

const root = rootAbove(here);
const built = root === undefined ? undefined : join(root, `_sandbox`, `webchat-widget`, `dist`, `widget.js`);
if (built === undefined || !existsSync(built)) {
    console.warn(`visitor-chat: the widget's bundle is not built (${built ?? `no repository above ${here}`}), so dist/widget.js is left out`);
} else {
    const served = join(here, `..`, `dist`);
    mkdirSync(served, { recursive: true });
    copyFileSync(built, join(served, `widget.js`));
}
