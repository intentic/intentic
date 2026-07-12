import { fakeForgejoApi } from "@intentic/providers";
import { type GitRunner } from "@intentic/scaffold";
import { expect, test } from "vitest";
import { adoptRepos } from "./adopt.js";

// A git runner that records every invocation and answers the two queries adopt makes (status + remote) from
// the supplied maps, defaulting to empty (clean tree, no remotes) so the happy path is the default.
const recordingGit = (answers: { status?: string; remotes?: string } = {}): { git: GitRunner; calls: string[][] } => {
    const calls: string[][] = [];
    const git: GitRunner = async (dir, args) => {
        calls.push([dir, ...args]);
        if (args[0] === "status") {
            return { stdout: answers.status ?? "", stderr: "" };
        }
        if (args[0] === "remote" && args.length === 1) {
            return { stdout: answers.remotes ?? "", stderr: "" };
        }
        return { stdout: "", stderr: "" };
    };
    return { git, calls };
};

const baseUrl = "https://git.example.com";
const repos = [{ dir: "/w/intent", name: "intent" }] as const;

test("creates the repo when missing, commits a dirty tree, adds origin, and pushes main", async () => {
    let created: unknown;
    const api = fakeForgejoApi({
        findRepo: async () => undefined,
        createRepo: async (args) => {
            created = args;
            return { cloneUrl: "x", sshUrl: "y" };
        },
    });
    const { git, calls } = recordingGit({ status: " M desired-state.json\n" });
    const pushed = await adoptRepos({ baseUrl, user: "intentic", password: "pw", repos, log: () => {}, api, git });

    expect(created).toMatchObject({ owner: "intentic", name: "intent", private: true, autoInit: false });
    expect(calls).toContainEqual(["/w/intent", "add", "-A"]);
    expect(calls.some((c) => c.includes("commit"))).toBe(true);
    expect(calls).toContainEqual(["/w/intent", "remote", "add", "origin", "https://git.example.com/intentic/intent.git"]);
    const push = calls.find((c) => c.includes("push"));
    expect(push).toBeDefined();
    // Credentials ride only on the push command's http.extraHeader, never in the remote url.
    expect(push?.some((arg) => arg.startsWith("http.extraHeader=AUTHORIZATION: basic "))).toBe(true);
    expect(pushed).toEqual([{ name: "intent", cloneUrl: "https://git.example.com/intentic/intent.git" }]);
});

test("skips create when the repo exists, skips commit on a clean tree, and reuses an existing origin", async () => {
    let createCalled = false;
    const api = fakeForgejoApi({
        findRepo: async () => ({ cloneUrl: "x", sshUrl: "y" }),
        createRepo: async () => {
            createCalled = true;
            return { cloneUrl: "x", sshUrl: "y" };
        },
    });
    const { git, calls } = recordingGit({ remotes: "origin\n" });
    await adoptRepos({ baseUrl, user: "intentic", password: "pw", repos, log: () => {}, api, git });

    expect(createCalled).toBe(false);
    expect(calls.some((c) => c.includes("commit"))).toBe(false);
    expect(calls).toContainEqual(["/w/intent", "remote", "set-url", "origin", "https://git.example.com/intentic/intent.git"]);
});
