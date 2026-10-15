import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_GROUP_DIR } from "@intentic/sandbox-contract/workspace-state";
import { actionFor, actionRule, executeAction, loadAction } from "./actions.js";
import { Graph } from "./graph.js";
import { account, httpQueue } from "./testing.js";

const draft = {
    key: "microsoft365.mail.send" as const,
    path: "/me/sendMail",
    method: "POST" as const,
    body: { message: { subject: "Wniosek", body: { content: "Treść" } } },
    summary: 'Send "Wniosek" — to someone',
    details: "To: someone",
};

const withRoot = async (run: (root: string) => Promise<void>): Promise<void> => {
    const root = await mkdtemp(join(tmpdir(), "m365-actions-"));
    try {
        await run(root);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
};

test("a send holds with no Graph call, and only the exact running approval sends it, once", () =>
    withRoot(async (root) => {
        const { http, calls } = httpQueue([{ status: 202 }]);
        const graph = new Graph(account, async () => "access", http);
        const action = actionFor(account, draft);
        const held = await executeAction(root, graph, action);
        if (!held.held) {
            throw new Error("expected a hold");
        }
        expect(calls).toEqual([]);
        expect(await loadAction(root, held.approvalId)).toEqual(action);
        const path = join(root, STATE_GROUP_DIR.config, "approvals", `${held.approvalId}.json`);
        const item = JSON.parse(await readFile(path, "utf8"));
        expect(item).toMatchObject({ kind: "action", status: "proposed", summary: draft.summary, details: draft.details });
        expect(item.instructions).toContain(`m365 --account office action run ${held.approvalId}`);
        await expect(executeAction(root, graph, action, held.approvalId)).rejects.toThrow("not set this exact");
        await writeFile(path, JSON.stringify({ ...item, status: "running" }));
        await expect(executeAction(root, graph, { ...action, body: { changed: true } }, held.approvalId)).rejects.toThrow("not set this exact");
        expect(await executeAction(root, graph, action, held.approvalId)).toEqual({ held: false, result: undefined });
        expect(calls).toHaveLength(1);
        await expect(executeAction(root, graph, action, held.approvalId)).rejects.toThrow("EEXIST");
        expect(calls).toHaveLength(1);
        await expect(executeAction(root, new Graph({ ...account, id: "other" }, async () => "a", http), action, held.approvalId)).rejects.toThrow(
            "different",
        );
    }));

test("rules decide: allow sends at once, deny refuses, a wildcard counts, and read only refuses even an allowed write", () =>
    withRoot(async (root) => {
        expect(actionRule({}, "microsoft365.calendar.write")).toBe("hold");
        expect(actionRule({ "microsoft365.*": "allow", "microsoft365.mail.send": "deny" }, "microsoft365.mail.send")).toBe("deny");
        expect(actionRule({ "microsoft365.*": "allow" }, "microsoft365.files.upload")).toBe("allow");
        expect(actionRule({ "microsoft365.mail.send": "nonsense" }, "microsoft365.mail.send")).toBe("hold");
        await mkdir(join(root, STATE_GROUP_DIR.config), { recursive: true });
        const settings = join(root, STATE_GROUP_DIR.config, "settings.json");
        const { http, calls } = httpQueue([{ status: 202 }]);
        const graph = new Graph(account, async () => "access", http);
        await writeFile(settings, JSON.stringify({ actionRules: { "microsoft365.mail.send": "allow" } }));
        expect(await executeAction(root, graph, actionFor(account, draft))).toEqual({ held: false, result: undefined });
        expect(calls).toHaveLength(1);
        await writeFile(settings, JSON.stringify({ actionRules: { "microsoft365.*": "deny" } }));
        await expect(executeAction(root, graph, actionFor(account, draft))).rejects.toThrow("denied");
        await writeFile(settings, JSON.stringify({ actionRules: { "microsoft365.*": "allow" } }));
        const readOnly = new Graph({ ...account, access: "read" }, async () => "token", http);
        await expect(executeAction(root, readOnly, actionFor(account, draft))).rejects.toThrow("read-only");
        expect(calls).toHaveLength(1);
    }));
