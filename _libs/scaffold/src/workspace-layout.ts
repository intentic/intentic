// The canonical on-disk layout of an intentic workspace. Both the CLI (lib/artifact.ts) and the sandbox daemon
// (workspace.ts, config-store.ts, secrets.routes.ts) share these constants — they MUST agree on filenames and
// directory roles, and this module is the single source of truth. The scaffold package already owns the shape
// of a scaffolded workspace (intent-repo.ts) so these live beside it.

// Directory roles: the three repos a project's workspace operates on.
export type RepoRole = "intent" | "desired-state" | "app";
export const REPO_ROLES: readonly RepoRole[] = ["intent", "desired-state", "app"];

// Well-known directory names — used as the on-disk dir (relative to the workspace root's `repositories/`)
// AND as control-plane repo names.
export const INTENT_DIR = "intent";
export const TARGET_DIR = "desired-state";
export const APP_DIR = "app";

// Well-known filenames inside the repos.
export const CONFIG_FILE = "deploy.config.ts";
export const ARTIFACT_FILE = "desired-state.json";
export const LAST_APPLIED_FILE = ".last-applied.json";
export const STATUS_FILE = "status.json";
export const ACCESS_FILE = "access.md";
export const ENV_FILE = ".env";
export const SECRETS_FILE = ".secrets.json";
// The host-key lockfile: each host's pinned public key. Committed (a public key is not secret) so a key
// change is a reviewable diff and the Forgejo CI apply verifies against the reviewed pin.
export const KNOWN_HOSTS_FILE = ".known-hosts.json";
