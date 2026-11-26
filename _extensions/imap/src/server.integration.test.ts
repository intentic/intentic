import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type FakeExtension, fakeExtensionApi } from "@intentic/extension-api/testing";
import type { ToolCard, ToolResult } from "@intentic/extension-api";
import { imapBackend } from "./server.js";

// The IMAP card's backend holds its credential, and the daemon holds the owner's rule: a send through it is allowed,
// refused or held by the verdict the daemon's outward-action door gives, and a held one goes out only when the
// approvals executor hands it back after a person's yes, exactly as it was held.

// SAFETY: the extension's own manifest, read for who it is and what it may reach.
const manifest = JSON.parse(await readFile(new URL("../intentic-extension.json", import.meta.url), "utf8")) as {
    publisher: string;
    name: string;
    permissions: { daemon: string[] };
};

type Verdict = { verdict: "allow" } | { verdict: "deny"; reason: string } | { verdict: "hold"; reason: string; approvalId?: string };

// What the daemon's door is asked, below the card the path names.
interface Ask {
    readonly action: string;
    readonly conversationId?: string;
    readonly channel?: string;
    readonly hold?: { readonly summary: string; readonly details: string; readonly digest: string };
}

const CONFIG = { host: "imap.example.org", username: "office@example.org", password: "imap-password", smtpHost: "smtp.example.org", smtpPort: "465", smtpSecurity: "tls" };
const CARD: ToolCard = { id: "office", config: CONFIG };
const DRAFT = { to: ["reader@example.org"], subject: "Wniosek", text: "Treść", attachments: [{ name: "a.txt", data: Buffer.from("bytes").toString("base64") }] };

interface Harness {
    readonly extension: FakeExtension;
    readonly asks: Ask[];
    readonly outcomes: { readonly outcome: string; readonly conversationId?: string }[];
    readonly sent: { readonly args: string[]; readonly login: string }[];
    readonly verdict: { current: (ask: Ask) => Verdict };
    readonly connection: { config: Record<string, string> };
}

const harness = async (verdict: (ask: Ask) => Verdict): Promise<Harness> => {
    const asks: Ask[] = [];
    const outcomes: Harness["outcomes"][number][] = [];
    const sent: Harness["sent"][number][] = [];
    const state = { current: verdict };
    const connection = { config: { ...CONFIG } };
    const extension = await fakeExtensionApi({
        manifest,
        daemon: async (request) => {
            const path = new URL(request.url).pathname;
            if (path === "/capabilities/office/outward-action") {
                // SAFETY: the shape the backend sends, as the contract's OutwardActionAskSchema declares it.
                const ask = (await request.json()) as Ask;
                asks.push(ask);
                return Response.json(state.current(ask));
            }
            if (path === "/capabilities/office/outward-action/outcome") {
                // SAFETY: as above, OutwardActionOutcomeSchema.
                outcomes.push((await request.json()) as Harness["outcomes"][number]);
                return Response.json({ ok: true });
            }
            if (path === "/capabilities/office/connection") {
                return Response.json({ id: "office", kind: "cli", config: connection.config });
            }
            return undefined;
        },
    });
    await extension.activate({
        activateServer: imapBackend({
            transport: async (args, _mime, login) => {
                sent.push({ args, login });
            },
        }),
    });
    return { extension, asks, outcomes, sent, verdict: state, connection };
};

// SAFETY: every tool of this backend answers a ToolResult (server.ts `answer`) or a string, which a test names.
const textOf = (result: unknown): string => (result as ToolResult).content.map((part) => (part.type === "text" ? part.text : "")).join("");

const heldFiles = async (extension: FakeExtension): Promise<string[]> => readdir(join(extension.api.stateDir, "held")).catch(() => []);

const yes = (digest: string) => ({ id: "imap-1", digest, summary: "Send", details: "", approvedAt: 1, actionRules: {} });

test("an allowed send goes out from the backend with the card's login, and is recorded for its conversation", async () => {
    const { extension, asks, outcomes, sent } = await harness(() => ({ verdict: "allow" }));
    try {
        const result = await extension.callTool("send", DRAFT, CARD, { conversationId: "conv-a" });
        expect(textOf(result)).toBe("SMTP delivery accepted");
        expect(asks).toMatchObject([{ action: "message.send", conversationId: "conv-a", channel: "reader@example.org", endpoint: "smtp://smtp.example.org" }]);
        expect(sent).toHaveLength(1);
        expect(sent[0]?.args).toContain("smtps://smtp.example.org:465");
        expect(sent[0]?.login).toBe('user = "office@example.org:imap-password"\n');
        expect(outcomes).toMatchObject([{ outcome: "ok", conversationId: "conv-a" }]);
        expect(await heldFiles(extension)).toEqual([]);
        expect(extension.calls.every((call) => call.admitted)).toBe(true);
    } finally {
        await extension.dispose();
    }
});

