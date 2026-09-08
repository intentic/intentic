import { fakeForgejoApi } from "@intentic/providers";
import type { GitRunner } from "@intentic/scaffold";
import { expect, test } from "vitest";
import { adoptRepos } from "./adopt.js";

// Fake git runner answering adopt's two queries (staged diff, remote list) from the given maps;
// defaults to empty so the happy path needs no answers.
const recordingGit = (answers: { staged?: string; remotes?: string } = {}): { git: GitRunner; calls: string[][] } => {
    const calls: string[][] = [];
    const git: GitRunner = async (dir, args) => {
        calls.push([dir, ...args]);
        if (args[0] === "diff" && args[1] === "--cached") {
            return { stdout: answers.staged ?? "", stderr: "" };
        }
        if (args[0] === "remote" && args.length === 1) {
            return { stdout: answers.remotes ?? "", stderr: "" };
        }
        return { stdout: "", stderr: "" };
    };
    return { git, calls };
};

// Transport authority (SSH-forwarded loopback) vs the durable public origin.
const baseUrl = "http://127.0.0.1:9999";
const originBaseUrl = "https://git.example.com";
const repos = [{ dir: "/w/intent", name: "intent" }] as const;

test("creates the repo when missing, commits a dirty tree, adds the public origin, and pushes main over the transport url", async () => {
    let created: unknown;
    const api = fakeForgejoApi({
        findRepo: async () => undefined,
        createRepo: async (args) => {
            created = args;
            return { cloneUrl: "x", sshUrl: "y" };
        },
    });
    const { git, calls } = recordingGit({ staged: "desired-state.json\0" });
    const pushed = await adoptRepos({ baseUrl, originBaseUrl, user: "intentic", password: "pw", repos, log: () => {}, api, git });

    expect(created).toMatchObject({ owner: "intentic", name: "intent", private: true, autoInit: false });
    // --ignore-errors skips one unstageable path; embedded-repo advice off since nested repos are ordinary here.
    expect(calls).toContainEqual(["/w/intent", "-c", "advice.addEmbeddedRepo=false", "add", "-A", "--ignore-errors"]);
    expect(calls.some((c) => c.includes("commit"))).toBe(true);
    // origin carries the public url; push targets the transport url directly, so it works without tunnel or DNS.
    expect(calls).toContainEqual(["/w/intent", "remote", "add", "origin", "https://git.example.com/intentic/intent.git"]);
    const push = calls.find((c) => c.includes("push"));
    expect(push).toContain("http://127.0.0.1:9999/intentic/intent.git");
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
    await adoptRepos({ baseUrl, originBaseUrl, user: "intentic", password: "pw", repos, log: () => {}, api, git });

    expect(createCalled).toBe(false);
    expect(calls.some((c) => c.includes("commit"))).toBe(false);
    expect(calls).toContainEqual(["/w/intent", "remote", "set-url", "origin", "https://git.example.com/intentic/intent.git"]);
});
