// What a git that talks to a remote over http(s) carries, spelled once for every tier that runs one.

// A credential as an http header, handed to git through its environment (GIT_CONFIG_COUNT/KEY/VALUE) rather than as
// `-c http.extraheader=…` on the command line. Argv is readable by every process in /proc, lands in the daemon's slow-git
// log, and comes back whole in execFile's "Command failed: git …" text; the environment does none of that, and like `-c`
// it never reaches .git/config. It replaces any GIT_CONFIG_* pairs the caller's own environment held.
export const gitHeaderEnv = (header: string): Readonly<Record<string, string>> => ({
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraheader",
    GIT_CONFIG_VALUE_0: header,
});

// An access token as the Basic credential GitHub and GitLab both accept from a PAT.
export const gitAuthHeader = (token: string): string => `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;

// A transfer slower than 1 KB/s for 30 s is a dead connection, aborted by git itself rather than by racing a timer, so
// no git is left running behind an answer nobody waits for. One value for an install form's `ls-remote` and a background
// fetch alike: the form's answer is a few kilobytes, so the window only decides how long a dead connection takes to say
// so, while a fetch of a large pack over a slow link is the case it must not cut short.
export const GIT_STALL_GUARD = ["-c", "http.lowSpeedLimit=1000", "-c", "http.lowSpeedTime=30"] as const;
