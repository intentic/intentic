import type { Hono } from "hono";
import { expect, test } from "vitest";

import { ATTACHMENTS_DIR, type MemberRole } from "@intentic/sandbox-contract";
import { createApp } from "../app.js";
import type { AppEnv } from "../app-env.js";
import { services } from "../harness/route-services.testing.js";
import { rejectForbidden } from "../harness/route-client.testing.js";

/* WHAT AN INVITED MEMBER CAN ACTUALLY DO, driven over the daemon's HTTP surface at each granted tier.
 *
 * role-floor.test.ts asserts the TABLE; this asserts the SURFACE the browser drives, which is where the two
 * drifted apart: the editor's file explorer writes bytes through /workspace/upload and everything else through
 * the oRPC workspace routes, so a tier that has one and not the other can create a file it then cannot rename,
 * move or delete. That asymmetry is what a member meets first, so it is pinned here per-tier rather than
 * inferred from the floors. */

const appAs = (role: MemberRole): Hono<AppEnv> =>
    createApp(
        services({
            auth: { authorize: async () => ({ email: `member@example.com`, role }), authorizeOwner: rejectForbidden },
        }),
    );

const bearer = { authorization: `Bearer member` };

// The status of one call made as `role`, over the same routes the browser uses.
const statusAs = async (role: MemberRole, method: string, path: string, body?: unknown): Promise<number> => {
    const app = appAs(role);
    // A GET carries no body, whatever the caller passed: fetch rejects the request outright rather than the app
    // answering it, which would read here as a route that could not be reached at all.
    const init: RequestInit =
        body === undefined || method === `GET` || method === `HEAD`
            ? { method, headers: bearer }
            : { method, headers: { ...bearer, "content-type": `application/json` }, body: JSON.stringify(body) };
    return (await app.request(path, init)).status;
};

// The whole file surface a member meets in the explorer, in the order the explorer offers it.
const fileActions = (path: string): readonly { readonly name: string; readonly method: string; readonly url: string; readonly body?: unknown }[] => [
    { name: `read tree`, method: `GET`, url: `/workspace/tree` },
    { name: `create/overwrite file`, method: `POST`, url: `/workspace/upload?path=${path}` },
    { name: `create folder`, method: `POST`, url: `/workspace/dir`, body: { path: `notes` } },
    { name: `rename/move`, method: `POST`, url: `/workspace/move`, body: { from: path, to: `renamed.txt` } },
    { name: `copy`, method: `POST`, url: `/workspace/copy`, body: { from: path, to: `copy.txt` } },
    { name: `delete`, method: `DELETE`, url: `/workspace/entry`, body: { path } },
];

const surfaceFor = async (role: MemberRole): Promise<Record<string, number>> => {
    const out: Record<string, number> = {};
    for (const action of fileActions(`scratch.txt`)) {
        out[action.name] = await statusAs(role, action.method, action.url, action.body);
    }
    return out;
};

test("a collaborator's file surface is coherent: what it can create it can also remove", async () => {
    const collaborator = await surfaceFor(`collaborator`);
    // Reading the tree is the viewer grant and stays open.
    expect(collaborator[`read tree`]).toBe(200);
    // Every WRITE to the shared workspace answers the same way. The bug this pins: `create/overwrite file` used
    // to be 200 (the /workspace/upload path floor) while every sibling was 403, so a member could drop a file
    // into the shared tree and then find delete, rename, move and copy all refused on the file they just made.
    const writes = [`create/overwrite file`, `create folder`, `rename/move`, `copy`, `delete`];
    const answers = new Set(writes.map((name) => collaborator[name]));
    expect([...answers]).toEqual([403]);
});

test("a viewer may read the tree and change nothing in it", async () => {
    const viewer = await surfaceFor(`viewer`);
    expect(viewer[`read tree`]).toBe(200);
    for (const [name, status] of Object.entries(viewer)) {
        if (name !== `read tree`) {
            expect(status, name).toBe(403);
        }
    }
});

test("a maintainer holds the whole file surface", async () => {
    const maintainer = await surfaceFor(`maintainer`);
    for (const [name, status] of Object.entries(maintainer)) {
        expect(status, name).not.toBe(403);
    }
});

test("the bulk upload routes carry the same floor as the single-file write", async () => {
    // upload-diff and upload-archive are the same act as upload (bytes into the shared tree) and must not be
    // reachable at a different tier than it: an unlisted mutation defaults to maintainer, so the three agreeing
    // is what keeps a member from finding one door open and two shut.
    for (const url of [`/workspace/upload?path=a.txt`, `/workspace/upload-diff`, `/workspace/upload-archive`]) {
        expect(await statusAs(`collaborator`, `POST`, url, {}), url).toBe(403);
    }
});

