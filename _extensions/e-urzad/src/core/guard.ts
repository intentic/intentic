import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";
import { STATE_GROUP_DIR } from "@intentic/sandbox-contract/workspace-state";
import { z } from "zod";
import { JsonObjectSchema } from "./json.js";

// Every outward act an office connection can take goes through here, under an action-rule key the owner sets in the
// sandbox's action rules (Settings → Safety, or the public-office preset, which lists these keys). Unset, a key HOLDS:
// the exact operation, with copies of its files, is written to the approvals queue and nothing reaches the office. The
// owner approves it in the app; the daemon starts a fresh turn whose instructions run `e-urzad approved <id>`, and that
// command re-reads the item, insists it is running, and recomputes the digest over the operation and the copied bytes
// before it acts. `deny` refuses outright; `allow` acts at once. The same pattern as the IMAP sender (_extensions/imap).
//
// What this cannot stop: an agent that writes the approval file itself with status "running". The daemon keeps the
// owner's yes outside the workspace and fails such an item back, but this command, like the IMAP sender, can only read
// the workspace file. The digest makes the forged item name exactly the material it would send.

export const ACTION_KEYS = {
    registerIncoming: "ezdrp.document.register-incoming",
    registerOutgoing: "ezdrp.document.register-outgoing",
    attachToCase: "ezdrp.case.attach-draft",
    openDelivery: "edoreczenia.delivery.open",
    sendDelivery: "edoreczenia.delivery.send",
} as const;

export type ActionKey = (typeof ACTION_KEYS)[keyof typeof ACTION_KEYS];
export const ACTION_KEY_LIST: readonly ActionKey[] = Object.values(ACTION_KEYS);

const ActionKeySchema = z.enum(ACTION_KEY_LIST);
export type Rule = "allow" | "hold" | "deny";

const HeldFileSchema = z.object({ name: z.string(), path: z.string(), sha256: z.string(), bytes: z.number() });
export type HeldFile = z.infer<typeof HeldFileSchema>;

export const OperationSchema = z.object({
    key: ActionKeySchema,
    // The card the operation is for, and the office it pointed at when it was prepared: a card edited since then (another
    // instance, INT switched to PROD, another ADE) refuses the approved run.
    card: z.string(),
    target: z.string(),
    summary: z.string(),
    details: z.string(),
    args: JsonObjectSchema,
    files: z.array(HeldFileSchema),
});
export type Operation = z.infer<typeof OperationSchema>;
export type Proposal = Omit<Operation, "files"> & { readonly files: readonly { readonly path: string; readonly name?: string }[] };

const SettingsSchema = z.object({ actionRules: z.record(z.string(), z.string()).optional() });
const ApprovalItemSchema = z.object({ status: z.string().optional(), instructions: z.string().optional() });

export const approvalsDir = (root: string): string => join(root, STATE_GROUP_DIR.config, "approvals");
const settingsFile = (root: string): string => join(root, STATE_GROUP_DIR.config, "settings.json");

const APPROVAL_ID = /^e-urzad-[0-9a-f-]{36}$/;

// The exact key, else the provider's wildcard (`ezdrp.*`), else hold: the same lookup the daemon's own guard makes, with
// the opposite default, since an office act is never fine by default.
export const ruleFor = (rules: Readonly<Record<string, string>> | undefined, key: ActionKey): Rule => {
    const value = rules?.[key] ?? rules?.[`${key.split(".")[0] ?? key}.*`];
    return value === "allow" || value === "deny" ? value : "hold";
};

const readRules = async (root: string): Promise<Readonly<Record<string, string>> | undefined> => {
    const raw = await readFile(settingsFile(root), "utf8").catch(undefinedIfMissing);
    if (raw === undefined) {
        return undefined;
    }
    const parsed = SettingsSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
        throw new Error("the sandbox settings could not be read, so no office action is taken");
    }
    return parsed.data.actionRules;
};

const digestOf = (operation: Operation): string => {
    const { key, card, target, args, files } = operation;
    return createHash("sha256").update(JSON.stringify({ key, card, target, args, files })).digest("hex");
};

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export type GuardOutcome<T> = { readonly done: true; readonly result: T } | { readonly done: false; readonly approvalId: string; readonly message: string };

export class ActionGuard {
    constructor(private readonly root: string) {}

