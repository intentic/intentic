import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { listPublicFiles, resolvePublicFile } from "./public-files.js";

// The outbox's guards against a real directory; resolvePublicFile takes its root as an argument so these run against a
// temp dir. Every refusal 404s identically to a stranger; the reason is only visible via listPublicFiles.

const outbox = async (files: Record<string, string>): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "outbox-"));
    for (const [path, content] of Object.entries(files)) {
        const abs = join(root, path);
        await mkdir(join(abs, ".."), { recursive: true });
        await writeFile(abs, content);
    }
    return root;
};

const served = async (root: string, url: string): Promise<boolean> => (await resolvePublicFile(root, url)).kind === "file";

test("an ordinary file is served with the type its extension names; an unknown one downloads", async () => {
    const root = await outbox({ "report.pdf": "%PDF-1.4", "archive.tar.zst": "binary" });
    const pdf = await resolvePublicFile(root, "/report.pdf");
    expect(pdf).toMatchObject({ kind: "file", type: "application/pdf", inline: true });
    const archive = await resolvePublicFile(root, "/archive.tar.zst");
    expect(archive).toMatchObject({ kind: "file", type: "application/octet-stream", inline: false });
});

test("a directory serves its index.html and never a listing", async () => {
    const root = await outbox({ "site/index.html": "<h1>hi</h1>", "bare/note.txt": "no index here" });
    expect(await served(root, "/site")).toBe(true);
    expect(await served(root, "/site/")).toBe(true);
    // The directory exists and has a file in it: listing it would be the leak.
    expect(await resolvePublicFile(root, "/bare")).toMatchObject({ kind: "refused", status: 404 });
    expect(await resolvePublicFile(root, "/")).toMatchObject({ kind: "refused", status: 404 });
});

test("traversal out of the outbox is refused however it is spelled", async () => {
    const root = await outbox({ "ok.txt": "fine" });
    await writeFile(join(root, "..", "outside.txt"), "secret");
    for (const url of ["/../outside.txt", "/%2e%2e/outside.txt", "/site/../../outside.txt", "/..%2Foutside.txt"]) {
        expect(await served(root, url)).toBe(false);
    }
});

// Caught by checking the realpath, not the requested path; containment in resolvePublicFile is checked twice for this.
test("a symlink pointing outside the outbox is refused", async () => {
    const root = await outbox({ "ok.txt": "fine" });
    const secret = join(root, "..", `escape-${process.pid}.txt`);
    await writeFile(secret, "AWS keys live here");
    await symlink(secret, join(root, "innocent.txt"));
    expect(await served(root, "/innocent.txt")).toBe(false);
    expect(await served(root, "/ok.txt")).toBe(true);
});

// A same-outbox symlink passes containment, so the name rules must judge the resolved name, not the requested one, or
// `/logo.png -> .env` would serve and its extension would pick the wrong sniff rule too.
test("a symlink to a blocked file inside the outbox is refused under its innocent name", async () => {
    const root = await outbox({
        ".env": "CLOUDFLARE_API_TOKEN=abc123supersecret",
        "server.pem": "-----BEGIN PRIVATE KEY-----\nMIIabc",
        "ok.txt": "fine",
    });
    await symlink(join(root, ".env"), join(root, "logo.png"));
    await symlink(join(root, "server.pem"), join(root, "readme.txt"));
    // A PNG isn't sniffed at all, which is exactly why the resolved name has to be the one judged.
    expect(await served(root, "/logo.png")).toBe(false);
    expect(await served(root, "/readme.txt")).toBe(false);
    expect(await served(root, "/ok.txt")).toBe(true);
});

// A symlink between two servable files resolves to the type of the bytes it names.
test("a symlink to an ordinary file is served", async () => {
    const root = await outbox({ "v2/index.html": "<h1>hi</h1>" });
    await symlink(join(root, "v2", "index.html"), join(root, "latest.html"));
    expect(await resolvePublicFile(root, "/latest.html")).toMatchObject({ kind: "file", type: "text/html; charset=utf-8" });
});

test("hidden paths are refused at any depth: .env, .git and .ssh in one rule", async () => {
    const root = await outbox({ ".env": "TOKEN=abc", "site/.git/config": "[core]", ".ssh/id_rsa": "key" });
    expect(await served(root, "/.env")).toBe(false);
    expect(await served(root, "/site/.git/config")).toBe(false);
    expect(await served(root, "/.ssh/id_rsa")).toBe(false);
});

