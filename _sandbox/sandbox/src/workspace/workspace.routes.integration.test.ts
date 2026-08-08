import { execFile } from "node:child_process";

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createResidentEngine, type HealthRequest, type QueryRequest } from "@intentic/iq-engine";

import { HEALTH_LIMIT } from "@intentic/sandbox-contract";
import { shellQuote } from "@intentic/sandbox-run/quote";

import { DEFAULT_TEMPLATE_REF, DEFAULT_TEMPLATE_SOURCE } from "@intentic/scaffold";

import { expect, test } from "vitest";

import { createApp } from "../app.js";

import type { ManagedProcesses, ProcessSpec } from "../processes/managed-processes.js";

import { unstubbed } from "@intentic/testing";

import { workspacePaths } from "./workspace.js";
import { MAX_RAW_BYTES, sha256Text, statWorkspaceFileSize, UploadTooLargeError } from "./workspace-files.js";

import { clientFor, errorCode, fakeFiles, fakeHistory, services, tempWorkspace } from "../route-testing.js";
import { testConfig } from "../testing.js";

/* The workspace routes, driven over the daemon's HTTP surface exactly as the browser drives them.
 * Split out of app.integration.test.ts, which had grown to 116 tests across every route in the daemon —
 * one file that two agents working on unrelated features collided in every time. The fakes and the client
 * are shared (route-testing.ts); what lives here is what these routes do. */

test("workspace.search runs the resident engine in-process, mapping the wire query to a QueryRequest", async () => {
    const requests: QueryRequest[] = [];
    const groups = [
        { path: "alpha/src/widget.ts", score: 1, hits: [{ line: 3, text: "export const createWidget", spans: [{ start: 13, end: 25 }], tags: [] }] },
    ];
    const client = clientFor(
        createApp(
            services({
                iq: {
                    run: async (request) => {
                        requests.push(request);
                        return {
                            result: { mode: request.verb, total: 1, files: 1, shown: 1, groups, freshness: { state: "fresh" }, truncated: false },
                            text: "",
                            exitCode: 0,
                        };
                    },
                    health: async () => ({
                        totals: { files: 0, symbols: 0, complexity: 0, hotspots: 0 },
                        hotspots: [],
                        modules: [],
                        freshness: { state: "fresh" },
                    }),
                    markDirty: () => {},
                    warm: async () => ({ files: 0, symbols: 0, chunks: 0, embedded: 0, generation: 0, freshness: { state: "fresh", ageMs: 0 } }),
                    close: async () => {},
                },
            }),
        ),
    );
    const result = await client.workspace.search({
        query: "createWidget",
        mode: "find",
        includeIgnored: "true",
        limit: 3,
        literal: "true",
        caseSensitive: "true",
    });
    expect(result.groups).toEqual(groups);
    // The search box's switches reach the engine as verb options, and the echo names them — it seeds the
    // pagination cursor, so two searches that differ only by a switch must not share one.
    expect(requests).toEqual([
        {
            verb: "find",
            query: "createWidget",
            scope: { ignored: true },
            render: { budget: 2_000, list: { hits: 1_000, files: 3 } },
            options: { literal: true, caseSensitive: true },
            echo: 'find "createWidget" --ignored --literal --case',
        },
    ]);
});

test("workspace.search asks for a LIST page, capped at the GUI file limit whatever the caller asks for", async () => {
    const requests: QueryRequest[] = [];
    const client = clientFor(
        createApp(
            services({
                iq: {
                    run: async (request) => {
                        requests.push(request);
                        return {
                            result: { mode: request.verb, total: 0, files: 0, shown: 0, groups: [], freshness: { state: "fresh" }, truncated: false },
                            text: "",
                            exitCode: 1,
                        };
                    },
                    health: async () => ({
                        totals: { files: 0, symbols: 0, complexity: 0, hotspots: 0 },
                        hotspots: [],
                        modules: [],
                        freshness: { state: "fresh" },
                    }),
                    markDirty: () => {},
                    warm: async () => ({ files: 0, symbols: 0, chunks: 0, embedded: 0, generation: 0, freshness: { state: "fresh", ageMs: 0 } }),
                    close: async () => {},
                },
            }),
        ),
    );
    await client.workspace.search({ query: "the", limit: 100_000 });
    // `list` is what tells the engine the caller renders its own rows: it sizes the page in rows and skips the
    // text capsule, the packed bodies, the symbol-context enrichment and the continuation spool.
    expect(requests[0]?.render).toEqual({ budget: 2_000, list: { hits: 1_000, files: 300 } });
});