    // Copies the files into the approvals media folder, so what the owner approves is what is sent even if the
    // workspace copy changes later, and writes the item for the queue.
    private async hold(proposal: Proposal): Promise<{ readonly approvalId: string; readonly message: string }> {
        const approvalId = `e-urzad-${randomUUID()}`;
        const media = join(approvalsDir(this.root), "media", approvalId);
        await mkdir(media, { recursive: true, mode: 0o700 });
        const files: HeldFile[] = [];
        for (const [index, file] of proposal.files.entries()) {
            const bytes = new Uint8Array(await readFile(file.path));
            const name = file.name ?? basename(file.path);
            const copy = join(media, `${index}-${basename(name)}`);
            await writeFile(copy, bytes, { mode: 0o600, flag: "wx" });
            files.push({ name, path: copy, sha256: sha256(bytes), bytes: bytes.byteLength });
        }
        const operation: Operation = { ...proposal, files };
        const digest = digestOf(operation);
        await writeFile(join(media, "operation.json"), `${JSON.stringify(operation, undefined, 2)}\n`, { mode: 0o600, flag: "wx" });
        const fileLines = files.map((file) => `- ${file.name} (${file.bytes} bytes, SHA-256 ${file.sha256})`).join("\n");
        const item = {
            kind: "action",
            summary: proposal.summary.slice(0, 200),
            details: `${proposal.details}\n\n**Action rule:** \`${proposal.key}\` · **Card:** ${proposal.card} · **Office:** ${proposal.target}${files.length > 0 ? `\n\n**Files:**\n${fileLines}` : ""}`,
            instructions: `Run \`e-urzad approved ${approvalId}\` exactly once. It re-checks that this approval is running and that the operation and its files still match SHA-256 ${digest}, then performs ${proposal.key} for card "${proposal.card}" and prints what the office answered. Put the identifiers it prints (registry number, message task id) in "result". If it fails or times out, do not retry: report the error, since the office may already have registered the act.`,
            status: "proposed",
            createdAt: Date.now(),
        };
        await writeFile(join(approvalsDir(this.root), `${approvalId}.json`), `${JSON.stringify(item, undefined, 2)}\n`, { mode: 0o600, flag: "wx" });
        return { approvalId, message: `Held for the owner's approval as ${approvalId} (action rule ${proposal.key}). Nothing was sent to the office.` };
    }

    // Decides by the action rules: act now, hold for approval, or refuse.
    async run<T>(proposal: Proposal, act: (operation: Operation) => Promise<T>): Promise<GuardOutcome<T>> {
        const rule = ruleFor(await readRules(this.root), proposal.key);
        if (rule === "deny") {
            throw new Error(`${proposal.key} is refused by this sandbox's action rules`);
        }
        if (rule === "hold") {
            return { done: false, ...(await this.hold(proposal)) };
        }
        const files: HeldFile[] = [];
        for (const file of proposal.files) {
            const bytes = new Uint8Array(await readFile(file.path));
            files.push({ name: file.name ?? basename(file.path), path: file.path, sha256: sha256(bytes), bytes: bytes.byteLength });
        }
        return { done: true, result: await act({ ...proposal, files }) };
    }

    // The operation an approval covers, once the owner said yes and the daemon started its run.
    async approved(approvalId: string): Promise<Operation> {
        if (!APPROVAL_ID.test(approvalId)) {
            throw new Error(`"${approvalId}" is not an e-urzad approval id`);
        }
        const rule = (key: ActionKey): Promise<Rule> => readRules(this.root).then((rules) => ruleFor(rules, key));
        const item = ApprovalItemSchema.parse(JSON.parse(await readFile(join(approvalsDir(this.root), `${approvalId}.json`), "utf8")));
        const media = join(approvalsDir(this.root), "media", approvalId);
        const operation = OperationSchema.parse(JSON.parse(await readFile(join(media, "operation.json"), "utf8")));
        if ((await rule(operation.key)) === "deny") {
            throw new Error(`${operation.key} is refused by this sandbox's action rules`);
        }
        if (item.status !== "running") {
            throw new Error(`approval ${approvalId} is ${item.status ?? "without a status"}, not running: only the owner's approval starts it`);
        }
        const digest = digestOf(operation);
        if (item.instructions?.includes(digest) !== true) {
            throw new Error(`approval ${approvalId} no longer matches the operation that was proposed`);
        }
        for (const file of operation.files) {
            if (sha256(new Uint8Array(await readFile(file.path))) !== file.sha256) {
                throw new Error(`the approved file ${file.name} changed after it was approved`);
            }
        }
        return operation;
    }
}
