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

// The intent repo's package.json: the two @intentic deps `resolve` imports, pinned to the caller's version (the
// CLI's own version, or the daemon's), or linked to local monorepo source with `link`.
export const intentPackageJson = (version: string, link: boolean): string => {
    const dependency = (pkg: string): string => (link ? `link:${join(LIBS_DIR, pkg)}` : `~${version}`);
    return `${JSON.stringify(
        {
            name: "intent",
            version: "0.0.0",
            private: true,
            type: "module",
            dependencies: { "@intentic/graph": dependency("graph"), "@intentic/sdk": dependency("sdk") },
        },
        undefined,
        4,
    )}\n`;
};
