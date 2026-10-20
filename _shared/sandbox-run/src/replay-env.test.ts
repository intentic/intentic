import { REPLAY_ENV, REPLAY_SECRET_ENV, REPLAY_VARS } from "./index.js";

// The replayed variables are one table: each name, what it says about the sandbox, and whether it is a credential. The
// two lists every reader already used are derived from it, so they cannot disagree with it or with each other.

test("a credential is never a path inside the container, an owner's ask or what the sandbox is for", () => {
    const misplaced = REPLAY_VARS.filter((entry) => "secret" in entry && ["layout", "choice", "purpose"].includes(entry.role)).map(
        (entry) => entry.name,
    );
    expect(misplaced).toEqual([]);
});

test("the credentials sealed at boot are exactly the table's secret rows", () => {
    expect([...REPLAY_SECRET_ENV].toSorted()).toEqual([
        "CLOUDFLARE_API_TOKEN",
        "CONNECT_TOKEN",
        "HOST_PAIR_TOKEN",
        "HOST_SSH_KEY",
        "RUNNER_PAIR_TOKEN",
        "SANDBOX_GRANT",
        "SYNC_PAIR_TOKEN",
    ]);
});

test("the replay order is the table's order, each name once", () => {
    expect(REPLAY_ENV).toEqual(REPLAY_VARS.map((entry) => entry.name));
    expect(new Set(REPLAY_ENV).size).toBe(REPLAY_ENV.length);
    expect(REPLAY_ENV.slice(0, 3)).toEqual(["WORKSPACE_ROOT", "HISTORY_ROOT", "AGENT_AUTH_DIR"]);
    expect(REPLAY_ENV.at(-1)).toBe("SANDBOX_PROJECTS_HOST");
});
