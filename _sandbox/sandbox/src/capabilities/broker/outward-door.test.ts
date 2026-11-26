import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { type CapabilityContribution, ExtensionManifestSchema } from "@intentic/extension-manifest";
import type { ActivityEvent } from "@intentic/sandbox-contract/schemas/activity";
import type { ActionApprovalSummary } from "@intentic/sandbox-contract/schemas/approvals";
import type { AdmissionRule } from "@intentic/sandbox-contract/schemas/command-admission";
import { outboundRefusal } from "../../guard/outbound-guard.js";
import { askOutward, type DoorCard, type OutwardDoorDeps, recordOutward } from "./outward-door.js";

// The outward-action door decides the owner's rule for what an extension's backend sends with its own card, read against
// the card's declaration as the extension ships it: here the IMAP and Microsoft 365 manifests in this repository.

type CliSpec = Extract<CapabilityContribution, { kind: "cli" }>;

const specOf = (folder: string, id: string): CliSpec => {
    const manifest = ExtensionManifestSchema.parse(JSON.parse(readFileSync(join(repoRoot(import.meta.url), "_extensions", folder, "intentic-extension.json"), "utf8")));
    const spec = manifest.contributes?.capabilities?.find((card) => card.id === id);
    if (spec?.kind !== "cli") {
        throw new Error(`no ${id} cli card in ${folder}`);
    }
    return spec;
};

const IMAP: DoorCard = { id: "office", spec: specOf("imap", "imap"), extension: "imap", performer: "intentic.imap" };
const M365: DoorCard = { id: "staff", spec: specOf("microsoft-365", "microsoft365"), extension: "microsoft-365", performer: "intentic.microsoft-365" };

const DIGEST = "a".repeat(64);

const harness = (rules: Readonly<Record<string, AdmissionRule>>, cards: readonly DoorCard[] = [IMAP, M365]) => {
    const proposed: ActionApprovalSummary[] = [];
    const rows: Omit<ActivityEvent, "id" | "at">[] = [];
    const deps: OutwardDoorDeps = {
        card: async (id) => cards.find((card) => card.id === id),
        actionRules: async () => rules,
        propose: async (item) => {
            proposed.push(item);
        },
        record: async (row) => {
            rows.push(row);
        },
        runningTurn: (conversation) => (conversation === "conv-1" ? "turn-1" : undefined),
        newId: () => "11111111-2222-3333-4444-555555555555",
        now: () => 1_700_000_000_000,
    };
    return { deps, proposed, rows };
};

const send = { id: "office", action: "message.send", conversationId: "conv-1", channel: "bob@example.com", content: "Hello" };
const hold = { summary: "Send email to bob@example.com: Hello", details: "To: bob@example.com", digest: DIGEST };

test("an allowed send goes ahead and is recorded only once it is answered", async () => {
    const { deps, proposed, rows } = harness({ "imap.message.send": "allow" });
    expect(await askOutward(deps, "imap", { ...send, hold })).toEqual({ verdict: "allow" });
    expect(proposed).toEqual([]);
    expect(rows).toEqual([]);
    await recordOutward(deps, "imap", { ...send, outcome: "ok", endpoint: "smtp://smtp.example.com" });
    expect(rows).toEqual([
        {
            provider: "imap",
            type: "message.send",
            direction: "out",
            method: "POST",
            endpoint: "smtp://smtp.example.com",
            channelId: "bob@example.com",
            content: "Hello",
            conversationId: "conv-1",
            turnId: "turn-1",
            outcome: "ok",
        },
    ]);
});

test("a denied send is refused with the rule's reason and recorded as refused", async () => {
    const { deps, proposed, rows } = harness({ "imap.*": "deny" });
    expect(await askOutward(deps, "imap", { ...send, hold })).toEqual({ verdict: "deny", reason: "imap message.send is refused by the action rules" });
    expect(proposed).toEqual([]);
    expect(rows).toMatchObject([{ provider: "imap", type: "message.send", outcome: "error", error: "imap message.send is refused by the action rules" }]);
});

test("a held send becomes an approvals-queue item the extension carries out, pinned to its digest", async () => {
    const { deps, proposed, rows } = harness({ "imap.message.send": "hold" });
    const verdict = await askOutward(deps, "imap", { ...send, hold });
    expect(verdict).toEqual({
        verdict: "hold",
        reason: "imap message.send requires owner approval",
        approvalId: "imap-11111111-2222-3333-4444-555555555555",
    });
    expect(proposed).toEqual([
        expect.objectContaining({
            id: "imap-11111111-2222-3333-4444-555555555555",
            kind: "action",
            status: "proposed",
            summary: hold.summary,
            details: hold.details,
            performer: { extension: "intentic.imap", digest: DIGEST },
            createdAt: 1_700_000_000_000,
        }),
    ]);
    expect(rows).toMatchObject([{ outcome: "error", error: "held for the owner's approval as imap-11111111-2222-3333-4444-555555555555; nothing was sent" }]);
});