test("chat attachments stay reachable for the tier that drives agents", async () => {
    // The collaborator grant is driving agents, and an attachment is part of a message: it is the one write
    // that has to survive the floor above, so it is pinned by the ADDRESS it lands at rather than by the route.
    const attachment = `${ATTACHMENTS_DIR}/${`u1`}/note.txt`;
    expect(await statusAs(`collaborator`, `POST`, `/workspace/upload?path=${encodeURIComponent(attachment)}`)).not.toBe(403);
    // A viewer sends no messages, so it carries no attachments either.
    expect(await statusAs(`viewer`, `POST`, `/workspace/upload?path=${encodeURIComponent(attachment)}`)).toBe(403);
});

/* THE CO-WORKING SURFACE AS A WHOLE, one row per thing an invited member comes to a shared sandbox to do, and
 * the lowest tier that may do it. Statuses are read as permission only (403 or not): whether a route then 404s
 * on a conversation that does not exist in this harness is that route's business, not this table's.
 *
 * Kept as one table because the tiers only mean anything TOGETHER: "a viewer may watch" is a claim about the
 * viewer row and about the absence of the viewer from every row below it. */
const SURFACE: readonly { readonly does: string; readonly method: string; readonly url: string; readonly needs: MemberRole }[] = [
    // Watching. All of it is reading, POST or not.
    { does: `list the conversations`, method: `GET`, url: `/agents`, needs: `viewer` },
    { does: `read a file`, method: `GET`, url: `/workspace/file?path=README.md`, needs: `viewer` },
    { does: `watch a live turn`, method: `POST`, url: `/agent/attach`, needs: `viewer` },
    { does: `appear on the roster`, method: `POST`, url: `/system/presence`, needs: `viewer` },
    { does: `give up their own access`, method: `DELETE`, url: `/members/self`, needs: `viewer` },
    // Driving agents: the collaborator's whole grant.
    { does: `start a turn`, method: `POST`, url: `/agent`, needs: `collaborator` },
    { does: `steer a running turn`, method: `POST`, url: `/agent/steer`, needs: `collaborator` },
    { does: `rename a conversation`, method: `POST`, url: `/agents/abc/rename`, needs: `collaborator` },
    { does: `ask for a landing`, method: `POST`, url: `/agents/abc/request-land`, needs: `collaborator` },
    // Operating the box: what leaves the sandbox, what it can reach, and what it costs.
    { does: `land work into the tree`, method: `POST`, url: `/agents/abc/land`, needs: `maintainer` },
    { does: `discard a conversation`, method: `POST`, url: `/agents/abc/discard`, needs: `maintainer` },
    { does: `read the secrets list`, method: `GET`, url: `/secrets`, needs: `maintainer` },
    { does: `read what this box can reach`, method: `GET`, url: `/capabilities`, needs: `maintainer` },
    { does: `read the spend`, method: `GET`, url: `/system/usage`, needs: `maintainer` },
    { does: `read the daemon's logs`, method: `GET`, url: `/logs`, needs: `maintainer` },
    { does: `edit the shared workspace`, method: `POST`, url: `/workspace/move`, needs: `maintainer` },
];

const TIERS: readonly MemberRole[] = [`viewer`, `collaborator`, `maintainer`];
const rank = (role: MemberRole): number => TIERS.indexOf(role);

test("every co-working act answers at its own tier, and at none below it", async () => {
    for (const row of SURFACE) {
        for (const tier of TIERS) {
            const status = await statusAs(tier, row.method, row.url, {});
            const allowed = rank(tier) >= rank(row.needs);
            // `not.toBe(403)` rather than `toBe(200)`: admission is the question here.
            if (allowed) {
                expect(status, `${tier} should be able to ${row.does}`).not.toBe(403);
            } else {
                expect(status, `${tier} should not be able to ${row.does}`).toBe(403);
            }
        }
    }
});

test("the attachment carve-out cannot be walked out of", async () => {
    // The floor reads a client-supplied query, so it normalizes before matching: a path that merely STARTS with
    // the attachments dir and then climbs out of it lands in the workspace proper and is refused there. Without
    // the normalize, this is a collaborator writing any file in the tree through the attachment door.
    const escape = `${ATTACHMENTS_DIR}/u1/../../../../../hooks/lint-edit.mjs`;
    expect(await statusAs(`collaborator`, `POST`, `/workspace/upload?path=${encodeURIComponent(escape)}`)).toBe(403);
});
