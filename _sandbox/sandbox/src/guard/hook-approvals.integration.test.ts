import { mkdtempSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxRouteFor } from "@intentic/sandbox-contract";
import { approveHookSet, dismissHookSet, gateSettingsHooks, type HookGate, hookRequests } from "./hook-approvals.js";
import type { ModuleReader } from "./plugin-modules.js";
import type { HookPlace } from "./settings-hooks.js";

// The ledger an owner's yes lands in, and the gate a turn asks it through, over real files under a temp history root.

const setup = async (): Promise<{ historyRoot: string; place: HookPlace; writeHooks: (command: string) => Promise<void> }> => {
    const base = mkdtempSync(join(tmpdir(), "hook-approvals-"));
    const place: HookPlace = {
        cwd: join(base, "work"),
        home: join(base, "home"),
        configDir: join(base, "home", ".claude"),
        readable: (path) => path,
    };
    const writeHooks = async (command: string): Promise<void> => {
        await mkdir(join(place.cwd, ".claude"), { recursive: true });
        await writeFile(
            join(place.cwd, ".claude", "settings.json"),
            JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command }] }] } }),
        );
    };
    return { historyRoot: join(base, "history"), place, writeHooks };
};

// A reader no test here reaches: none of these sets holds a plugin module.
const unread: ModuleReader = async () => {
    throw new Error("no module was expected");
};

// The digest a gate found; a test reaching for it expects hooks to be there.
const digestOf = (gate: HookGate): string => {
    if (gate.set === undefined) {
        throw new Error("the gate found no hooks");
    }
    return gate.set.digest;
};

describe("gateSettingsHooks", () => {
    test("a workspace with no settings hooks is never held and asks nobody", async () => {
        const { historyRoot, place } = await setup();

        expect(await gateSettingsHooks(historyRoot, place, "conv-1", unread)).toEqual({ held: false, set: undefined });
        expect(await hookRequests(historyRoot)).toEqual({ requests: [] });
    });

    test("unapproved hooks hold the turn and raise one request naming what they run, however many turns find them", async () => {
        const { historyRoot, place, writeHooks } = await setup();
        await writeHooks("./guard.sh");

        const gate = await gateSettingsHooks(historyRoot, place, "conv-1", unread, 1000);
        expect(gate.held).toBe(true);
        await gateSettingsHooks(historyRoot, place, "conv-2", unread, 2000);

        expect((await hookRequests(historyRoot)).requests).toEqual([
            {
                digest: digestOf(gate),
                seenAt: 1000,
                conversationId: "conv-1",
                hooks: [{ source: "project", event: "PreToolUse", matcher: "Bash", type: "command", run: "./guard.sh" }],
                scripts: [],
            },
        ]);
    });

    test("approval lets exactly that set run from the next turn; any change to it is held and asks again", async () => {
        const { historyRoot, place, writeHooks } = await setup();
        await writeHooks("./guard.sh");
        const first = await gateSettingsHooks(historyRoot, place, undefined, unread);

        expect(await approveHookSet(historyRoot, digestOf(first))).toBe(true);
        expect((await gateSettingsHooks(historyRoot, place, undefined, unread)).held).toBe(false);
        expect((await hookRequests(historyRoot)).requests).toEqual([]);

        await writeHooks("./guard.sh --and-more");
        const changed = await gateSettingsHooks(historyRoot, place, undefined, unread);
        expect(changed.held).toBe(true);
        expect((await hookRequests(historyRoot)).requests.map((request) => request.digest)).toEqual([digestOf(changed)]);
    });

    test("a digest no turn ever found cannot be approved or dismissed", async () => {
        const { historyRoot } = await setup();

        expect(await approveHookSet(historyRoot, "a".repeat(64))).toBe(false);
        expect(await dismissHookSet(historyRoot, "a".repeat(64))).toBe(false);
    });

    test("a ledger this build cannot read approves nothing, and says so on the list", async () => {
        const { historyRoot, place, writeHooks } = await setup();
        await writeHooks("./guard.sh");
        const found = await gateSettingsHooks(historyRoot, place, undefined, unread);
        await approveHookSet(historyRoot, digestOf(found));
        expect((await gateSettingsHooks(historyRoot, place, undefined, unread)).held).toBe(false);

        await writeFile(join(historyRoot, "hook-approvals.json"), "{ not json");

        expect((await gateSettingsHooks(historyRoot, place, undefined, unread)).held).toBe(true);
        expect(await hookRequests(historyRoot)).toMatchObject({ ledgerUnreadable: true, requests: [{ digest: digestOf(found) }] });
    });

    test("approving over an unreadable ledger keeps its content aside and approves only what was asked", async () => {
        const { historyRoot, place, writeHooks } = await setup();
        await writeHooks("./guard.sh");
        const found = await gateSettingsHooks(historyRoot, place, undefined, unread);
        await writeFile(join(historyRoot, "hook-approvals.json"), "{ not json");

        await approveHookSet(historyRoot, digestOf(found));

        expect(await readFile(join(historyRoot, "hook-approvals.json.corrupt"), "utf8")).toBe("{ not json");
        expect(Object.keys(JSON.parse(await readFile(join(historyRoot, "hook-approvals.json"), "utf8")).approved)).toEqual([digestOf(found)]);
        expect((await gateSettingsHooks(historyRoot, place, undefined, unread)).held).toBe(false);
    });

    test("a dismissed set stays off, sinks below the waiting ones, and can still be approved", async () => {
        const { historyRoot, place, writeHooks } = await setup();
        await writeHooks("./old.sh");
        const old = await gateSettingsHooks(historyRoot, place, undefined, unread, 1000);
        await writeHooks("./new.sh");
        const current = await gateSettingsHooks(historyRoot, place, undefined, unread, 2000);

        expect(await dismissHookSet(historyRoot, digestOf(current))).toBe(true);
        expect((await gateSettingsHooks(historyRoot, place, undefined, unread, 3000)).held).toBe(true);
        expect((await hookRequests(historyRoot)).requests.map((request) => [request.digest, request.dismissed ?? false])).toEqual([
            [digestOf(old), false],
            [digestOf(current), true],
        ]);

        expect(await approveHookSet(historyRoot, digestOf(current))).toBe(true);
        expect((await gateSettingsHooks(historyRoot, place, undefined, unread)).held).toBe(false);
    });
});

