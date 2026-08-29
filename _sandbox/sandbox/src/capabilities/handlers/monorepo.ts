import { existsSync } from "node:fs";
import { join } from "node:path";
import { capabilityJobSession } from "../../terminal/terminal-session.js";
import { isValidRepoName } from "../../workspace/repo-discovery.js";
import type { CapabilityHandler } from "../capability.js";

// Monorepo: scaffold an empty pnpm+turbo monorepo as its own repo at /work/<id> (the `id` is the repo
// name), with a control operator panel, so the user can then add apps (API/Web/Landing) into it from that panel.
// Mirrors devops (a platform capability that scaffolds a repo); idempotent via the existence gate, and no
// `remove`, deleting the repo would destroy the user's work. The scaffold is one visible `intentic scaffold monorepo`
// command in the job session the first frame surfaces (the add-apps pattern).
export const monorepoHandler: CapabilityHandler = {
    echo: () => ({}),
    // The name IS the repository's directory in the workspace, with the app panels and preview subdomains that
    // hang off it. Renaming here would leave the repo where it is and lose sight of it.
    rename: { refuse: "This name is the monorepo's folder in your workspace, rename the repository itself instead." },
    async *apply(ctx, id) {
        // `--` is the separator in an app preview's key/subdomain (<repo>--<app>), so a monorepo name can't
        // contain it without risking a collision with another monorepo's app panel.
        if (!isValidRepoName(id) || id.includes("--")) {
            throw new Error(
                `"${id}" is not a valid monorepo name: use lowercase letters, digits and single hyphens, and avoid the reserved repo names`,
            );
        }
        if (existsSync(join(ctx.workspace.root, id))) {
            yield { kind: "log", message: `Monorepo "${id}" already present.` };
            return;
        }
        const session = capabilityJobSession(id);
        if (ctx.terminalRun.visible) {
            yield { kind: "terminal", session };
        }
        yield { kind: "log", message: `Scaffolding pnpm + turbo monorepo "${id}"…` };
        await ctx.scaffoldMonorepo(id, session);
        yield { kind: "log", message: `Monorepo "${id}" ready, open its panel to add apps (API / Web / Landing).` };
    },
    status: (ctx, id) => Promise.resolve(existsSync(join(ctx.workspace.root, id)) ? { state: "active" } : { state: "inactive" }),
};