test("a mail send no rule names holds, as the mail tools always did, while a gateway send stays allowed", async () => {
    const { deps, proposed } = harness({});
    expect(await askOutward(deps, "imap", { ...send, hold })).toMatchObject({ verdict: "hold", approvalId: expect.any(String) });
    expect(await askOutward(deps, "microsoft-365", { id: "staff", action: "calendar.write", hold })).toMatchObject({ verdict: "hold" });
    expect(proposed.map((item) => item.performer?.extension)).toEqual(["intentic.imap", "intentic.microsoft-365"]);
    const slack = specOf("slack", "slack");
    const gateway = harness({}, [{ id: "team", spec: slack, extension: "slack", performer: "intentic.slack" }]);
    expect(await askOutward(gateway.deps, "slack", { id: "team", action: "message.send" })).toEqual({ verdict: "allow" });
});

test("an owner's allow wins over the tool's own default", async () => {
    const { deps } = harness({ "microsoft365.*": "allow" });
    expect(await askOutward(deps, "microsoft-365", { id: "staff", action: "files.upload", hold })).toEqual({ verdict: "allow" });
});

test("an approved action asking again is answered, never drafted twice", async () => {
    const { deps, proposed } = harness({ "imap.message.send": "hold" });
    expect(await askOutward(deps, "imap", { id: "office", action: "message.send" })).toEqual({
        verdict: "hold",
        reason: "imap message.send requires owner approval",
    });
    expect(proposed).toEqual([]);
});

test("only the extension that contributes the card asks, and only about an action the card declares", async () => {
    const { deps } = harness({});
    await expect(askOutward(deps, "microsoft-365", { ...send, hold })).rejects.toThrow('"office" is not a connection extension "microsoft-365" contributes');
    await expect(askOutward(deps, "imap", { ...send, action: "message.delete" })).rejects.toThrow('declares no outward action "message.delete"');
    await expect(askOutward(deps, "imap", { ...send, id: "nobody" })).rejects.toThrow('no connected card "nobody"');
    await expect(recordOutward(deps, "imap", { id: "staff", action: "mail.send", outcome: "ok" })).rejects.toThrow("is not a connection");
});

// (2026-11-26) The whole path of `imap send` in an agent's shell: the command guard lets it run whatever the rule says,
// because the card declares its backend gates it (`gatedBy: "backend"`), and the backend's ask at this door is where the
// rule is decided. Until the manifest could say so, `selfGated` did, and also stood for "held while no rule names it".
describe("imap send from an agent's shell", () => {
    const commands = (IMAP.spec.commandActions ?? []).map((entry) => ({ ...entry, provider: IMAP.spec.id }));
    const typed = `imap send "Hello" --to bob@example.com`;

    test("the manifest declares the send gated by its backend and held while no rule names it, without selfGated", () => {
        expect(IMAP.spec.commandActions).toEqual([expect.objectContaining({ action: "message.send", gatedBy: "backend", unruled: "hold" })]);
        expect(IMAP.spec.commandActions?.some((entry) => entry.selfGated !== undefined)).toBe(false);
        expect(M365.spec.commandActions?.every((entry) => entry.gatedBy === "backend" && entry.unruled === "hold" && entry.selfGated === undefined)).toBe(true);
    });

    test("under a hold rule it reaches the backend, whose ask becomes an approvals item", async () => {
        const rules = { "imap.message.send": "hold" } as const;
        expect(outboundRefusal(rules, typed, commands)).toBeUndefined();
        const { deps, proposed } = harness(rules);
        expect(await askOutward(deps, "imap", { ...send, hold })).toMatchObject({ verdict: "hold", approvalId: expect.any(String) });
        expect(proposed).toEqual([expect.objectContaining({ kind: "action", status: "proposed", performer: { extension: "intentic.imap", digest: DIGEST } })]);
    });

    test("under a deny rule the door refuses it, and nothing is drafted", async () => {
        const rules = { "imap.*": "deny" } as const;
        expect(outboundRefusal(rules, typed, commands)).toBeUndefined();
        const { deps, proposed } = harness(rules);
        expect(await askOutward(deps, "imap", { ...send, hold })).toEqual({ verdict: "deny", reason: "imap message.send is refused by the action rules" });
        expect(proposed).toEqual([]);
    });
});
