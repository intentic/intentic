import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { packageRoot } from "@intentic/constants/node";
import { CONFIG_FILE, ENV_FILE, LAST_APPLIED_FILE, SECRETS_FILE } from "./workspace-layout.js";

// Keep secret + local-only files out of the PR-managed desired-state repo: the user-supplied `.env`, the
// intentic-generated `.secrets.json`, the `.secrets-sync.json` CI-push record, and the `.last-applied.json`
// prune baseline. `.env.example` is not written here — `resolve` generates it from the graph, the only
// complete source of the required keys.
export const TARGET_GITIGNORE = `${ENV_FILE}\n${SECRETS_FILE}\n.secrets-sync.json\n${LAST_APPLIED_FILE}\n`;

// The intent repo is a self-contained TS project; provisioning runs `pnpm install` in it, producing a
// node_modules/ that must stay out of the repo.
export const INTENT_GITIGNORE = "node_modules/\n";

// A standalone TS project for the one config file: type-strip-importable by `resolve`, type-checked in an
// editor against the @intentic/* packages' shipped declarations (no build of the intent repo itself).
export const INTENT_TSCONFIG = `${JSON.stringify(
    {
        compilerOptions: { module: "nodenext", moduleResolution: "nodenext", target: "ES2024", strict: true, skipLibCheck: true, noEmit: true },
        include: [CONFIG_FILE],
    },
    undefined,
    4,
)}\n`;

// `--link` resolves @intentic/* to this monorepo's local source instead of the registry, so the CLI can be
// dogfooded against unpublished packages. The directory this package SITS IN — found by locating the package
// root and stepping out of it, so neither the {src,dist} split nor this file's depth is part of the answer.
const SCAFFOLD_PARENT = dirname(packageRoot(import.meta.url));

// A `link:` spec to a local graph/sdk, scaffold-relative. In the CLI bundle both land BESIDE scaffold
// (node_modules/@intentic/*); in the monorepo scaffold sits in _sandbox and both live in _deploy — the sibling
// wins when it exists. NOT usable from the sandbox daemon — its bundle reaches graph (via scaffold) but not
// sdk, so the daemon resolves specs from its own tree.
export const libsLinkSpec = (pkg: "graph" | "sdk"): string => {
    const sibling = join(SCAFFOLD_PARENT, pkg);
    return `link:${existsSync(sibling) ? sibling : join(SCAFFOLD_PARENT, "..", "_deploy", pkg)}`;
};

// The intent repo's package.json. The two @intentic deps `resolve` imports are pinned by the caller-supplied
// specs — a published `~<version>` range (registry) or a `link:` to local/bundled source.
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
