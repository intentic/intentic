import type { Hono } from "hono";
import { expect, test } from "vitest";

import { ATTACHMENTS_DIR, type MemberRole } from "@intentic/sandbox-contract";
import { createApp } from "../app.js";
import type { AppEnv } from "../app-env.js";
import { services } from "../harness/route-services.testing.js";
import { rejectForbidden } from "../harness/route-client.testing.js";

// role-floor.test.ts asserts the table; this asserts the surface the browser drives, where the two can drift apart.
// An editor's explorer writes through /workspace/upload but everything else through oRPC, so a tier missing one route
// can create a file it can't then rename or delete.

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
    // A GET carries no body regardless: fetch rejects the request outright, reading as an unreachable route.
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
    // Every write must answer the same way, or a member's own file gets refused on rename or delete afterward.
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
    // upload-diff/upload-archive are the same act as upload and must share its floor, not open one door, shut two.
    for (const url of [`/workspace/upload?path=a.txt`, `/workspace/upload-diff`, `/workspace/upload-archive`]) {
        expect(await statusAs(`collaborator`, `POST`, url, {}), url).toBe(403);
    }
});

test("chat attachments stay reachable for the tier that drives agents", async () => {
    // An attachment is part of a message, the write that must survive the floor above; pinned by address.
    const attachment = `${ATTACHMENTS_DIR}/${`u1`}/note.txt`;
    expect(await statusAs(`collaborator`, `POST`, `/workspace/upload?path=${encodeURIComponent(attachment)}`)).not.toBe(403);
    // A viewer sends no messages, so it carries no attachments either.
    expect(await statusAs(`viewer`, `POST`, `/workspace/upload?path=${encodeURIComponent(attachment)}`)).toBe(403);
});

// The co-working surface as a whole: one row per thing an invited member comes to do, and the lowest tier that may do
// it. Statuses are read as permission only.
// Kept as one table since the tiers only mean anything together: "a viewer may watch" is also a claim about every row
// below it.
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
    // The floor normalizes a client-supplied path before matching: one that starts under the attachments dir but climbs
    // out lands in the workspace proper.
    // Without that, this is a collaborator writing any file in the tree through the attachment door.
    const escape = `${ATTACHMENTS_DIR}/u1/../../../../../hooks/lint-edit.mjs`;
    expect(await statusAs(`collaborator`, `POST`, `/workspace/upload?path=${encodeURIComponent(escape)}`)).toBe(403);
});
