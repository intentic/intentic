import { expect, test } from "vitest";
import type { HostHub } from "../hosts/host-hub.js";
import { detectOpenclaw } from "./openclaw.js";
import { probeHost, scanHost } from "./host-scan.js";
import { planHermes } from "./hermes.js";
import { detectHermes } from "./hermes.js";

/* The direct read, against a fake machine that answers the two tools it needs. The point of these is that a
 * connected computer produces the SAME map an archive does — so the adapters, and everything after them, are
 * untouched by which door the setup came through. */

// A pretend home directory, keyed by absolute path the way the machine's own tools are addressed.
const machine = (tree: Record<string, string | null>, separator = "/"): { hub: HostHub; calls: string[] } => {
    const calls: string[] = [];
    const hub = {
        mcp: async (_id: string, payload: unknown) => {
            const { params } = payload as { params: { name: string; arguments: Record<string, string> } };
            const path = params.arguments["path"] ?? "";
            calls.push(`${params.name} ${path}`);
            if (params.name === "list_dir") {
                if (tree[path] !== null) {
                    return { result: { content: [{ type: "text", text: `"${path}" is not a directory` }], isError: true } };
                }
                const prefix = `${path}${separator}`;
                const names = new Set<string>();
                for (const key of Object.keys(tree)) {
                    if (!key.startsWith(prefix)) {
                        continue;
                    }
                    const rest = key.slice(prefix.length).split(separator);
                    const name = rest[0] ?? "";
                    if (name !== "") {
                        names.add(name);
                    }
                }
                const entries = [...names].map((name) => {
                    const child = tree[`${prefix}${name}`];
                    return child === null ? { name, kind: "directory" } : { name, kind: "file", size: Buffer.byteLength(child ?? "", "utf8") };
                });
                return { result: { content: [{ type: "text", text: JSON.stringify(entries) }] } };
            }
            const body = tree[path];
            if (typeof body !== "string") {
                return { result: { content: [{ type: "text", text: `no such file` }], isError: true } };
            }
            return { result: { content: [{ type: "text", text: body }] } };
        },
    } as unknown as HostHub;
    return { hub, calls };
};

const HERMES_TREE: Record<string, string | null> = {
    "/home/me": null,
    "/home/me/.hermes": null,
    "/home/me/.hermes/config.yaml": "mcp_servers:\n  linear:\n    url: https://mcp.linear.app/sse\n",
    "/home/me/.hermes/SOUL.md": "Be warm.",
    "/home/me/.hermes/.env": "OPENAI_API_KEY=sk-test\n",
    "/home/me/.hermes/skills": null,
    "/home/me/.hermes/skills/weather": null,
    "/home/me/.hermes/skills/weather/SKILL.md": "---\ndescription: Forecasts.\n---\nUse wttr.in.",
    // Never read: the segments the shared policy refuses, and a binary the allowlist declines.
    "/home/me/.hermes/sessions": null,
    "/home/me/.hermes/sessions/log.jsonl": "{}",
    "/home/me/.hermes/state.db": "binary",
    "/home/me/.hermes/avatar.png": "not text",
};

test("probe finds a setup by its settings file, and answers nothing for a machine without one", async () => {
    const { hub } = machine(HERMES_TREE);
    expect(await probeHost(hub, "laptop", "/home/me")).toBe("hermes");

    const empty = machine({ "/home/me": null, "/home/me/.openclaw": null });
    // The folder exists but holds no settings file — an uninstall leftover is not an importable setup.
    expect(await probeHost(empty.hub, "laptop", "/home/me")).toBeUndefined();
});

test("the scan produces the same map an archive would, and the adapters recognize it unchanged", async () => {
    const { hub } = machine(HERMES_TREE);
    const scan = await scanHost(hub, "laptop", "/home/me", "hermes");
    expect([...scan.files.keys()].toSorted()).toEqual([".env", "SOUL.md", "config.yaml", "skills/weather/SKILL.md"]);
    expect(detectHermes(scan.files)).toBe(true);

    const { planned } = planHermes(scan.files);
    const ids = planned.map((entry) => entry.item.id);
    expect(ids).toContain("memory:soul");
    expect(ids).toContain("skill:weather");
    expect(ids).toContain("secret:OPENAI_API_KEY");
    expect(ids).toContain("capability:mcp:linear");
});

test("session logs are never even read, and non-text files are skipped rather than mangled", async () => {
    const { hub, calls } = machine(HERMES_TREE);
    const scan = await scanHost(hub, "laptop", "/home/me", "hermes");
    // Not merely absent from the map — no call was ever made for them.
    expect(calls.some((call) => call.includes("sessions"))).toBe(false);
    expect(calls.some((call) => call.startsWith("read_file") && call.includes("avatar.png"))).toBe(false);
    expect(scan.skipped.some((entry) => entry.startsWith("sessions/"))).toBe(true);
    expect(scan.skipped).toContain("avatar.png");
    expect(scan.skipped).toContain("state.db");
});

test("a Windows machine's backslash paths are addressed the way that machine spells them", async () => {
    const tree: Record<string, string | null> = {
        "C:\\Users\\me": null,
        "C:\\Users\\me\\.openclaw": null,
        "C:\\Users\\me\\.openclaw\\openclaw.json": `{ agents: { defaults: { model: { primary: "anthropic/claude" } } } }`,
        "C:\\Users\\me\\.openclaw\\workspace": null,
        "C:\\Users\\me\\.openclaw\\workspace\\SOUL.md": "Dry wit.",
    };
    const { hub } = machine(tree, "\\");
    expect(await probeHost(hub, "desktop", "C:\\Users\\me")).toBe("openclaw");
    const scan = await scanHost(hub, "desktop", "C:\\Users\\me", "openclaw");
    // The MAP is still forward-slash and relative — the separator is a fact about the machine, not the plan.
    expect([...scan.files.keys()].toSorted()).toEqual(["openclaw.json", "workspace/SOUL.md"]);
    expect(detectOpenclaw(scan.files)).toBe(true);
});

test("one unreadable file is recorded and the rest of the walk still lands", async () => {
    const { hub } = machine({ ...HERMES_TREE, "/home/me/.hermes/SOUL.md": null as unknown as string });
    const scan = await scanHost(hub, "laptop", "/home/me", "hermes");
    // SOUL.md answers as a directory here (a symlink, a permission oddity) — the import is not lost over it.
    expect(scan.files.has("config.yaml")).toBe(true);
    expect(scan.files.has("skills/weather/SKILL.md")).toBe(true);
});
