import { WORKSPACE_ROOT } from "@intentic/constants";
import type { GitRunner } from "@intentic/scaffold";
import { describe, test, expect } from "bun:test";
import { parseRemoteRefs, readRemoteRefs, RemoteRefsError } from "./remote-refs.js";

// What `git ls-remote --symref <url> HEAD refs/heads/* refs/tags/*` actually prints: the symref line, HEAD's own sha,
// two branches, a lightweight tag, and an annotated tag advertised twice.
const LS_REMOTE = [
    "ref: refs/heads/main\tHEAD",
    "0a75ceab7610febf29b6de3cdd7bf324a2c4dcd4\tHEAD",
    "0a75ceab7610febf29b6de3cdd7bf324a2c4dcd4\trefs/heads/main",
    "1111111111111111111111111111111111111111\trefs/heads/next",
    "2222222222222222222222222222222222222222\trefs/tags/v0.9.0",
    "fbcd64f90465af750c98b176e681917d3c0f464b\trefs/tags/v1.0.0",
    "3333333333333333333333333333333333333333\trefs/tags/v1.0.0^{}",
    "",
].join("\n");

describe(`parseRemoteRefs`, () => {
    test(`reads the default branch from the symref line`, () => {
        expect(parseRemoteRefs(LS_REMOTE).defaultBranch).toBe("main");
    });

    test(`a remote advertising no symref simply has no default branch`, () => {
        expect(parseRemoteRefs("0a75ceab7610febf29b6de3cdd7bf324a2c4dcd4\trefs/heads/main\n").defaultBranch).toBeUndefined();
    });

    test(`every branch and tag is named once, HEAD's own line is not a ref`, () => {
        expect(parseRemoteRefs(LS_REMOTE).refs.map((ref) => `${ref.kind} ${ref.name}`)).toEqual([
            "branch main",
            "branch next",
            "tag v0.9.0",
            "tag v1.0.0",
        ]);
    });

    test(`an annotated tag resolves to the commit it wraps, not to the tag object`, () => {
        const tag = parseRemoteRefs(LS_REMOTE).refs.find((ref) => ref.name === "v1.0.0");
        expect(tag?.sha).toBe("3333333333333333333333333333333333333333");
    });

    test(`a tag name holding a slash survives`, () => {
        expect(parseRemoteRefs("4444444444444444444444444444444444444444\trefs/tags/release/2024-05\n").refs).toEqual([
            { name: "release/2024-05", kind: "tag", sha: "4444444444444444444444444444444444444444" },
        ]);
    });
});

const refusing =
    (stderr: string): GitRunner =>
    () =>
        Promise.reject(Object.assign(new Error("git failed"), { stderr }));

describe(`readRemoteRefs`, () => {
    test(`refuses a non-http remote rather than letting git stop on a host-key prompt`, async () => {
        await expect(readRemoteRefs(WORKSPACE_ROOT, "git@github.com:owner/repo.git")).rejects.toThrow(RemoteRefsError);
    });

    test(`asks for HEAD by name, since --heads would filter the symref line out`, async () => {
        let asked: readonly string[] = [];
        const git: GitRunner = (_dir, args) => {
            asked = args;
            return Promise.resolve({ stdout: LS_REMOTE, stderr: "" });
        };
        await readRemoteRefs(WORKSPACE_ROOT, "https://github.com/owner/repo.git", undefined, git);
        expect(asked).toContain("HEAD");
        expect(asked).toContain("--symref");
        expect(asked).not.toContain("--heads");
    });

    test(`a token rides a header, never the URL, so it cannot land in a log or in git's error text`, async () => {
        let env: Readonly<Record<string, string>> | undefined;
        let asked: readonly string[] = [];
        const git: GitRunner = (_dir, args, passed) => {
            asked = args;
            env = passed;
            return Promise.resolve({ stdout: LS_REMOTE, stderr: "" });
        };
        await readRemoteRefs(WORKSPACE_ROOT, "https://github.com/owner/repo.git", "ghp_secret", git);
        expect(asked.join(" ")).not.toContain("ghp_secret");
        expect(env?.["GIT_CONFIG_KEY_0"]).toBe("http.extraheader");
        expect(env?.["GIT_CONFIG_VALUE_0"]).toContain(Buffer.from("x-access-token:ghp_secret").toString("base64"));
    });

    test(`never lets git ask a terminal for credentials: nothing can answer it`, async () => {
        let env: Readonly<Record<string, string>> | undefined;
        const git: GitRunner = (_dir, _args, passed) => {
            env = passed;
            return Promise.resolve({ stdout: LS_REMOTE, stderr: "" });
        };
        await readRemoteRefs(WORKSPACE_ROOT, "https://github.com/owner/repo.git", undefined, git);
        expect(env?.["GIT_TERMINAL_PROMPT"]).toBe("0");
    });

    test(`a private repo asked for without a token says to add one`, async () => {
        const stderr = "fatal: could not read Username for 'https://github.com': terminal prompts disabled";
        await expect(readRemoteRefs(WORKSPACE_ROOT, "https://github.com/owner/repo.git", undefined, refusing(stderr))).rejects.toThrow(
            /private: add an access token/,
        );
    });

    test(`the same refusal with a token given blames the token instead`, async () => {
        const stderr = "fatal: Authentication failed for 'https://github.com/owner/repo.git/'";
        await expect(readRemoteRefs(WORKSPACE_ROOT, "https://github.com/owner/repo.git", "ghp_x", refusing(stderr))).rejects.toThrow(
            /refused the access token/,
        );
    });

    test(`a missing repository is not reported as a credential problem`, async () => {
        const stderr = "remote: Repository not found.\nfatal: repository 'https://github.com/owner/nope.git/' not found";
        await expect(readRemoteRefs(WORKSPACE_ROOT, "https://github.com/owner/nope.git", undefined, refusing(stderr))).rejects.toThrow(
            /no repository at that address/,
        );
    });

    test(`an unrecognised failure still reaches the reader as git's own last fatal line`, async () => {
        const stderr = "warning: something\nfatal: the remote end hung up unexpectedly";
        await expect(readRemoteRefs(WORKSPACE_ROOT, "https://example.com/repo.git", undefined, refusing(stderr))).rejects.toThrow(
            /the remote end hung up unexpectedly/,
        );
    });
});
