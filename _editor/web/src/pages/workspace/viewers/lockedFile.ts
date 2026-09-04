import { lockedWorkspaceEntry, STATE_DIR } from "@intentic/sandbox-contract";
import { basename } from "@intentic/ui/path";

/* WHAT A REFUSED FILE HOLDS, AND WHERE THE THING INSIDE IT IS ACTUALLY MANAGED.
 *
 * A handful of entries under the workspace's own state folder hold the sandbox's keys: the sign-ins behind
 * every connected account, who owns the box, the browsers the agent is logged into. The daemon refuses them to
 * everyone, the owner included, because nothing needs to reach a credential by opening a file. FileLocked.vue
 * is where that refusal is drawn; this is what it has to say.
 *
 * Each entry gets its own sentence rather than one blanket line, because "kept private" answers nothing on its
 * own: what the reader wants to know is what is inside and where to go instead. The padlock is a door, not a
 * wall.
 *
 * KEYED ON THE DAEMON'S OWN ANSWER (lockedWorkspaceEntry), not on a second reading of the rule. This table used
 * to key on the leaf names the state dir had before it was regrouped — `owner.json`, `auth`, `sessions` — while
 * the rule had moved to `identity/owner.json`, `secrets/auth`, `records/sessions`. Nothing failed loudly: every
 * lookup simply missed, so every locked file in the product fell through to the generic sentence and lost the
 * button saying where to go instead. A table keyed on a string the contract HANDS BACK cannot drift that way,
 * and the test beside this file fails when an entry the contract declares has no sentence here.
 *
 * A module rather than the component's own script block for that last reason: the completeness of this table is
 * the whole guarantee, and a table inside an SFC cannot be asserted about. */

export interface LockedFile {
    // What it holds, in the reader's terms: completes "It holds …".
    readonly holds: string;
    /* What to call it on screen. The ENTRY, not the leaf the path ends at: a locked folder is drawn as one row
     * in the explorer and never descended, so a reader who reached a file inside one (a restored tab, a pasted
     * link) has never heard of that leaf — "Cookies is kept private" is a true sentence about nothing. The
     * folder is the fact; what is inside it is an implementation detail of the folder. */
    readonly subject: string;
    // The screen that owns this thing, when there is one.
    readonly manage?: { readonly label: string; readonly to: string };
}

const LOCKED: Record<string, LockedFile> = {
    /* The one entry here that holds no secret: its sign-ins moved to the vault under `secrets/auth`, and what is
     * left is the LIST — every account, computer and service the agent may reach. Locked all the same, because
     * adding a line to that list by saving a file would be granting a capability nobody approved. Its sentence
     * says connections rather than sign-ins for that reason; it is also the entry whose changes ARE readable,
     * since the root repo tracks it and the diff shows up in Changes. */
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
    /* The provider CLI's own home, which sits at the state dir's root rather than in a group: it is written by
     * the agent's runtime, not by any daemon store. */
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

/* What to say about `path`, and the fallback for a path the rule does not actually hold. That fallback cannot
 * be reached through the viewer, which resolves the same rule to decide it is looking at a locked file at all,
 * and can be reached by a link somebody pasted — so it names the leaf and says the honest little it knows. */
export const lockedFile = (path: string): LockedFile => {
    const entry = lockedWorkspaceEntry(path);
    return (
        (entry === undefined ? undefined : LOCKED[entry]) ?? {
            subject: basename(path),
            holds: `something only the sandbox itself uses`,
        }
    );
};
