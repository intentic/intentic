import { lockedWorkspaceEntry, STATE_DIR } from "@intentic/sandbox-contract";
import { basename } from "@intentic/ui/path";

// What a refused file holds and where it's managed; FileLocked.vue draws the refusal, this supplies the
// sentence, one per entry rather than a blanket line. Keyed on the daemon's own answer (lockedWorkspaceEntry),
// not a second reading of the rule, so it can't drift out of sync; a module, so the completeness test can assert it.

export interface LockedFile {
    // What it holds, in the reader's terms: completes "It holds …".
    readonly holds: string;
    // What to call it on screen: the entry, not a leaf inside it the reader may never have heard of.
    readonly subject: string;
    // The screen that owns this thing, when there is one.
    readonly manage?: { readonly label: string; readonly to: string };
}

const LOCKED: Record<string, LockedFile> = {
    // Holds no secret, only the reach-list; still locked, since editing it would grant an unapproved capability.
    "config/capabilities.json": {
        subject: `capabilities.json`,
        holds: `the list of accounts, computers and services this sandbox may reach, which the agent acts through`,
        manage: { label: `Capabilities`, to: `/capabilities` },
    },
    "identity/owner.json": {
        subject: `owner.json`,
        holds: `who this sandbox belongs to`,
        manage: { label: `Access`, to: `/sandbox/access` },
    },
    "identity/members.json": {
        subject: `members.json`,
        holds: `who you've invited to this sandbox`,
        manage: { label: `Access`, to: `/sandbox/access` },
    },
    "identity/control-tokens.json": {
        subject: `control-tokens.json`,
        holds: `the tokens that let this sandbox be driven from outside it`,
        manage: { label: `Access`, to: `/sandbox/access` },
    },
    "secrets/ci.json": { subject: `ci.json`, holds: `the secret your builds use to reach this sandbox` },
    "secrets/doors.json": {
        subject: `doors.json`,
        holds: `the tokens behind your webhooks, release gates and bug intakes`,
        manage: { label: `Access`, to: `/sandbox/access` },
    },
    // Provider CLI's own home, at the state dir's root: written by the agent's runtime, not a daemon store.
    "claude.json": {
        subject: `claude.json`,
        holds: `an agent's own sign-in`,
        manage: { label: `Agent settings`, to: `/sandbox/agent` },
    },
    "secrets/auth": {
        subject: `${STATE_DIR}/secrets/auth`,
        holds: `the agents' sign-ins with their providers, plus the vaults behind your connections and your extensions' settings`,
        manage: { label: `Agent settings`, to: `/sandbox/agent` },
    },
    "records/sessions": {
        subject: `${STATE_DIR}/records/sessions`,
        holds: `your agents' conversations, in the form their provider keeps them`,
        manage: { label: `Agents`, to: `/agents` },
    },
    "local/browser": {
        subject: `${STATE_DIR}/local/browser`,
        holds: `the browser profiles your agent is signed in on`,
        manage: { label: `Browsers`, to: `/browsers` },
    },
    ".git": { subject: `.git`, holds: `this workspace's own history, kept where nothing running here can rewrite it` },
};

// Exported for the completeness test alone; the app asks `lockedFile` below.
export const LOCKED_FILE_ENTRIES = LOCKED;

// Resolves `path` to its entry, or a fallback for a path the rule doesn't hold: unreachable via the viewer
// (same rule decides it's locked at all), but reachable by a pasted link, so it names the leaf honestly.
export const lockedFile = (path: string): LockedFile => {
    const entry = lockedWorkspaceEntry(path);
    return (
        (entry === undefined ? undefined : LOCKED[entry]) ?? {
            subject: basename(path),
            holds: `something only the sandbox itself uses`,
        }
    );
};
