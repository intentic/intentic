import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";
import { STATE_GROUP_DIR } from "@intentic/sandbox-contract/workspace-state";
import { z } from "zod";
import manifest from "../../intentic-extension.json";
import { JsonObjectSchema } from "./json.js";
import { OfficeScopeSchema } from "./scope.js";

// Every outward act an office connection can take is HELD here, under an action-rule key (Settings → Safety, or the
// public-office preset, which lists these keys): the exact operation, with copies of its files, goes to the approvals
// queue and nothing reaches the office. `deny` refuses outright. Nothing in the agent's shell ever carries one out.
//
// The item names this extension as its `performer`, with the digest of the operation. Once a person approves it in the
// app, the daemon's approvals executor matches the item against the yes it recorded off the workspace, spends that yes,
// and hands the item to this extension's backend (server/perform.ts), which re-reads the operation and its file copies
// once, recomputes the digest over those bytes, checks the card still points at the same office, and only then acts,
// with credentials it reads from the daemon. The approval file's status, which any turn can write, decides nothing.
//
// `allow` is not honoured for these keys (2026-10-15). The rule is read from settings.json, a workspace file any turn can
// write, so an act that ran at once on `allow` was authorised by agent-writable state; honouring it from a protected copy
// of the rules was the alternative, and no such copy exists outside an organisation's pins. An office act is carried out
// on a person's yes or not at all.

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

// The extension the queue hands an approved act to: its publisher.name, which the daemon resolves to the installed copy.
export const PERFORMER = `${manifest.publisher}.${manifest.name}`;

// One file the act sends, copied into the item's own media folder when it was held: `file` is the copy's name there,
// never a path, so what is sent is always the copy the person was shown and never a file somewhere else.
const HeldFileSchema = z.object({
    name: z.string().min(1),
    file: z.string().regex(/^\d+-[^/\\]+$/),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    bytes: z.number().int().nonnegative(),
});
export type HeldFile = z.infer<typeof HeldFileSchema>;

export const OperationSchema = z.object({
    key: ActionKeySchema,
    // The card the operation is for, the office it pointed at in one line, and the whole destination and acting identity
    // it was prepared against (core/scope.ts): a card edited since then in any of them (another instance, a base path or
    // scheme on the same host, INT switched to PROD, another position, user, ADE or system) refuses the approved run.
    card: z.string(),
    target: z.string(),
    scope: OfficeScopeSchema,
    summary: z.string(),
    details: z.string(),
    args: JsonObjectSchema,
    files: z.array(HeldFileSchema),
});
export type Operation = z.infer<typeof OperationSchema>;
export type Proposal = Omit<Operation, "files"> & { readonly files: readonly { readonly path: string; readonly name?: string | undefined }[] };

const SettingsSchema = z.object({ actionRules: z.record(z.string(), z.string()).optional() });

export const approvalsDir = (root: string): string => join(root, STATE_GROUP_DIR.config, "approvals");
const settingsFile = (root: string): string => join(root, STATE_GROUP_DIR.config, "settings.json");

export const APPROVAL_ID = /^e-urzad-[0-9a-f-]{36}$/;

// Where an approval's operation and file copies live: `.intentic/config/approvals/media/<id>/`.
export const mediaDir = (root: string, approvalId: string): string => join(approvalsDir(root), "media", approvalId);
export const OPERATION_FILE = "operation.json";

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

export const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

// What the act will do, as one digest: the office, the card, the arguments and every file's name, copy and bytes. The
// summary and details are left out; the approval card shows the operation itself (operationBlock).
export const digestOf = (operation: Operation): string => {
    const { key, card, target, scope, args, files } = operation;
    return createHash("sha256").update(JSON.stringify({ key, card, target, scope, args, files })).digest("hex");
};

// The operation as the approval card shows it, word for word: what the person reads is what the digest covers. The backend
// refuses an approval whose details lack this block, so an item written by hand with other words is never carried out.
export const operationBlock = (operation: Operation, digest: string): string => {
    const { key, card, target, scope, args } = operation;
    const files = operation.files.map(({ name, sha256: hash, bytes }) => ({ name, bytes, sha256: hash }));
    return `**Exactly this is carried out** (SHA-256 \`${digest}\`):\n\n\`\`\`json\n${JSON.stringify({ key, card, office: target, scope, args, files }, undefined, 2)}\n\`\`\``;
};

export interface Held {
    readonly approvalId: string;
    readonly message: string;
}

export class ActionGuard {
    constructor(private readonly root: string) {}

    // Copies the files into the approvals media folder, so what the person approves is what is sent even if the
    // workspace copy changes later, and writes the item for the queue.
    private async hold(proposal: Proposal, rule: Rule): Promise<Held> {
        const approvalId = `e-urzad-${randomUUID()}`;
        const media = mediaDir(this.root, approvalId);
        await mkdir(media, { recursive: true, mode: 0o700 });
        const files: HeldFile[] = [];
        for (const [index, file] of proposal.files.entries()) {
            const bytes = new Uint8Array(await readFile(file.path));
            const name = file.name ?? basename(file.path);
            const copy = `${index}-${basename(name)}`;
            await writeFile(join(media, copy), bytes, { mode: 0o600, flag: "wx" });
            files.push({ name, file: copy, sha256: sha256(bytes), bytes: bytes.byteLength });
        }
        const operation: Operation = { ...proposal, files };
        const digest = digestOf(operation);
        await writeFile(join(media, OPERATION_FILE), `${JSON.stringify(operation, undefined, 2)}\n`, { mode: 0o600, flag: "wx" });
        const item = {
            kind: "action",
            summary: proposal.summary.slice(0, 200),
            details: `${proposal.details}\n\n**Action rule:** \`${proposal.key}\` · **Card:** ${proposal.card} · **Office:** ${proposal.target}\n\n${operationBlock(operation, digest)}`,
            instructions: `Nothing for a turn to run: once approved, the sandbox hands this to the e-urzad extension, which performs ${proposal.key} for card "${proposal.card}" only if the operation and its files still match SHA-256 ${digest} and the card still points at ${proposal.target}, and writes what the office answered into "result". If it fails or its outcome is uncertain it is not retried: check the office before proposing it again.`,
            performer: { extension: PERFORMER, digest },
            status: "proposed",
            createdAt: Date.now(),
        };
        await writeFile(join(approvalsDir(this.root), `${approvalId}.json`), `${JSON.stringify(item, undefined, 2)}\n`, { mode: 0o600, flag: "wx" });
        const allowed = rule === "allow" ? " The action rules allow this key, but an office act is carried out only on a person's approval." : "";
        return {
            approvalId,
            message: `Held for a person's approval as ${approvalId} (action rule ${proposal.key}). Nothing was sent to the office.${allowed} Once approved, the sandbox carries it out itself and writes the office's answer into the approval's result.`,
        };
    }

    // Holds the act for approval, or refuses it by the action rules. Never acts.
    async propose(proposal: Proposal): Promise<Held> {
        const rule = ruleFor(await readRules(this.root), proposal.key);
        if (rule === "deny") {
            throw new Error(`${proposal.key} is refused by this sandbox's action rules`);
        }
        return this.hold(proposal, rule);
    }
}
