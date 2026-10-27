import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Member } from "../auth.js";
import {
    filePreviewGuardStore,
    filePreviewPassKey,
    opensPreviews,
    passCookie,
    PREVIEW_PASS_COOKIE,
    PREVIEW_PASS_PATH,
    PREVIEW_PASS_TTL_SECONDS,
    signPass,
} from "./preview-guard.js";
import { memoryPreviewGuards, memoryPreviewGuardStore, memoryPreviewPassKey, TEST_SANDBOX_ID, TEST_ZONE } from "./preview-guard.testing.js";
import { answerPreview, type PreviewDeps } from "../../panels/preview-routes.js";

// The owner's guard on previews, the daemon's half: who gets a pass, how it is signed, what netd is told, and the two
// requests netd hands back for it (the exchange, and a navigation with no pass). netd's half, checking a pass on every
// request, is _sandbox/netd's (guard.rs, tests/routes.rs).

const panel = `preview-web-${TEST_SANDBOX_ID}.${TEST_ZONE}`;
const port = `port-s4lt-${TEST_SANDBOX_ID}.${TEST_ZONE}`;
const outbox = `public-s4lt-${TEST_SANDBOX_ID}.${TEST_ZONE}`;

describe("a pass", () => {
    test("is signed as netd checks it, the same vector its own test holds", () => {
        // _sandbox/netd/crates/netd/src/guard.rs `the_signature_is_unpadded_base64url_hmac_sha256`.
        expect(signPass("the-key", 1_800_000_600)).toBe("v1.1800000600.zbHcT57NxCUGoNelaFg8Dixw68sRHEsWoNaSeobR2AI");
    });

    test("rides in a host-only, script-proof, partitioned cookie", () => {
        const cookie = passCookie("v1.1.x");
        expect(cookie.startsWith(`${PREVIEW_PASS_COOKIE}=v1.1.x;`)).toBe(true);
        for (const attribute of ["Path=/", `Max-Age=${String(PREVIEW_PASS_TTL_SECONDS)}`, "Secure", "HttpOnly", "SameSite=None", "Partitioned"]) {
            expect(cookie).toContain(`; ${attribute}`);
        }
        // `__Host-` refuses a Domain: no preview on another host, and no other sandbox, can set or receive it.
        expect(cookie).not.toContain("Domain=");
    });

    test("is good for the pass's lifetime from now, under the current key", async () => {
        const guards = memoryPreviewGuards({ now: () => 1_000_000_000_000 });
        expect(await guards.pass()).toBe(signPass("test-preview-pass-key", 1_000_000_000 + PREVIEW_PASS_TTL_SECONDS));
    });
});

describe("what netd is told", () => {
    test("nothing while the guard is off, and the hosts the owner chose once it is on", async () => {
        const guards = memoryPreviewGuards();
        expect(await guards.forNetd()).toBeUndefined();
        await guards.set("panels");
        expect(await guards.forNetd()).toEqual({
            panels: true,
            ports: false,
            cookie: PREVIEW_PASS_COOKIE,
            key: "test-preview-pass-key",
            passPath: PREVIEW_PASS_PATH,
        });
        await guards.set("all");
        expect((await guards.forNetd())?.ports).toBe(true);
    });

    test("a scope that cannot be read guards everything, never nothing", async () => {
        const guards = memoryPreviewGuards({
            store: {
                scope: () => Promise.reject(new Error("unreadable")),
                setScope: async () => undefined,
            },
        });
        expect(await guards.forNetd()).toMatchObject({ panels: true, ports: true });
    });

    test("a change to the scope is heard, so netd is told at once", async () => {
        const guards = memoryPreviewGuards();
        let heard = 0;
        guards.onChange(() => {
            heard += 1;
        });
        await guards.set("panels");
        expect(heard).toBe(1);
    });
});

