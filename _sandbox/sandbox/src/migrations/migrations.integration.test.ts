import { Readable } from "node:stream";
import { createGzip } from "node:zlib";
import type { Automation, Capability, SkillDraft } from "@intentic/sandbox-contract";
import { pack } from "tar-stream";
import { expect, test } from "vitest";
import { MigrationFormatError, readForeignArchive, rebaseArchive } from "./archive.js";
import { applyMigration, type MigrationDeps } from "./apply.js";
import { planHermes } from "./hermes.js";
import { detectOpenclaw, planOpenclaw } from "./openclaw.js";

/* The whole crossing, minus the HTTP framing: a packed `~/.hermes` through the archive reader, the adapter and
 * the apply loop, against deps that record every write. What the daemon composition adds on top (real stores,
 * the capability registry) is covered by its own suites; this one proves the migration pipeline's promises:
 * bounded reading, re-derivation, per-item failure, idempotent memory. */

const packHome = (entries: Record<string, string>): ReadableStream<Uint8Array> => {
    const packer = pack();
    for (const [name, content] of Object.entries(entries)) {
        packer.entry({ name, type: "file" }, content);
    }
    packer.finalize();
    return Readable.toWeb(packer.pipe(createGzip())) as ReadableStream<Uint8Array>;
};

// Packed the way the docs will tell people to: `tar czf … -C ~ .hermes`, so every entry carries the prefix.
const HOME: Record<string, string> = {
    ".hermes/config.yaml": "mcp_servers:\n  linear:\n    url: https://mcp.linear.app/sse\n",
    ".hermes/.env": "OPENAI_API_KEY=sk-test\n",
    ".hermes/SOUL.md": "Be warm.",
    ".hermes/skills/weather/SKILL.md": "---\ndescription: Forecasts.\n---\nUse wttr.in.",
    ".hermes/sessions/2026/log.jsonl": "{}",
    ".hermes/state.db": "not-a-real-db",
};

interface Recorded {
    readonly files: Map<string, string>;
    readonly skills: SkillDraft[];
    readonly automations: Automation[];
    readonly capabilities: Capability[];
    readonly secrets: Map<string, string>;
    readonly deps: MigrationDeps;
}

const recordingDeps = (): Recorded => {
    const files = new Map<string, string>();
    const skills: SkillDraft[] = [];
    const automations: Automation[] = [];
    const capabilities: Capability[] = [];
    const secrets = new Map<string, string>();
    return {
        files,
        skills,
        automations,
        capabilities,
        secrets,
        deps: {
            readWorkspaceFile: (relPath) => Promise.resolve(files.get(relPath)),
            writeWorkspaceFile: async (relPath, content) => {
                files.set(relPath, content);
            },
            saveSkill: async (skill) => {
                skills.push(skill);
            },
            upsertAutomation: async (automation) => {
                automations.push(automation);
            },
            addCapability: async (capability) => {
                capabilities.push(capability);
            },
            setSecret: async (key, value) => {
                secrets.set(key, value);
            },
        },
    };
};

test("a packed home is read bounded (sessions and databases never held), rebased off its prefix, and planned", async () => {
    const archive = await readForeignArchive(packHome(HOME), 10 * 1024 * 1024);
    expect(archive.skipped.some((entry) => entry.includes("sessions"))).toBe(true);
    expect(archive.skipped.some((entry) => entry.includes("state.db"))).toBe(true);
    const files = rebaseArchive(archive.files, "config.yaml");
    expect(files).toBeDefined();
    expect(files?.has("SOUL.md")).toBe(true);
    expect([...(files?.keys() ?? [])].some((path) => path.includes("sessions"))).toBe(false);

    const { planned } = planHermes(files ?? new Map());
    const ids = planned.map((entry) => entry.item.id);
    expect(ids).toContain("memory:soul");
    expect(ids).toContain("skill:weather");
    expect(ids).toContain("secret:OPENAI_API_KEY");
    expect(ids).toContain("capability:mcp:linear");
});

test("a non-archive upload is a format error, not a crash", async () => {
    const body = Readable.toWeb(Readable.from([Buffer.from("just some text")])) as ReadableStream<Uint8Array>;
    await expect(readForeignArchive(body, 1024)).rejects.toThrow(MigrationFormatError);
});