test("workspace.health scopes the resident engine to one repo — 'root' is the workspace repo's empty scope", async () => {
    const requests: HealthRequest[] = [];
    const report = {
        totals: { files: 12, symbols: 40, complexity: 88, hotspots: 3 },
        hotspots: [{ path: "app/src/gate.ts", commits: 7, adds: 120, dels: 40, complexity: 19, score: 133, latestMs: 1_700_000_000_000 }],
        modules: [{ path: "app/src/widget.ts", exports: 4 }],
        freshness: { state: "fresh" as const },
    };
    const client = clientFor(
        createApp(
            services({
                workspace: tempWorkspace([{ name: "app" }]),
                iq: {
                    ...services().iq,
                    health: async (request) => {
                        requests.push(request);
                        return report;
                    },
                },
            }),
        ),
    );
    expect(await client.workspace.health({ repo: "root" })).toEqual({ repo: "root", ...report });
    await client.workspace.health({ repo: "app", since: "30d", limit: 5 });
    expect(requests).toEqual([
        // The sweep tags a workspace-root file with the empty repo id, so "root" narrows to exactly those files
        // — not to everything, which would fold every nested repo's churn into the root repo's report.
        { scope: { repo: "" }, limit: HEALTH_LIMIT },
        { scope: { repo: "app" }, since: "30d", limit: 5 },
    ]);
    // A report for a repo that isn't there would read as a healthy repo, so it is an error instead.
    expect(await errorCode(client.workspace.health({ repo: "ghost" }))).toBe("NOT_FOUND");
    expect(await errorCode(client.workspace.health({ repo: "../escape" }))).toBe("BAD_REQUEST");
});

test("user file mutations ping history for a user-authored snapshot", async () => {
    let pings = 0;
    const app = createApp(services({ history: fakeHistory({ notifyUserWrite: () => pings++ }) }));
    const client = clientFor(app);
    await client.workspace.mkdir({ path: "notes" });
    expect(pings).toBe(1);
    const uploaded = await app.request("/workspace/upload?path=notes/todo.txt", { method: "POST", body: "hi" });
    expect(uploaded.status).toBe(200);
    expect(pings).toBe(2);
});

test("workspace.tree returns the full working tree from the walker", async () => {
    const tree = { root: "/work", tree: [{ name: "app", path: "app", type: "dir" as const, children: [] }], hidden: 0 };
    const client = clientFor(createApp(services({ workspaceTree: async () => tree })));
    expect(await client.workspace.tree({})).toEqual(tree);
});

test("workspace.file reads any contained file (former-secret paths included), answers absent, BAD_REQUESTs escape", async () => {
    const client = clientFor(
        createApp(
            services({
                files: fakeFiles({
                    readWindow: async (absPath) => {
                        const content =
                            absPath === "/work/app/src/index.ts"
                                ? "console.log(1);"
                                : absPath === "/work/desired-state/.env"
                                  ? "SECRET=1"
                                  : undefined;
                        return content === undefined ? undefined : { content, size: content.length, offset: 0, bytes: content.length };
                    },
                }),
            }),
        ),
    );
    expect(await client.workspace.file({ path: "app/src/index.ts" })).toEqual({
        present: true,
        path: "app/src/index.ts",
        content: "console.log(1);",
        size: 15,
        offset: 0,
        bytes: 15,
        // No conversation named ⇒ the shared tree answered, which is what `shared` reports (workspace-scope.ts).
        shared: true,
    });
    // No security floor: a former-secret file reads through like any other contained file.
    expect(await client.workspace.file({ path: "desired-state/.env" })).toEqual({
        present: true,
        path: "desired-state/.env",
        content: "SECRET=1",
        size: 8,
        offset: 0,
        bytes: 8,
        shared: true,
    });
    // Nothing at that path is an ANSWER, not a failure — the reads that ask "is it there?" outnumber every other
    // read in the product, and a rejection put a failed request in the browser's console for each one.
    expect(await client.workspace.file({ path: "app/nope.ts" })).toEqual({ present: false, path: "app/nope.ts" });
    // A read the caller was never allowed to make still fails.
    expect(await errorCode(client.workspace.file({ path: "../../etc/passwd" }))).toBe("BAD_REQUEST");
});

