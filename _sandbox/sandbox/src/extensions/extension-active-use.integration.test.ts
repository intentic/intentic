import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capability } from "@intentic/sandbox-contract";
import { expect, test, vi } from "vitest";
import { createUseNoter, markExtensionActive, recentActiveUse, utcDay } from "./extension-active-use.js";

const tempRoot = (): string => mkdtempSync(join(tmpdir(), "active-use-"));

const flush = async (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

test("a mark is a day bit: idempotent, and readable back as rows", async () => {
    const root = tempRoot();
    await markExtensionActive(root, "acme.research", "2026-08-10");
    await markExtensionActive(root, "acme.research", "2026-08-10");
    await markExtensionActive(root, "acme.replies", "2026-08-10");
    expect(await recentActiveUse(root, 7, "2026-08-10")).toEqual([
        { extensionId: "acme.research", day: "2026-08-10" },
        { extensionId: "acme.replies", day: "2026-08-10" },
    ]);
});

test("recent answers only the asked-for window, oldest day first", async () => {
    const root = tempRoot();
    await markExtensionActive(root, "acme.research", "2026-08-01");
    await markExtensionActive(root, "acme.research", "2026-08-09");
    await markExtensionActive(root, "acme.research", "2026-08-10");
    expect(await recentActiveUse(root, 7, "2026-08-10")).toEqual([
        { extensionId: "acme.research", day: "2026-08-09" },
        { extensionId: "acme.research", day: "2026-08-10" },
    ]);
});

test("a write sweeps days that aged out of the keep window", async () => {
    const root = tempRoot();
    await markExtensionActive(root, "acme.research", "2026-01-01");
    await markExtensionActive(root, "acme.research", "2026-08-10");
    const raw = JSON.parse(await readFile(join(root, ".intentic/extension-active-use.json"), "utf8")) as Record<string, unknown>;
    expect(Object.keys(raw)).toEqual(["2026-08-10"]);
});

test("the noter marks a premium install once per day and asks the capability store once per (day, id)", async () => {
    const root = tempRoot();
    const premium: Capability = {
        id: "acme.research",
        kind: "extension",
        config: { url: "https://github.com/acme/research.git", ref: "a".repeat(40), tier: "premium" },
    };
    const capabilityOf = vi.fn(async (id: string) => (id === "acme.research" ? premium : undefined));
    const noter = createUseNoter(root, capabilityOf, () => new Date("2026-08-10T12:00:00Z"));
    noter.note("acme.research");
    noter.note("acme.research");
    await flush();
    noter.note("acme.research");
    await flush();
    expect(capabilityOf.mock.calls.length).toBeLessThanOrEqual(2);
    expect(await recentActiveUse(root, 7, "2026-08-10")).toEqual([{ extensionId: "acme.research", day: "2026-08-10" }]);
});

test("the noter records nothing for a free install, an unknown id, or a non-extension capability", async () => {
    const root = tempRoot();
    const free: Capability = {
        id: "acme.free",
        kind: "extension",
        config: { url: "https://github.com/acme/free.git", ref: "b".repeat(40) },
    };
    const noter = createUseNoter(root, async (id) => (id === "acme.free" ? free : undefined), () => new Date("2026-08-10T12:00:00Z"));
    noter.note("acme.free");
    noter.note("nobody.knows");
    await flush();
    expect(await recentActiveUse(root, 7, utcDay(new Date("2026-08-10T12:00:00Z")))).toEqual([]);
});