test("apply lands the ticked items through the deps and reports the rest honestly", async () => {
    const archive = await readForeignArchive(packHome(HOME), 10 * 1024 * 1024);
    const files = rebaseArchive(archive.files, "config.yaml") ?? new Map();
    const plan = planHermes(files);
    const recorded = recordingDeps();

    const report = await applyMigration(recorded.deps, plan, {
        items: ["memory:soul", "skill:weather", "secret:OPENAI_API_KEY", "capability:mcp:linear"],
        includeSecrets: true,
    });
    expect(report.failed).toEqual([]);
    expect(report.applied.map((entry) => entry.id).toSorted()).toEqual([
        "capability:mcp:linear",
        "memory:soul",
        "secret:OPENAI_API_KEY",
        "skill:weather",
    ]);
    // Memory lands in BOTH agents' files, fenced.
    expect(recorded.files.get("CLAUDE.md")).toContain("intentic:imported-hermes:soul");
    expect(recorded.files.get("AGENTS.md")).toContain("Be warm.");
    expect(recorded.skills[0]?.name).toBe("weather");
    expect(recorded.secrets.get("OPENAI_API_KEY")).toBe("sk-test");
    expect(recorded.capabilities[0]?.id).toBe("linear");

    // Re-applying is safe: the fences replace rather than stack.
    await applyMigration(recorded.deps, plan, { items: ["memory:soul"], includeSecrets: true });
    expect(recorded.files.get("CLAUDE.md")?.split("intentic:imported-hermes:soul:start").length).toBe(2);
});

test("withholding secrets skips secret items and lands capabilities keyless, saying so", async () => {
    const home = {
        ...HOME,
        ".hermes/config.yaml": "mcp_servers:\n  linear:\n    url: https://mcp.linear.app/sse\n    headers:\n      Authorization: Bearer lin_x\n",
    };
    const archive = await readForeignArchive(packHome(home), 10 * 1024 * 1024);
    const plan = planHermes(rebaseArchive(archive.files, "config.yaml") ?? new Map());
    const recorded = recordingDeps();

    const report = await applyMigration(recorded.deps, plan, {
        items: ["secret:OPENAI_API_KEY", "capability:mcp:linear"],
        includeSecrets: false,
    });
    expect(recorded.secrets.size).toBe(0);
    expect(recorded.capabilities[0]?.config).toEqual({ url: "https://mcp.linear.app/sse" });
    expect(report.needsAction.some((entry) => entry.subject === "Secrets withheld" && entry.detail.includes("OPENAI_API_KEY"))).toBe(true);
    expect(report.needsAction.some((entry) => entry.subject.includes("linear"))).toBe(true);
});

test("an openclaw home crosses the same pipeline: pairing state never held, the diary lands file by file", async () => {
    const archive = await readForeignArchive(
        packHome({
            ".openclaw/openclaw.json": `{ agents: { defaults: { heartbeat: { every: "30m" } } } }`,
            ".openclaw/credentials/whatsapp-ratchet.json": "{}",
            ".openclaw/workspace/SOUL.md": "Dry wit.",
            ".openclaw/workspace/HEARTBEAT.md": "Check the calendar.",
            ".openclaw/workspace/memory/2026-08-01.md": "Day one.",
            ".openclaw/workspace/memory/2026-08-02.md": "Day two.",
        }),
        10 * 1024 * 1024,
    );
    // The ratchet was skipped at the reader, before any adapter saw it: copying it would desync the source.
    expect(archive.skipped.some((entry) => entry.includes("credentials"))).toBe(true);
    const files = rebaseArchive(archive.files, "openclaw.json") ?? new Map();
    expect(detectOpenclaw(files)).toBe(true);

    const plan = planOpenclaw(files);
    const recorded = recordingDeps();
    const report = await applyMigration(recorded.deps, plan, {
        items: ["memory:soul", "file:memory-diary", "automation:openclaw-heartbeat"],
        includeSecrets: false,
    });
    expect(report.failed).toEqual([]);
    expect(recorded.files.get("CLAUDE.md")).toContain("intentic:imported-openclaw:soul");
    expect(recorded.files.get("imports/openclaw/memory/2026-08-01.md")).toBe("Day one.");
    expect(recorded.files.get("imports/openclaw/memory/2026-08-02.md")).toBe("Day two.");
    expect(recorded.automations[0]?.trigger).toEqual({ kind: "schedule", cron: "*/30 * * * *" });
});

test("one item failing is one failed row, not a dead migration", async () => {
    const archive = await readForeignArchive(packHome(HOME), 10 * 1024 * 1024);
    const plan = planHermes(rebaseArchive(archive.files, "config.yaml") ?? new Map());
    const recorded = recordingDeps();
    const deps: MigrationDeps = {
        ...recorded.deps,
        addCapability: () => Promise.reject(new Error('a "linear" connection already exists: rename or remove it first')),
    };

    const report = await applyMigration(deps, plan, { items: ["memory:soul", "capability:mcp:linear"], includeSecrets: true });
    expect(report.applied.map((entry) => entry.id)).toEqual(["memory:soul"]);
    expect(report.failed).toEqual([{ id: "capability:mcp:linear", label: "MCP server, linear", error: expect.stringContaining("already exists") }]);
});
