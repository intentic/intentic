import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { fileJoinLinks, type JoinLinks } from "./join-links.js";

/* What a join link is allowed to do, and what it must refuse. The rules worth pinning are the ones an owner
 * would be surprised by if they broke: a link that outlives its expiry, a "one person" link that lets in two,
 * and a guest locked out of their own link because they opened it twice. */

let dir: string;
let links: JoinLinks;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "join-links-"));
    links = fileJoinLinks(join(dir, "join-links.json"));
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

const NOW = 1_760_000_000_000;

describe("minting", () => {
    test("hands the secret back once and never stores it", async () => {
        const { secret } = await links.mint({ label: "Ada", role: "collaborator" });

        expect(secret).toMatch(/^ijl_/);
        // The listing an owner reads carries no way to reconstruct the link — only who used it.
        expect(JSON.stringify(await links.list())).not.toContain(secret);
    });

    test("lists what the owner needs to recognize a link, including who came in through it", async () => {
        const { secret, id } = await links.mint({ label: "Ada", role: "viewer", maxUses: 2 });
        await links.redeem(secret, "ada@example.com", NOW);

        expect(await links.list()).toEqual([
            expect.objectContaining({ id, label: "Ada", role: "viewer", maxUses: 2, redeemedBy: ["ada@example.com"] }),
        ]);
    });
});

describe("redeeming", () => {
    test("grants the role the link carries", async () => {
        const { secret } = await links.mint({ label: "Ada", role: "maintainer" });

        await expect(links.redeem(secret, "ada@example.com", NOW)).resolves.toEqual({ ok: true, role: "maintainer" });
    });

    test("refuses a secret nobody minted, and says so as `unknown` rather than as a role", async () => {
        await expect(links.redeem("ijl_not-a-real-link", "ada@example.com", NOW)).resolves.toEqual({ ok: false, reason: "unknown" });
    });

    test("refuses an empty secret — the one input that must never match a stored digest", async () => {
        await links.mint({ label: "Ada", role: "viewer" });

        await expect(links.redeem("", "ada@example.com", NOW)).resolves.toEqual({ ok: false, reason: "unknown" });
    });

    test("refuses after the expiry the owner set", async () => {
        const { secret } = await links.mint({ label: "Ada", role: "viewer", expiresAt: NOW });

        await expect(links.redeem(secret, "ada@example.com", NOW - 1)).resolves.toEqual({ ok: true, role: "viewer" });
        await expect(links.redeem(secret, "grace@example.com", NOW)).resolves.toEqual({ ok: false, reason: "expired" });
    });

    test("counts PEOPLE, so the same guest reopening their link is free", async () => {
        const { secret } = await links.mint({ label: "Ada", role: "viewer", maxUses: 1 });

        await expect(links.redeem(secret, "ada@example.com", NOW)).resolves.toEqual({ ok: true, role: "viewer" });
        // Second device, re-login, forwarded tab — the same person, so the one seat is still theirs.
        await expect(links.redeem(secret, "ada@example.com", NOW)).resolves.toEqual({ ok: true, role: "viewer" });
        expect((await links.list())[0]?.redeemedBy).toEqual(["ada@example.com"]);
    });

    test("refuses the second PERSON on a one-seat link", async () => {
        const { secret } = await links.mint({ label: "Ada", role: "viewer", maxUses: 1 });
        await links.redeem(secret, "ada@example.com", NOW);

        await expect(links.redeem(secret, "grace@example.com", NOW)).resolves.toEqual({ ok: false, reason: "full" });
    });

    test("two people racing for the last seat: exactly one gets in", async () => {
        const { secret } = await links.mint({ label: "one seat", role: "viewer", maxUses: 1 });

        const [first, second] = await Promise.all([links.redeem(secret, "ada@example.com", NOW), links.redeem(secret, "grace@example.com", NOW)]);

        expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
        expect((await links.list())[0]?.redeemedBy).toHaveLength(1);
    });
});

describe("revoking", () => {
    test("a revoked link stops working", async () => {
        const { secret, id } = await links.mint({ label: "Ada", role: "viewer" });

        await expect(links.revoke(id)).resolves.toBe(true);

        await expect(links.redeem(secret, "ada@example.com", NOW)).resolves.toEqual({ ok: false, reason: "unknown" });
        expect(await links.list()).toEqual([]);
    });

    test("revoking one leaves the others alone, and revoking an absent id writes nothing", async () => {
        const keep = await links.mint({ label: "keep", role: "viewer" });
        const drop = await links.mint({ label: "drop", role: "viewer" });

        await links.revoke(drop.id);

        await expect(links.revoke("no-such-id")).resolves.toBe(false);
        await expect(links.redeem(keep.secret, "ada@example.com", NOW)).resolves.toEqual({ ok: true, role: "viewer" });
    });
});