describe("which addresses a ticket is ever minted for", () => {
    const guards = memoryPreviewGuards();
    test("only this sandbox's own preview names, over HTTPS, in its zone", () => {
        expect(guards.kindOf(new URL(`https://${panel}/a?b=1`))).toBe("panel");
        expect(guards.kindOf(new URL(`https://${port}/`))).toBe("port");
        expect(guards.kindOf(new URL(`https://${outbox}/`))).toBe("outbox");
        for (const foreign of [
            `http://${panel}/`,
            `https://${panel}:8443/`,
            `https://preview-web-${TEST_SANDBOX_ID}.evil.example/`,
            `https://preview-web-${TEST_SANDBOX_ID}.evil.${TEST_ZONE}/`,
            `https://preview-web-0123456789ab.${TEST_ZONE}/`,
            `https://sandbox-${TEST_SANDBOX_ID}.${TEST_ZONE}/`,
        ]) {
            expect(guards.kindOf(new URL(foreign))).toBeUndefined();
        }
    });

    test("none at all for a sandbox with no public names", () => {
        expect(memoryPreviewGuards({ zone: undefined }).kindOf(new URL(`https://${panel}/`))).toBeUndefined();
    });

    test("covered as the owner chose; the outbox never", async () => {
        const store = memoryPreviewGuardStore("panels");
        const chosen = memoryPreviewGuards({ store });
        expect([await chosen.covers("panel"), await chosen.covers("port"), await chosen.covers("outbox")]).toEqual([true, false, false]);
        await store.setScope("all");
        expect([await chosen.covers("panel"), await chosen.covers("port"), await chosen.covers("outbox")]).toEqual([true, true, false]);
    });
});

describe("a ticket", () => {
    test("redeems once, on the host it was minted for, within its minute", () => {
        let now = 0;
        const guards = memoryPreviewGuards({ now: () => now });
        const once = guards.ticket("Ada@Example.com", panel);
        expect(guards.redeem(once, panel.toUpperCase())).toBe("ada@example.com");
        expect(guards.redeem(once, panel)).toBeUndefined();
        const elsewhere = guards.ticket("ada@example.com", panel);
        expect(guards.redeem(elsewhere, port)).toBeUndefined();
        // Spent by the wrong host as well: a ticket that reached the wrong place is burnt.
        expect(guards.redeem(elsewhere, panel)).toBeUndefined();
        const late = guards.ticket("ada@example.com", panel);
        now = 60_001;
        expect(guards.redeem(late, panel)).toBeUndefined();
    });
});

describe("ending passes", () => {
    test("a change that keeps someone able to open previews ends only their tickets", async () => {
        const guards = memoryPreviewGuards({ mayPass: async () => true });
        const before = await guards.forNetd();
        const ticket = guards.ticket("ada@example.com", panel);
        await guards.revoked("ada@example.com");
        expect(guards.redeem(ticket, panel)).toBeUndefined();
        expect(await guards.forNetd()).toEqual(before);
    });

    test("losing access, or signing everyone out, replaces the key and is heard", async () => {
        for (const [who, mayPass] of [
            ["gone@example.com", false],
            [undefined, true],
        ] as const) {
            const key = memoryPreviewPassKey();
            const guards = memoryPreviewGuards({ key, mayPass: async () => mayPass, store: memoryPreviewGuardStore("panels") });
            let heard = 0;
            guards.onChange(() => {
                heard += 1;
            });
            const before = await key.read();
            await guards.revoked(who);
            expect(await key.read()).not.toBe(before);
            expect(heard).toBe(1);
        }
    });

    test("who may hold a pass: the owner and anyone on the roster above a guest", async () => {
        const roster: Member[] = [
            { email: "viewer@example.com", role: "viewer" },
            { email: "guest@example.com", role: "guest", areas: [] },
        ];
        const may = opensPreviews(async () => "Owner@Example.com", { list: async () => roster });
        expect(await may("owner@example.com")).toBe(true);
        expect(await may("VIEWER@example.com")).toBe(true);
        expect(await may("guest@example.com")).toBe(false);
        expect(await may("stranger@example.com")).toBe(false);
    });
});

describe("on disk", () => {
    const dirs: string[] = [];
    afterAll(() => {
        for (const dir of dirs) {
            rmSync(dir, { recursive: true, force: true });
        }
    });
    const dir = (): string => {
        const made = mkdtempSync(join(tmpdir(), "preview-guard-"));
        dirs.push(made);
        return made;
    };

    test("the scope is off until the owner chooses, and kept once chosen", async () => {
        const path = join(dir(), "preview-guard.json");
        expect(await filePreviewGuardStore(path).scope()).toBe("off");
        await filePreviewGuardStore(path).setScope("all");
        expect(await filePreviewGuardStore(path).scope()).toBe("all");
    });

    test("a scope file this build cannot read is refused, not read as off", async () => {
        const path = join(dir(), "preview-guard.json");
        writeFileSync(path, "{ not json");
        await expect(filePreviewGuardStore(path).scope()).rejects.toThrow("unreadable");
    });

    test("the key is minted once, kept across restarts, and replaced whole", async () => {
        const path = join(dir(), "preview-pass.key");
        const first = await filePreviewPassKey(path).read();
        expect(first).toMatch(/^[\w-]{43}$/);
        expect(await filePreviewPassKey(path).read()).toBe(first);
        const key = filePreviewPassKey(path);
        await key.rotate();
        const rotated = await key.read();
        expect(rotated).not.toBe(first);
        expect(await filePreviewPassKey(path).read()).toBe(rotated);
    });
});