// The window arguments reach the reader as numbers (they arrive as query strings), and the reader's answer —
// including where it actually landed — is what the response carries.
test("workspace.file passes the requested window through and reports the range it served", async () => {
    const asked: { offset?: number; limit?: number }[] = [];
    const client = clientFor(
        createApp(
            services({
                files: fakeFiles({
                    readWindow: async (_absPath, offset, limit) => {
                        asked.push({ ...(offset === undefined ? {} : { offset }), ...(limit === undefined ? {} : { limit }) });
                        return { content: "tail\n", size: 4096, offset: 4091, bytes: 5 };
                    },
                }),
            }),
        ),
    );
    expect(await client.workspace.file({ path: "big.log", offset: -8, limit: 64 })).toEqual({
        present: true,
        path: "big.log",
        content: "tail\n",
        size: 4096,
        offset: 4091,
        bytes: 5,
        shared: true,
    });
    expect(asked).toEqual([{ offset: -8, limit: 64 }]);
});

// Search is backed by the resident in-process iq engine. Round-trip against a REAL engine over a real tmp
// workspace (rg on PATH); the min-length rejection is contract validation and never reaches the engine.
test("workspace.search round-trips the WorkspaceSearchResult from the resident engine; rejects a too-short query", async () => {
    const root = await mkdtemp(join(tmpdir(), "iq-daemon-"));
    await writeFile(join(root, "notes.md"), "the needle is here\n");
    const iq = createResidentEngine({ root });
    try {
        const client = clientFor(createApp(services({ workspace: workspacePaths(root), iq })));
        const result = await client.workspace.search({ query: "needle" });
        expect(result.mode).toBe("q");
        expect(result.groups[0]?.path).toBe("notes.md");
        expect(result.truncated).toBe(false);
        const empty = await client.workspace.search({ query: "zzzqqqvvv" });
        expect(empty.total).toBe(0);
        expect(await errorCode(client.workspace.search({ query: "x" }))).toBe("BAD_REQUEST");
    } finally {
        await iq.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("GET /workspace/raw streams bytes with a content-type, 404s missing, 400s escape, 413s oversize", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const env = Buffer.from("SECRET=1");
    const app = createApp(
        services({
            files: fakeFiles({
                readBytes: async (absPath) => (absPath === "/work/app/logo.png" ? png : absPath === "/work/desired-state/.env" ? env : undefined),
                size: async (absPath) =>
                    absPath === "/work/app/logo.png"
                        ? png.byteLength
                        : absPath === "/work/app/huge.png"
                          ? MAX_RAW_BYTES + 1
                          : absPath === "/work/desired-state/.env"
                            ? env.byteLength
                            : undefined,
            }),
        }),
    );
    const ok = await app.request("/workspace/raw?path=app/logo.png");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await ok.arrayBuffer())).toEqual(new Uint8Array(png));
    // No security floor: a former-secret file now streams through like any other contained file.
    expect((await app.request("/workspace/raw?path=desired-state/.env")).status).toBe(200);
    // Oversize is refused on the size check, before the bytes are loaded.
    expect((await app.request("/workspace/raw?path=app/huge.png")).status).toBe(413);
    expect((await app.request("/workspace/raw?path=app/missing.png")).status).toBe(404);
    expect((await app.request("/workspace/raw?path=../../etc/passwd")).status).toBe(400);
});

/* /workspace/media against a REAL tmp file, because the thing under test is the byte window: the route streams
 * off disk with createReadStream rather than through services.files, so a fake would only be testing the fake. */
