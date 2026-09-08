// Canonical on-disk layout of a workspace; the CLI and the sandbox daemon share these constants and must agree on
// filenames and directory roles.

// The three repos a project's workspace operates on.
export type RepoRole = "intent" | "desired-state" | "app";
export const REPO_ROLES: readonly RepoRole[] = ["intent", "desired-state", "app"];

// On-disk dir names, relative to the workspace root, doubling as control-plane repo names.
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
// Host-key lockfile (pinned public keys); committed so a key change is a reviewable diff, verified by CI apply.
export const KNOWN_HOSTS_FILE = ".known-hosts.json";