describe("what netd hands back for the guard", () => {
    const servers: http.Server[] = [];
    afterAll(async () => {
        await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
    });

    const guards = memoryPreviewGuards({ now: () => 1_000_000_000_000 });
    const deps: PreviewDeps = {
        panelOf: async () => ({ state: "stopped" }),
        slotTargetOf: () => undefined,
        sandboxId: TEST_SANDBOX_ID,
        guard: { guards, editorOrigin: "https://app.example.test" },
    };

    const handBack = async (mark: string, path: string, host = panel): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> => {
        const server = http.createServer((request, response) => void answerPreview(request, response, deps));
        servers.push(server);
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        // SAFETY: a server listening on a TCP port reports an AddressInfo, never a pipe's name.
        const { port: at } = server.address() as AddressInfo;
        return new Promise((resolve, reject) => {
            const request = http.request({ host: "127.0.0.1", port: at, path, headers: { host, "x-intentic-preview": mark } }, (response) => {
                let body = "";
                response.on("data", (chunk: Buffer) => {
                    body += chunk.toString();
                });
                response.on("end", () => resolve({ status: response.statusCode ?? 0, body, headers: response.headers }));
            });
            request.on("error", reject);
            request.end();
        });
    };

    test("the exchange turns a ticket into the pass and lands where it was asked to", async () => {
        const ticket = guards.ticket("ada@example.com", panel);
        const answer = await handBack("pass", `${PREVIEW_PASS_PATH}?ticket=${ticket}&to=${encodeURIComponent("/app?x=1")}`);
        expect(answer.status).toBe(302);
        expect(answer.headers.location).toBe("/app?x=1");
        expect(answer.headers["set-cookie"]).toEqual([passCookie(await guards.pass())]);
        expect(answer.headers["cache-control"]).toBe("no-store");
        // Spent: the same link a second time is the expired page.
        const again = await handBack("pass", `${PREVIEW_PASS_PATH}?ticket=${ticket}&to=%2F`);
        expect(again.status).toBe(401);
        expect(again.body).toContain("This sign-in link has expired");
        expect(again.headers["set-cookie"]).toBeUndefined();
    });

    test("the exchange never lands on another host, nor back on itself", async () => {
        for (const to of ["//evil.example/x", "/\\evil.example", "https://evil.example/", `${PREVIEW_PASS_PATH}?ticket=x`, "app"]) {
            const ticket = guards.ticket("ada@example.com", panel);
            const answer = await handBack("pass", `${PREVIEW_PASS_PATH}?ticket=${ticket}&to=${encodeURIComponent(to)}`);
            expect(answer.headers.location).toBe("/");
        }
    });

    test("a navigation with no pass is told whose preview it is and offered the way back through the editor", async () => {
        const answer = await handBack("signin", "/dashboard?tab=2");
        expect(answer.status).toBe(401);
        expect(answer.headers["cache-control"]).toBe("no-store");
        expect(answer.body).toContain("This preview is for the sandbox's members");
        const back = `https://${panel}/dashboard?tab=2`;
        expect(answer.body).toContain(`href="https://app.example.test/preview-pass?url=${encodeURIComponent(back)}"`.replaceAll("&", "&amp;"));
        // In the editor's own frame the page asks the editor for a pass instead of waiting for a press.
        expect(answer.body).toContain(`postMessage({intentic:"preview-pass",href:location.href},"*")`);
    });

    test("without a guard the marks are not this side's to honour", async () => {
        const server = http.createServer((request, response) => void answerPreview(request, response, { ...deps, guard: undefined }));
        servers.push(server);
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        // SAFETY: a server listening on a TCP port reports an AddressInfo, never a pipe's name.
        const { port: at } = server.address() as AddressInfo;
        const status = await new Promise<number>((resolve, reject) => {
            const request = http.request({ host: "127.0.0.1", port: at, path: "/", headers: { host: panel, "x-intentic-preview": "pass" } }, (response) => {
                response.resume();
                resolve(response.statusCode ?? 0);
            });
            request.on("error", reject);
            request.end();
        });
        expect(status).toBe(404);
    });
});