test("GET /workspace/media serves byte ranges off disk, and refuses one past the end", async () => {
    const root = await mkdtemp(join(tmpdir(), "media-"));
    const bytes = Buffer.from("0123456789");
    await writeFile(join(root, "clip.mp4"), bytes);
    // No `auth` ⇒ loopback mode, where the ticket gate passes through like the WebSocket upgrades' does. The
    // real `size` because the route pairs it with a real read: a faked size would describe a different file.
    const app = createApp(services({ workspace: workspacePaths(root), files: fakeFiles({ size: statWorkspaceFileSize }) }));
    try {
        const whole = await app.request("/workspace/media?path=clip.mp4");
        expect(whole.status).toBe(200);
        expect(whole.headers.get("content-type")).toBe("video/mp4");
        expect(whole.headers.get("accept-ranges")).toBe("bytes");
        expect(whole.headers.get("content-length")).toBe("10");
        expect(await whole.text()).toBe("0123456789");

        const middle = await app.request("/workspace/media?path=clip.mp4", { headers: { range: "bytes=2-4" } });
        expect(middle.status).toBe(206);
        expect(middle.headers.get("content-range")).toBe("bytes 2-4/10");
        expect(await middle.text()).toBe("234");

        // Open-ended: "from here to the end", the seek a scrubber drag issues.
        const tail = await app.request("/workspace/media?path=clip.mp4", { headers: { range: "bytes=7-" } });
        expect(tail.status).toBe(206);
        expect(tail.headers.get("content-range")).toBe("bytes 7-9/10");
        expect(await tail.text()).toBe("789");

        // Suffix: the last n bytes, which is how a player finds an MP4 index written after the media data.
        const suffix = await app.request("/workspace/media?path=clip.mp4", { headers: { range: "bytes=-3" } });
        expect(suffix.status).toBe(206);
        expect(suffix.headers.get("content-range")).toBe("bytes 7-9/10");

        const past = await app.request("/workspace/media?path=clip.mp4", { headers: { range: "bytes=99-" } });
        expect(past.status).toBe(416);
        expect(past.headers.get("content-range")).toBe("bytes */10");

        expect((await app.request("/workspace/media?path=missing.mp4")).status).toBe(404);
        expect((await app.request("/workspace/media?path=../../etc/passwd")).status).toBe(400);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("a media ticket opens only the path it was minted for, and /workspace/media refuses one that wasn't", async () => {
    const root = await mkdtemp(join(tmpdir(), "media-auth-"));
    await writeFile(join(root, "clip.mp4"), "video");
    await writeFile(join(root, "other.mp4"), "other");
    // WITH auth configured — the ticket gate only exists there; loopback has no identity to bind and no gate.
    const app = createApp(
        services({
            workspace: workspacePaths(root),
            files: fakeFiles({ size: statWorkspaceFileSize }),
            auth: { authorize: async () => ({ email: "o@x.com", role: "owner" as const }), authorizeOwner: async () => {}, allowOrigins: [] },
        }),
    );
    try {
        const { ticket } = await clientFor(app).workspace.mediaTicket({ path: "clip.mp4" });
        expect((await app.request(`/workspace/media?path=clip.mp4&ticket=${ticket}`)).status).toBe(200);
        // Replayable BY DESIGN — a playback redeems the same ticket for every range it asks for.
        expect((await app.request(`/workspace/media?path=clip.mp4&ticket=${ticket}`)).status).toBe(200);
        // …but only for its own file: the binding is what bounds a credential that lives in a URL.
        expect((await app.request(`/workspace/media?path=other.mp4&ticket=${ticket}`)).status).toBe(401);
        expect((await app.request("/workspace/media?path=clip.mp4")).status).toBe(401);
        // A mint for a file that isn't there fails at the mint, not as an opaque stall in the player.
        expect(await errorCode(clientFor(app).workspace.mediaTicket({ path: "missing.mp4" }))).toBe("NOT_FOUND");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("POST /workspace/upload streams any contained path to disk, 400s escape, 413s oversize", async () => {
    const writes: { path: string; content: Uint8Array }[] = [];
    const app = createApp(
        services({
            files: fakeFiles({
                writeStream: async (absPath, body) => {
                    writes.push({ path: absPath, content: new Uint8Array(await new Response(body).arrayBuffer()) });
                },
            }),
        }),
    );
    const body = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

    const ok = await app.request("/workspace/upload?path=app/assets/logo.png", { method: "POST", body });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe("/work/app/assets/logo.png");
    expect(writes[0]?.content).toEqual(body);

    // No WRITE floor: former-secret paths write through; only a climb-out is refused (400, no write).
    expect((await app.request("/workspace/upload?path=desired-state/.env", { method: "POST", body })).status).toBe(200);
    expect(writes.at(-1)?.path).toBe("/work/desired-state/.env");
    expect((await app.request("/workspace/upload?path=../../etc/passwd", { method: "POST", body })).status).toBe(400);
    expect(writes).toHaveLength(2);

    // `.git` writes through as well (a dropped repo keeps its remote).
    const git = await app.request("/workspace/upload?path=app/.git/config", { method: "POST", body });
    expect(git.status).toBe(200);
    expect(writes).toHaveLength(3);
    expect(writes[2]?.path).toBe("/work/app/.git/config");

    // A body past the cap surfaces as UploadTooLargeError from the streaming write → 413 (the write itself deletes
    // the partial; here the fake just throws). The declared-length short-circuit + real cap are unit-tested in
    // workspace-files.integration.test.ts / workspace-archive.integration.test.ts.
    const capped = createApp(
        services({
            files: fakeFiles({
                writeStream: async () => {
                    throw new UploadTooLargeError();
                },
            }),
        }),
    );
    expect((await capped.request("/workspace/upload?path=app/huge.bin", { method: "POST", body })).status).toBe(413);
});

test("the daemon's control plane is unreachable through the generic file API; its feature subtrees are not", async () => {
    const writes: string[] = [];
    const app = createApp(
        services({
            files: fakeFiles({
                writeStream: async (absPath) => {
                    writes.push(absPath);
                },
                size: async () => 4,
                readBytes: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
            }),
        }),
    );
    const body = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

    // owner.json/members.json ARE the answer to "who may drive this sandbox" (re-read from disk per request), and
    // the rest hold provider tokens, private conversations, or logged-in browser sessions — so a member could
    // otherwise take the sandbox or read/write private runtime state. Answered as if nothing were there, and
    // nothing is written.
    // The root's own .git joins them: it is the --separate-git-dir pointer to the shadow history repo on /history,
    // and a FILE, so a drop of a repo's CONTENTS at the root would aim a directory at it and 500 the whole upload.
    const controlPlane = [
        ".intentic/owner.json",
        ".intentic/members.json",
        ".intentic/capabilities.json",
        ".intentic/claude.json",
        ".intentic/auth/claude/acc.json",
        ".intentic/auth/codex/acc/auth.json",
        ".intentic/auth/opencode/auth.json",
        ".intentic/auth/cliproxy/kimi-user.json",
        ".intentic/auth/future-provider/token.json",
        ".intentic/sessions/claude/projects/-work/session.jsonl",
        ".intentic/browser/reddit/Default/Cookies",
        ".intentic/claude/retired-account.json",
        ".intentic/codex/retired-account/auth.json",
        ".intentic/kimi/retired-key.json",
        ".intentic/opencode/retired-auth.json",
        ".intentic/cliproxy/retired-auth.json",
        ".git",
        ".git/config",
        ".git/objects/ab/cdef",
    ];
    for (const path of controlPlane) {
        expect([path, (await app.request(`/workspace/upload?path=${path}`, { method: "POST", body })).status]).toEqual([path, 404]);
        expect([path, (await app.request(`/workspace/raw?path=${path}`)).status]).toEqual([path, 404]);
    }
    expect(writes).toHaveLength(0);

    // The root .intentic's other subtrees are ordinary workspace content driven through this very API — chat
    // attachments and a directory's own UI — and a repo's nested .intentic is not the control plane at all. Nor is
    // a NESTED .git: a dropped repo keeps its own and stays connected to its remote.
    const open = [".intentic/artifacts/attachments/u1/pic.png", ".intentic/ui/index.html", "app/.intentic/owner.json", "app/.git/config"];
    for (const path of open) {
        expect([path, (await app.request(`/workspace/upload?path=${path}`, { method: "POST", body })).status]).toEqual([path, 200]);
        expect([path, (await app.request(`/workspace/raw?path=${path}`)).status]).toEqual([path, 200]);
    }
    expect(writes).toEqual(open.map((path) => `/work/${path}`));
});

test("POST /workspace/upload with x-intentic-base-hash refuses a stale write and passes a matching one", async () => {
    const writes: string[] = [];
    const app = createApp(
        services({
            files: fakeFiles({
                read: async (absPath) => (absPath === "/work/app/index.ts" ? "hello" : undefined),
                writeStream: async (absPath) => {
                    writes.push(absPath);
                },
            }),
        }),
    );
    // sha256 of "hello", hardcoded to pin the wire algorithm (utf8 text → sha256 hex) the browser must speak.
    const match = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
    const ok = await app.request("/workspace/upload?path=app/index.ts", {
        method: "POST",
        body: "edited",
        headers: { "x-intentic-base-hash": match },
    });
    expect(ok.status).toBe(200);
    expect(writes).toEqual(["/work/app/index.ts"]);

    // The file changed since the browser read it (hash mismatch) → 409, nothing written — the guarded save must
    // never clobber a concurrent agent/terminal write.
    const stale = await app.request("/workspace/upload?path=app/index.ts", {
        method: "POST",
        body: "edited",
        headers: { "x-intentic-base-hash": sha256Text("agent rewrote this") },
    });
    expect(stale.status).toBe(409);
    // Deleted since it was read reads as the same conflict.
    const gone = await app.request("/workspace/upload?path=app/gone.ts", {
        method: "POST",
        body: "edited",
        headers: { "x-intentic-base-hash": match },
    });
    expect(gone.status).toBe(409);
    expect(writes).toHaveLength(1);

    // No hash = the unguarded path (drag-drop upload, new-file create): overwrites like before.
    expect((await app.request("/workspace/upload?path=app/index.ts", { method: "POST", body: "edited" })).status).toBe(200);
    expect(writes).toHaveLength(2);
});

test("POST /workspace/upload threads ?offset to the streaming write and rejects a bad offset", async () => {
    const writes: { path: string; offset: number | undefined }[] = [];
    const app = createApp(
        services({
            files: fakeFiles({
                writeStream: async (absPath, _body, _limit, offset) => {
                    writes.push({ path: absPath, offset });
                },
            }),
        }),
    );
    const body = new Uint8Array([1, 2, 3]);
    expect((await app.request("/workspace/upload?path=app/big.bin&offset=3", { method: "POST", body })).status).toBe(200);
    expect(writes).toEqual([{ path: "/work/app/big.bin", offset: 3 }]);
    expect((await app.request("/workspace/upload?path=app/big.bin&offset=-1", { method: "POST", body })).status).toBe(400);
    expect((await app.request("/workspace/upload?path=app/big.bin&offset=nope", { method: "POST", body })).status).toBe(400);
    expect(writes).toHaveLength(1);
});

test("workspace.mkdir/delete/move/copy resolve within /work and reject escapes", async () => {
    const calls: [string, ...string[]][] = [];
    const client = clientFor(
        createApp(
            services({
                files: fakeFiles({
                    mkdir: async (p) => {
                        calls.push(["mkdir", p]);
                    },
                    remove: async (p) => {
                        calls.push(["remove", p]);
                    },
                    move: async (a, b) => {
                        calls.push(["move", a, b]);
                    },
                    copy: async (a, b) => {
                        calls.push(["copy", a, b]);
                    },
                }),
            }),
        ),
    );

    expect(await client.workspace.mkdir({ path: "app/new-dir" })).toEqual({ ok: true });
    expect(await client.workspace.delete({ path: "app/old.ts" })).toEqual({ ok: true });
    expect(await client.workspace.move({ from: "app/a.ts", to: "app/b.ts" })).toEqual({ ok: true });
    expect(await client.workspace.copy({ from: "app/a.ts", to: "app/nested/c.ts" })).toEqual({ ok: true });
    expect(calls).toEqual([
        ["mkdir", "/work/app/new-dir"],
        ["remove", "/work/app/old.ts"],
        ["move", "/work/app/a.ts", "/work/app/b.ts"],
        ["copy", "/work/app/a.ts", "/work/app/nested/c.ts"],
    ]);

    // No security floor: former-secret paths now resolve and act like any other contained path.
    expect(await client.workspace.delete({ path: "desired-state/.env" })).toEqual({ ok: true });
    expect(calls.at(-1)).toEqual(["remove", "/work/desired-state/.env"]);

    // Only a climb-out of /work is refused now (BAD_REQUEST), on either endpoint, before the fs is touched.
    expect(await errorCode(client.workspace.mkdir({ path: "../evil" }))).toBe("BAD_REQUEST");
    expect(await errorCode(client.workspace.move({ from: "app/a.ts", to: "../escape" }))).toBe("BAD_REQUEST");
    expect(calls).toHaveLength(5);
});

test("workspace.addRepo clones a repo with a protected git dir, rejects reserved names + a bad body", async () => {
    const clones: { parentDir: string; name: string; cloneUrl: string; separateGitDir?: string }[] = [];
    const ensured: string[] = [];
    const client = clientFor(
        createApp(
            services({
                git: {
                    status: async () => ({ branch: "main", dirty: false, files: [] }),
                    listFiles: async () => [],
                    commitAll: async () => false,
                    clone: async (parentDir, name, cloneUrl, options) => {
                        clones.push({
                            parentDir,
                            name,
                            cloneUrl,
                            ...(options?.separateGitDir !== undefined ? { separateGitDir: options.separateGitDir } : {}),
                        });
                    },
                },
                ensurePreviewRoutes: async (labels) => {
                    ensured.push(...labels);
                },
            }),
        ),
    );
    expect(await client.workspace.addRepo({ name: "extra", cloneUrl: "https://example.com/extra.git" })).toEqual({ name: "extra", path: "extra" });
    expect(clones).toEqual([
        {
            parentDir: "/work",
            name: "extra",
            cloneUrl: "https://example.com/extra.git",
            separateGitDir: join(testConfig.historyRoot, "gits", "extra"),
        },
    ]);
    // The preview route is minted at clone time, not first panel start (DNS negative-caching).
    expect(ensured).toEqual(["preview-extra"]);
    // A reserved role (one of the three fixed repos) cannot be clobbered, and a path-escape name is rejected.
    expect(await errorCode(client.workspace.addRepo({ name: "intent", cloneUrl: "https://example.com/x.git" }))).toBe("BAD_REQUEST");
    expect(await errorCode(client.workspace.addRepo({ name: "../evil", cloneUrl: "https://example.com/x.git" }))).toBe("BAD_REQUEST");
    expect(clones).toHaveLength(1);
});

test("workspace.addApps launches `intentic scaffold add-app` as a one-shot tmux job and mints each app's preview route up front", async () => {
    const workspace = tempWorkspace([{ name: "shop" }]);
    const repoDir = join(workspace.root, "shop");
    const jobs: { key: string; spec: ProcessSpec }[] = [];
    const ensured: string[] = [];
    const processes = unstubbed<ManagedProcesses>("processes", {
        start: async (key, spec) => {
            jobs.push({ key, spec });
        },
        stop: () => {},
        running: () => false,
        portOf: () => undefined,
        stopAll: () => {},
    });
    const client = clientFor(
        createApp(
            services({
                workspace,
                processes,
                ensurePreviewRoutes: async (labels) => {
                    ensured.push(...labels);
                },
            }),
        ),
    );

    expect(
        await client.workspace.addApps({
            repo: "shop",
            apps: [
                { template: "api", name: "api" },
                { template: "web", name: "shop-web" },
            ],
        }),
    ).toEqual({ ok: true });
    // One detached one-shot job, keyed <repo>--add_apps (underscore ⇒ never collides with an app panel key
    // <repo>--<app>), running the CLI over the same @intentic/scaffold path — each arg shell-quoted, and the
    // template-key entry (api) collapses to a bare key while the renamed one (shop-web) keeps template:name.
    expect(jobs).toEqual([
        {
            key: "shop--add_apps",
            spec: {
                command: `intentic scaffold add-app --dir ${shellQuote(repoDir)} --apps ${shellQuote("api,web:shop-web")} --source ${shellQuote(DEFAULT_TEMPLATE_SOURCE)} --ref ${shellQuote(DEFAULT_TEMPLATE_REF)}`,
                cwd: repoDir,
                oneShot: true,
            },
        },
    ]);
    // Preview routes are minted before the job runs (hostnames must predate the first browser lookup).
    expect(ensured).toEqual(["preview-shop--api", "preview-shop--shop-web"]);
    // An unknown monorepo is NOT_FOUND (before any job is launched).
    expect(await errorCode(client.workspace.addApps({ repo: "ghost", apps: [{ template: "api", name: "api" }] }))).toBe("NOT_FOUND");
    expect(jobs).toHaveLength(1);
});

// The binary side of a diff, which the JSON file-diff routes can only FLAG. Two things are load-bearing and
// neither is visible from the JSON side: the blob comes back as BYTES (a utf8 decode would replace every byte
// above 0x7f, which is most of a PNG), and the rev-spec pair matches the row the reviewer clicked.
test("GET /diff/raw streams a diff side's bytes: blob for the index side, disk for the worktree side", async () => {
    const root = await mkdtemp(join(tmpdir(), "intentic-diff-raw-"));
    const git = (...args: string[]): Promise<unknown> =>
        promisify(execFile)("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-C", root, ...args]);
    // Bytes git cannot round-trip as text: a NUL, a lone 0x80 (invalid utf8 on its own), and 0xff.
    const committed = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x80, 0xff]);
    const edited = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x81, 0xfe, 0x01]);
    try {
        await git("init", "-q");
        await writeFile(join(root, "logo.png"), committed);
        await git("add", "-A");
        await git("commit", "-q", "-m", "init");
        await writeFile(join(root, "logo.png"), edited);

        const app = createApp(
            services({
                workspace: workspacePaths(root),
                // The worktree side reads through the same file service /workspace/raw uses.
                files: fakeFiles({
                    readBytes: async (absPath) => (absPath === join(root, "logo.png") ? edited : undefined),
                    size: async (absPath) => (absPath === join(root, "logo.png") ? edited.byteLength : undefined),
                }),
            }),
        );
        const raw = async (query: string): Promise<Response> => app.request(`/diff/raw?source=working&repo=root&path=logo.png&${query}`);

        // Unstaged: before is the index blob, after is the file on disk — the same pair unstagedFileDiff reads.
        const before = await raw("side=unstaged&which=before");
        expect(before.status).toBe(200);
        expect(before.headers.get("content-type")).toBe("image/png");
        expect(new Uint8Array(await before.arrayBuffer())).toEqual(new Uint8Array(committed));
        expect(new Uint8Array(await (await raw("side=unstaged&which=after")).arrayBuffer())).toEqual(new Uint8Array(edited));

        // Staged: nothing has been staged, so the index still holds the committed blob on BOTH sides — which is
        // exactly what a staged row would diff (HEAD↔index), and not what the unstaged row above showed.
        expect(new Uint8Array(await (await raw("side=staged&which=after")).arrayBuffer())).toEqual(new Uint8Array(committed));

        // A side the file never had (this path is in no commit) is a 404, not an empty body a browser would
        // render as a corrupt image.
        expect((await app.request("/diff/raw?source=working&repo=root&path=fresh.png&side=unstaged&which=before")).status).toBe(404);
        // The guards every file surface here applies, plus the two this route adds of its own.
        expect((await raw("side=unstaged&which=sideways")).status).toBe(400);
        expect((await raw("side=nonsense&which=before")).status).toBe(400);
        expect((await app.request("/diff/raw?source=nonsense&repo=root&path=logo.png&which=before")).status).toBe(400);
        expect((await app.request("/diff/raw?source=working&repo=root&path=../../etc/passwd&side=unstaged&which=after")).status).toBe(400);
        expect((await app.request("/diff/raw?source=working&repo=nope&path=logo.png&side=unstaged&which=before")).status).toBe(404);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

// A commit's own two sides, from the graph. The sha is the one identifier that reaches git's rev-spec parser
// from the wire, so it is held to the contract's sha shape before it gets there.
test("GET /diff/raw serves a commit's before/after blobs and refuses a sha that isn't one", async () => {
    const root = await mkdtemp(join(tmpdir(), "intentic-diff-raw-commit-"));
    const git = (...args: string[]): Promise<{ stdout: string }> =>
        promisify(execFile)("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-C", root, ...args]);
    const first = Buffer.from([0x00, 0x80, 0x01]);
    const second = Buffer.from([0x00, 0xff, 0x02, 0x03]);
    try {
        await git("init", "-q");
        await writeFile(join(root, "icon.png"), first);
        await git("add", "-A");
        await git("commit", "-q", "-m", "one");
        await writeFile(join(root, "icon.png"), second);
        await git("add", "-A");
        await git("commit", "-q", "-m", "two");
        const sha = (await git("rev-parse", "HEAD")).stdout.trim();

        const app = createApp(services({ workspace: workspacePaths(root) }));
        const raw = async (which: string): Promise<Response> =>
            app.request(`/diff/raw?source=commit&repo=root&sha=${sha}&path=icon.png&which=${which}`);
        expect(new Uint8Array(await (await raw("before")).arrayBuffer())).toEqual(new Uint8Array(first));
        expect(new Uint8Array(await (await raw("after")).arrayBuffer())).toEqual(new Uint8Array(second));
        expect((await app.request(`/diff/raw?source=commit&repo=root&sha=HEAD~1&path=icon.png&which=after`)).status).toBe(400);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
