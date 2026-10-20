import { STATE_DIR } from "@intentic/constants";
import type { StateFile } from "./state-portability.js";
import type { WorkspaceStatePath } from "./workspace-state.js";

// The auth root holds AI-provider logins, the sandbox's secret vaults and the trust files a turn must not edit (mode
// 0600, off the file routes, tree walk and search index). It lives at `.intentic/secrets/auth/` unless AGENT_AUTH_DIR
// moved it, and the workspace table names it once, as a `secret` directory. This table classifies what is inside, so
// an export does not carry this sandbox's own keys and pairings with the credentials, and does not drop the owner's
// restrictions with them either. auth-state-coverage.test.ts in the daemon keeps it complete.
//
// The default for a path no entry claims is `secret`, the class of the directory itself: a provider home (`claude/`,
// `codex/`, `cliproxy/`, `opencode/`…) is a login, and a new provider lands secret by construction.
//
// The classes follow the history table's precedent. A restriction the owner set is `carry`: a secret that travels must
// not arrive ungated. A yes the owner gave (a grant, a release, a widened rule) is `identity`, like the hook and extension
// approvals there: a trust decision the target's owner makes again.

// Where the auth root sits inside the workspace when AGENT_AUTH_DIR does not move it; a declared workspace path.
export const AUTH_ROOT_IN_WORKSPACE = `${STATE_DIR}/secrets/auth/` as const satisfies WorkspaceStatePath;

// Auth-root-relative paths, forward-slash, matched by prefix; a directory keeps its trailing slash.
export const AUTH_STATE_FILES: readonly StateFile[] = [
    /* ---- the owner's restrictions: no credential in them, and loosened if left behind ---- */

    // Which credentials need a named person's click (secrets/credential-gates.ts).
    { path: "credential-gates.json", portability: "carry" },
    // Where each secret may be sent (secrets/guards/host-guards.ts).
    { path: "secret-hosts.json", portability: "carry" },
    // The privacy shield's policy: whether it masks, what it looks for, which providers it trusts.
    { path: "privacy-shield.json", portability: "carry" },
    // The execution boundary agents run in (workload/domain/agent-domain-policy.ts).
    { path: "agent-domain.json", portability: "carry" },

    /* ---- credentials and what holds their values ---- */

    { path: "sandbox-secrets.json", portability: "secret" },
    { path: "capability-secrets.json", portability: "secret" },
    { path: "extension-secrets.json", portability: "secret" },
    // The personal data the shield masked, by token, and the pictures it painted over.
    { path: "privacy-vault.json", portability: "secret" },
    { path: "privacy-images/", portability: "secret" },
    { path: "ssh-keys/", portability: "secret" },
    // An update's pre-images of the files above; a vault's copy is a vault.
    { path: "converting/", portability: "secret" },

    /* ---- yeses the owner gave here: decided again on the target ---- */

    // Sandbox-wide permissions ("Always: <line>") and each conversation's own (personas/owner-grants.ts,
    // conversation-grants.ts); a conversation's card simply asks again, so only the sandbox-wide ones carry a note.
    { path: "owner-grants.json", portability: "identity", note: "Give sandbox-wide permissions again from the Access tab." },
    { path: "conversation-grants.json", portability: "identity" },
    // An approver's release of a gated credential for one conversation.
    { path: "credential-releases.json", portability: "identity" },
    // Programs a secret may be typed into unasked; unset, every typing asks.
    { path: "secret-programs.json", portability: "identity", note: "Allow programs to receive secrets again from Secrets." },
    // Per-card credential rules and raw delivery, the owner's widening of a connector's own rules.
    { path: "credential-policy.json", portability: "identity", note: "Set a connection's credential rules and delivery again from Capabilities." },

    /* ---- this sandbox's own keys, and what it is paired with ---- */

    // The keyring keypair the owner's computers pinned their shares to; only the public halves ever leave.
    { path: "keyring-keys.json", portability: "identity", note: "Passwords shared from your computers are shared again with the new sandbox." },
    // What each connected computer's keyring said, the entries copied to this sandbox's key, deliveries waiting for a
    // computer, and the needs raised to them.
    { path: "keyring-devices.json", portability: "identity" },
    { path: "keyring-copies.json", portability: "identity" },
    { path: "keyring-sync-mailbox.json", portability: "identity" },
    { path: "keyring-needs.json", portability: "identity" },
    // The credential broker's signing key and the privacy gateway's token key, each minted on first use.
    { path: "broker-session.key", portability: "identity" },
    { path: "privacy-gateway.key", portability: "identity" },
    // The organisation policy the platform hands this sandbox; the target's platform hands its own.
    { path: "org-policy.json", portability: "identity" },

    /* ---- regenerated by the target ---- */

    // Seat refusals the provider answered, and the model catalogs fetched for each runtime.
    { path: "claude/seats.json", portability: "derived" },
    { path: "claude/models.json", portability: "derived" },
    { path: "cursor/models.json", portability: "derived" },
    { path: "devin/models.json", portability: "derived" },
    { path: "gemini/models.json", portability: "derived" },
    // Each custom endpoint's last discovered model list, fetched again from the endpoint.
    { path: "endpoints/", portability: "derived" },
    // Values a computer released for one use each, for masking only; never outlive the process handed them.
    { path: "keyring-released.json", portability: "derived" },
    // The shell script and socket OpenCode runs commands through, written at boot.
    { path: "opencode-shell/", portability: "derived" },
];
