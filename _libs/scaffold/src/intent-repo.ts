import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
// dogfooded against unpublished packages. Computed from this compiled module's location: {src,dist} → scaffold → _libs.
const LIBS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// A `link:` spec into this monorepo's `_libs`, scaffold-relative. The CLI's `--link` dogfooding path uses it:
// the CLI bundle deps both graph + sdk, so both land beside scaffold under LIBS_DIR. NOT usable from the sandbox
// daemon — its bundle reaches graph (via scaffold) but not sdk, so the daemon resolves specs from its own tree.
export const libsLinkSpec = (pkg: "graph" | "sdk"): string => `link:${join(LIBS_DIR, pkg)}`;

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
