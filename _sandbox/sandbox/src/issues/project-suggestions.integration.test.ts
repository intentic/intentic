import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectSuggestions } from "./project-suggestions.js";

// What Settings ▸ Projects and `projects suggest` offer: each repo's origin as the platform keys claims, the credential
// broker's loopback remote read for the upstream it names, and a repo with no remote left out.

const repo = (dir: string, origin?: string): void => {
    mkdirSync(dir, { recursive: true });
    execFileSync("git", ["init", "-q", dir]);
    if (origin !== undefined) {
        execFileSync("git", ["-C", dir, "remote", "add", "origin", origin]);
    }
};

const brokered = (upstream: string, path: string): string =>
    `http://127.0.0.1:8790/${Buffer.from(JSON.stringify({ u: upstream })).toString("base64url")}.sig/${path}`;

test("names each repo's origin as a project, the brokered ones by the upstream they stand for, once each", async () => {
    const root = mkdtempSync(join(tmpdir(), "suggest-"));
    try {
        repo(root, "git@github.com:Acme/Workspace.git");
        repo(join(root, "app"), "https://github.com/acme/app.git");
        repo(join(root, "billing"), brokered("https://github.com", "acme/billing.git"));
        repo(join(root, "scratch"));
        repo(join(root, "app-copy"), "https://github.com/acme/app");
        expect(await projectSuggestions(root)).toEqual(["github.com/acme/app", "github.com/acme/billing", "github.com/acme/workspace"]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