test("credential-shaped names are refused on the name alone", async () => {
    const root = await outbox({ "server.pem": "x", "deploy.key": "x", id_rsa: "x", credentials: "x", "notes.txt": "x" });
    expect(await served(root, "/server.pem")).toBe(false);
    expect(await served(root, "/deploy.key")).toBe(false);
    expect(await served(root, "/id_rsa")).toBe(false);
    expect(await served(root, "/credentials")).toBe(false);
    expect(await served(root, "/notes.txt")).toBe(true);
});

// The high-precision half. Each of these names its own issuer, so a match is evidence.
test("contents matching a known token format are refused even under an innocent name", async () => {
    const root = await outbox({
        "a.txt": "-----BEGIN RSA PRIVATE KEY-----\nMIIE...",
        "b.json": `{"aws":"AKIAIOSFODNN7EXAMPLE"}`,
        "c.txt": "ghp_abcdefghijklmnopqrstuvwxyz0123",
        "d.txt": "call it with sk-proj-abcdefghijklmnopqrstuvwxyz",
    });
    for (const path of ["/a.txt", "/b.json", "/c.txt", "/d.txt"]) {
        expect(await served(root, path)).toBe(false);
    }
});

// Deliberately not a guard: a generic "secret-ish word near a long value" rule would fire on all of this, and a
// publisher whose ordinary page gets refused stops trusting the feature.
test("prose and public config that merely mention secrets are served", async () => {
    const root = await outbox({
        "docs.html": `<form><label>password</label><input name="password" type="password"></form>`,
        "guide.md": "Set your API key: paste it into the token field and press save.",
        "firebase.json": `{"apiKey":"replace-me-with-your-own-key-value"}`,
    });
    expect(await served(root, "/docs.html")).toBe(true);
    expect(await served(root, "/guide.md")).toBe(true);
    expect(await served(root, "/firebase.json")).toBe(true);
});

test("binary types are not sniffed: a PNG whose bytes happen to match is still served", async () => {
    const root = await outbox({ "shot.png": "AKIAIOSFODNN7EXAMPLE" });
    expect(await served(root, "/shot.png")).toBe(true);
});

test("an absent outbox answers exactly like a missing file: publishing is simply off", async () => {
    expect(await resolvePublicFile(join(tmpdir(), "no-such-outbox-dir"), "/anything.txt")).toMatchObject({ kind: "refused", status: 404 });
});

// The owner's view explains itself: every file, with the reason it was refused.
test("the listing reports blocked files with their reason rather than hiding them", async () => {
    const root = await outbox({ "ok.txt": "fine", ".env": "TOKEN=abc", "server.pem": "x", "leak.txt": "ghp_abcdefghijklmnopqrstuvwxyz0123" });
    const listed = await listPublicFiles(root);
    expect(listed.map((entry) => entry.path)).toEqual([".env", "leak.txt", "ok.txt", "server.pem"]);
    expect(Object.fromEntries(listed.map((entry) => [entry.path, entry.blocked]))).toEqual({
        ".env": "hidden",
        "leak.txt": "credential-content",
        "ok.txt": undefined,
        "server.pem": "credential-name",
    });
});

// The listing must agree with the serve path on symlinks, or it promises links that 404 and hides ones that would have
// leaked. `escapes` names a link whose bytes land outside the outbox.
test("the listing judges a symlink by its target, and names the one that leaves the outbox", async () => {
    const root = await outbox({ ".env": "TOKEN=abc", "ok.txt": "fine" });
    const outside = join(root, "..", `escape-${process.pid}.txt`);
    await writeFile(outside, "aws_secret_access_key=zzz");
    await symlink(join(root, ".env"), join(root, "logo.png"));
    await symlink(outside, join(root, "keys.txt"));
    const listed = await listPublicFiles(root);
    expect(Object.fromEntries(listed.map((entry) => [entry.path, entry.blocked]))).toEqual({
        ".env": "hidden",
        "keys.txt": "escapes",
        "logo.png": "hidden",
        "ok.txt": undefined,
    });
});

test("the listing walks nested directories and reports outbox-relative paths", async () => {
    const root = await outbox({ "site/assets/app.css": "body{}", "site/index.html": "<h1>hi</h1>" });
    expect((await listPublicFiles(root)).map((entry) => entry.path)).toEqual(["site/assets/app.css", "site/index.html"]);
});