test("a denied send is refused with the rule's reason and nothing goes out", async () => {
    const { extension, sent } = await harness(() => ({ verdict: "deny", reason: "imap message.send is refused by the action rules" }));
    try {
        // SAFETY: a refusal is answered as a ToolResult with isError (server.ts `answer`).
        const result = (await extension.callTool("send", DRAFT, CARD, { conversationId: "conv-a" })) as ToolResult;
        expect(result.isError).toBe(true);
        expect(textOf(result)).toBe("Not sent: imap message.send is refused by the action rules.");
        expect(sent).toEqual([]);
        expect(await heldFiles(extension)).toEqual([]);
    } finally {
        await extension.dispose();
    }
});

test("a held send waits for the owner, and goes out only through perform after the yes, exactly once", async () => {
    const { extension, asks, outcomes, sent } = await harness((ask) =>
        ask.hold === undefined ? { verdict: "hold", reason: "imap message.send requires owner approval" } : { verdict: "hold", reason: "imap message.send requires owner approval", approvalId: "imap-1" },
    );
    try {
        const result = await extension.callTool("send", DRAFT, CARD, { conversationId: "conv-a" });
        expect(textOf(result)).toContain("Held for the owner's approval as imap-1");
        expect(sent).toEqual([]);
        const digest = asks[0]?.hold?.digest ?? "";
        expect(asks[0]?.hold?.summary).toBe("Send email to reader@example.org: Wniosek");
        expect(asks[0]?.hold?.details).toContain("Attachments: a.txt (5 bytes)");
        expect(await heldFiles(extension)).toEqual([`${digest}.json`]);

        expect(await extension.perform(yes(digest))).toEqual({ outcome: "done", result: "SMTP delivery accepted for reader@example.org" });
        expect(sent).toHaveLength(1);
        // Asked again at perform, with no draft, so a rule set to deny since still refuses; no conversation then.
        expect(asks[1]).toMatchObject({ action: "message.send", channel: "reader@example.org" });
        expect(asks[1]?.hold).toBeUndefined();
        expect(outcomes).toEqual([expect.objectContaining({ outcome: "ok" })]);
        expect(outcomes[0]?.conversationId).toBeUndefined();
        expect(await heldFiles(extension)).toEqual([]);
        expect(await extension.perform(yes(digest))).toMatchObject({ outcome: "refused" });
        expect(sent).toHaveLength(1);
    } finally {
        await extension.dispose();
    }
});

test("a held send that changed, that a rule now denies, or whose card now sends as someone else is refused at perform", async () => {
    const { extension, asks, sent, verdict, connection } = await harness(() => ({ verdict: "hold", reason: "held", approvalId: "imap-1" }));
    try {
        await extension.callTool("send", DRAFT, CARD, { conversationId: "conv-a" });
        const digest = asks[0]?.hold?.digest ?? "";
        const file = join(extension.api.stateDir, "held", `${digest}.json`);
        const original = await readFile(file, "utf8");

        await writeFile(file, original.replace("reader@example.org", "someone@example.org"));
        expect(await extension.perform(yes(digest))).toEqual({ outcome: "refused", error: "the held message changed since it was approved, so it was not sent" });

        await writeFile(file, original);
        verdict.current = () => ({ verdict: "deny", reason: "imap message.send is refused by the action rules" });
        expect(await extension.perform(yes(digest))).toEqual({ outcome: "refused", error: "imap message.send is refused by the action rules" });

        verdict.current = () => ({ verdict: "hold", reason: "held" });
        connection.config = { ...CONFIG, username: "other@example.org" };
        expect(await extension.perform(yes(digest))).toMatchObject({ outcome: "refused", error: expect.stringContaining("now sends as other@example.org") });
        expect(sent).toEqual([]);
    } finally {
        await extension.dispose();
    }
});

test("a draft that cannot go out is refused before anything is put before the owner", async () => {
    const { extension, asks } = await harness(() => ({ verdict: "hold", reason: "held", approvalId: "imap-1" }));
    try {
        await expect(Promise.resolve(extension.callTool("send", { ...DRAFT, to: ["not an address"] }, CARD))).rejects.toThrow("invalid mail address");
        await expect(Promise.resolve(extension.callTool("send", DRAFT, { id: "office", config: { ...CONFIG, smtpHost: "" } }))).rejects.toThrow("set the SMTP host");
        expect(asks).toEqual([]);
    } finally {
        await extension.dispose();
    }
});
