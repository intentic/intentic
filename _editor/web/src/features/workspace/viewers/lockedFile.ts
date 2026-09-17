import { lockedWorkspaceEntry, STATE_DIR } from "@intentic/sandbox-contract";
import { basename } from "@intentic/ui/path";
import { t } from "@intentic/ui/i18n";

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

const locked = (): Record<string, LockedFile> => ({
    // Holds no secret, only the reach-list; still locked, since editing it would grant an unapproved capability.
    "config/capabilities.json": {
        subject: `capabilities.json`,
        holds: `the list of accounts, computers and services this sandbox may reach, which the agent acts through`,
        manage: { label: t(`workspace.lockedFile.capabilities`), to: `/capabilities` },
    },
    "identity/owner.json": {
        subject: `owner.json`,
        holds: `who this sandbox belongs to`,
        manage: { label: t(`workspace.lockedFile.access`), to: `/sandbox/access` },
    },
    "identity/members.json": {
        subject: `members.json`,
        holds: `who you've invited to this sandbox`,
        manage: { label: t(`workspace.lockedFile.access`), to: `/sandbox/access` },
    },
    "identity/control-tokens.json": {
        subject: `control-tokens.json`,
        holds: `the tokens that let this sandbox be driven from outside it`,
        manage: { label: t(`workspace.lockedFile.access`), to: `/sandbox/access` },
    },
    "identity/passkeys.json": {
        subject: `passkeys.json`,
        holds: `the passkeys that open this sandbox, whether one is required, and the fingerprints of your recovery codes`,
        manage: { label: t(`workspace.lockedFile.access`), to: `/sandbox/access` },
    },
    "secrets/ci.json": { subject: `ci.json`, holds: `the secret your builds use to reach this sandbox` },
    "secrets/doors.json": {
        subject: `doors.json`,
        holds: `the tokens behind your webhooks, release gates and bug intakes`,
        manage: { label: t(`workspace.lockedFile.access`), to: `/sandbox/access` },
    },
    // Provider CLI's own home, at the state dir's root: written by the agent's runtime, not a daemon store.
    "claude.json": {
        subject: `claude.json`,
        holds: `an agent's own sign-in`,
        manage: { label: t(`workspace.lockedFile.agentSettings`), to: `/sandbox/agent` },
    },
    "secrets/auth": {
        subject: `${STATE_DIR}/secrets/auth`,
        holds: `the agents' sign-ins with their providers, plus the vaults behind your connections and your extensions' settings`,
        manage: { label: t(`workspace.lockedFile.agentSettings`), to: `/sandbox/agent` },
    },
    "records/sessions": {
        subject: `${STATE_DIR}/records/sessions`,
        holds: `your agents' conversations, in the form their provider keeps them`,
        manage: { label: t(`workspace.lockedFile.agents`), to: `/agents` },
    },
    "local/browser": {
        subject: `${STATE_DIR}/local/browser`,
        holds: `the browser profiles your agent is signed in on`,
        manage: { label: t(`workspace.lockedFile.browsers`), to: `/browsers` },
    },
    ".git": { subject: `.git`, holds: `this workspace's own history, kept where nothing running here can rewrite it` },
});

// Exported for the completeness test alone; the app asks `lockedFile` below. A function for the same reason the
// table is one: its words are read when something draws them, not when this module loads.
export const lockedFileEntries = locked;

// Resolves `path` to its entry, or a fallback for a path the rule doesn't hold: unreachable via the viewer
// (same rule decides it's locked at all), but reachable by a pasted link, so it names the leaf honestly.
export const lockedFile = (path: string): LockedFile => {
    const entry = lockedWorkspaceEntry(path);
    return (
        (entry === undefined ? undefined : locked()[entry]) ?? {
            subject: basename(path),
            holds: `something only the sandbox itself uses`,
        }
    );
};