describe("gateSettingsHooks over a plugin's hooks module", () => {
    const withModPlugin = async (): Promise<{ historyRoot: string; place: HookPlace; dir: string }> => {
        const { historyRoot, place } = await setup();
        const dir = join(place.home, "plugins", "modded");
        await mkdir(join(dir, ".claude-plugin"), { recursive: true });
        await mkdir(join(dir, "hooks"), { recursive: true });
        await writeFile(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "modded" }));
        await writeFile(join(dir, "hooks", "hooks.json"), JSON.stringify({ modules: ["./register.ts"] }));
        await writeFile(join(dir, "hooks", "register.ts"), "export const register = () => {};\n");
        return { historyRoot, place: { ...place, plugins: [{ name: "Modded", from: "extension", dir }] }, dir };
    };

    test("an unapproved module holds the turn, and its request says what the module does, read once however many turns find it", async () => {
        const { historyRoot, place, dir } = await withModPlugin();
        const reads: string[] = [];
        const reader: ModuleReader = async (readDir, module) => {
            reads.push(`${readDir} ${module}`);
            return { hooks: ["tool.call{tool=Bash}"], calls: ["$.process.spawn", "$.http.fetch"] };
        };

        expect((await gateSettingsHooks(historyRoot, place, "conv-1", reader, 1000)).held).toBe(true);
        await gateSettingsHooks(historyRoot, place, "conv-2", reader, 2000);

        expect(reads).toEqual([`${dir} ./register.ts`]);
        expect((await hookRequests(historyRoot)).requests).toMatchObject([
            {
                seenAt: 1000,
                hooks: [{ source: "plugin", plugin: "Modded", declaredIn: "~/plugins/modded/hooks/hooks.json", event: "*", type: "module", run: "./register.ts" }],
                scripts: [{ path: "~/plugins/modded/hooks/register.ts" }],
                plugins: [
                    {
                        name: "Modded",
                        from: "extension",
                        dir: "~/plugins/modded",
                        module: { path: "./register.ts", hooks: ["tool.call{tool=Bash}"], calls: ["$.process.spawn", "$.http.fetch"] },
                    },
                ],
            },
        ]);
    });

    test("a reader that fails holds the turn all the same, and the card says the module could not be read", async () => {
        const { historyRoot, place } = await withModPlugin();
        const failing: ModuleReader = async () => {
            throw new Error("spawn EACCES");
        };

        const gate = await gateSettingsHooks(historyRoot, place, undefined, failing);

        expect(gate.held).toBe(true);
        expect((await hookRequests(historyRoot)).requests[0]?.plugins).toEqual([
            {
                name: "Modded",
                from: "extension",
                dir: "~/plugins/modded",
                module: { path: "./register.ts", hooks: [], calls: [], unreadable: "it could not be read (spawn EACCES)" },
            },
        ]);
        expect(await approveHookSet(historyRoot, digestOf(gate))).toBe(true);
        expect((await gateSettingsHooks(historyRoot, place, undefined, failing)).held).toBe(false);
    });

    test("editing the module after its approval holds the next turn and asks again", async () => {
        const { historyRoot, place, dir } = await withModPlugin();
        const reader: ModuleReader = async () => ({ hooks: ["session.start"], calls: [] });
        await approveHookSet(historyRoot, digestOf(await gateSettingsHooks(historyRoot, place, undefined, reader)));
        expect((await gateSettingsHooks(historyRoot, place, undefined, reader)).held).toBe(false);

        await writeFile(join(dir, "hooks", "register.ts"), "export const register = (on) => on('tool.call', () => {});\n");

        expect((await gateSettingsHooks(historyRoot, place, undefined, reader)).held).toBe(true);
    });
});

// What keeps an agent from giving the yes itself: the approving routes are declared out of reach of the agent token,
// the panel token every panel process holds, and control tokens. The handlers refuse any caller with no person's
// session besides (approvals.routes.ts).
test("no machine credential reaches the routes that approve or dismiss hooks", () => {
    for (const path of [`/approvals/hooks/${"a".repeat(64)}/approve`, `/approvals/hooks/${"a".repeat(64)}/dismiss`]) {
        expect(sandboxRouteFor("POST", path)?.meta).toEqual({ panel: false, control: "never" });
    }
    expect(sandboxRouteFor("GET", "/approvals/hooks")?.meta).toEqual({ floor: "maintainer" });
});
