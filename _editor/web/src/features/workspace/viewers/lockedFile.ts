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
        holds: t(`workspace.lockedFile.holds.capabilities`),
        manage: { label: t(`shared.capabilities`), to: `/capabilities` },
    },
    "identity/owner.json": {
        subject: `owner.json`,
        holds: t(`workspace.lockedFile.holds.owner`),
        manage: { label: t(`sandbox.words.access`), to: `/sandbox/access` },
    },
    "identity/members.json": {
        subject: `members.json`,
        holds: t(`workspace.lockedFile.holds.members`),
        manage: { label: t(`sandbox.words.access`), to: `/sandbox/access` },
    },
    "identity/control-tokens.json": {
        subject: `control-tokens.json`,
        holds: t(`workspace.lockedFile.holds.controlTokens`),
        manage: { label: t(`sandbox.words.access`), to: `/sandbox/access` },
    },
    "identity/passkeys.json": {
        subject: `passkeys.json`,
        holds: t(`workspace.lockedFile.holds.passkeys`),
        manage: { label: t(`sandbox.words.access`), to: `/sandbox/access` },
    },
    "secrets/ci.json": { subject: `ci.json`, holds: t(`workspace.lockedFile.holds.ci`) },
    "secrets/doors.json": {
        subject: `doors.json`,
        holds: t(`workspace.lockedFile.holds.doors`),
        manage: { label: t(`sandbox.words.access`), to: `/sandbox/access` },
    },
    // Provider CLI's own home, at the state dir's root: written by the agent's runtime, not a daemon store.
    "claude.json": {
        subject: `claude.json`,
        holds: t(`workspace.lockedFile.holds.claude`),
        manage: { label: t(`workspace.lockedFile.agentSettings`), to: `/sandbox/agent` },
    },
    // An update's undo record, written by the boot that converts stored files; a copy of a vault is a vault.
    "secrets/converting": {
        // allow(contract-paths): a directory under the state dir, not a route
        subject: `${STATE_DIR}/secrets/converting`,
        holds: t(`workspace.lockedFile.holds.converting`),
    },
    "secrets/auth": {
        // allow(contract-paths): a directory under the state dir, not a route
        subject: `${STATE_DIR}/secrets/auth`,
        holds: t(`workspace.lockedFile.holds.auth`),
        manage: { label: t(`workspace.lockedFile.agentSettings`), to: `/sandbox/agent` },
    },
    "records/sessions": {
        subject: `${STATE_DIR}/records/sessions`,
        holds: t(`workspace.lockedFile.holds.sessions`),
        manage: { label: t(`shared.agents`), to: `/agents` },
    },
    "local/browser": {
        subject: `${STATE_DIR}/local/browser`,
        holds: t(`workspace.lockedFile.holds.browser`),
        manage: { label: t(`shared.browsers`), to: `/browsers` },
    },
    ".git": { subject: `.git`, holds: t(`workspace.lockedFile.holds.git`) },
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
            holds: t(`workspace.lockedFile.holds.unknown`),
        }
    );
};
