import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { packageRoot } from "@intentic/constants/node";
import { CONFIG_FILE, ENV_FILE, LAST_APPLIED_FILE, SECRETS_FILE } from "./workspace-layout.js";

// Keeps secret/local-only files out of the PR-managed repo; .env.example is generated separately by `resolve`.
export const TARGET_GITIGNORE = `${ENV_FILE}\n${SECRETS_FILE}\n.secrets-sync.json\n${LAST_APPLIED_FILE}\n`;

// Provisioning runs `pnpm install` here; the resulting node_modules/ must stay out of the repo.
export const INTENT_GITIGNORE = "node_modules/\n";

// Type-strip-importable by `resolve`; editor-checked against @intentic/*'s shipped types, never built.
export const INTENT_TSCONFIG = `${JSON.stringify(
    {
        compilerOptions: { module: "nodenext", moduleResolution: "nodenext", target: "ES2024", strict: true, skipLibCheck: true, noEmit: true },
        include: [CONFIG_FILE],
    },
    undefined,
    4,
)}\n`;

// Parent directory of this package (via its root), so neither the src/dist split nor this file's depth matters.
const SCAFFOLD_PARENT = dirname(packageRoot(import.meta.url));

// A `link:` spec to a local graph/sdk; prefers the sibling beside scaffold (CLI bundle), falling back to `_deploy`
// (monorepo). Not usable from the sandbox daemon, whose bundle reaches graph but not sdk.
export const libsLinkSpec = (pkg: "graph" | "sdk"): string => {
    const sibling = join(SCAFFOLD_PARENT, pkg);
    return `link:${existsSync(sibling) ? sibling : join(SCAFFOLD_PARENT, "..", "_deploy", pkg)}`;
};

// Pins the two @intentic deps `resolve` imports to caller-supplied specs: a `~<version>` range or a `link:` to local
// source.
export const intentPackageJson = (graphSpec: string, sdkSpec: string): string =>
    `${JSON.stringify(
        {
            name: "intent",
            version: "0.0.0",
            private: true,
            type: "module",
            dependencies: { "@intentic/graph": graphSpec, "@intentic/sdk": sdkSpec },
        },
        undefined,
        4,
    )}\n`;
