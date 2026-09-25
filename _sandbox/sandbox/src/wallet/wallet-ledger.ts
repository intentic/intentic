import { randomBytes } from "node:crypto";
import { utcDayOf } from "@intentic/sandbox-contract";
import { z } from "zod";
import { defineDocument } from "../store/evolution/documents.js";
import { jsonFile } from "../store/json-file.js";
import { stateRelPath } from "../state-paths.js";

// One row per payment attempt that reached a signature request, plus declines and expiries; what the history command,
// status meter and daily-cap arithmetic read.
// A row opens pending before the signature and settles after the endpoint answers; an unreadable or unwritable ledger fails closed,
// and a pending row counts against the cap while in flight.
// This is the sandbox's own record, not the platform signer's unfakeable one; amounts are USD strings, converted
// through atomic units, never floats.

const ROWS_CAP = 500;
export const WHY_MAX = 280;

export const PaymentRowSchema = z.object({
    id: z.string(),
    // Epoch ms, stamped when the row opened.
    at: z.number(),
    url: z.string(),
    host: z.string(),
    payTo: z.string(),
    network: z.string(),
    amountUsd: z.string(),
    // `pending`: signature requested, not yet answered.
    // `paid`: endpoint served after payment.
    // `failed`: signed but refused or unsettled; authorization expires unused.
    // `declined`/`unanswered`: card said no / nobody answered; nothing signed.
    // `refused`: policy or signer said no; nothing moved.
    outcome: z.enum(["pending", "paid", "failed", "declined", "unanswered", "refused"]),
    transaction: z.string().optional(),
    // Whether the payment settled without a card (inside the owner's auto-approve band).
    auto: z.boolean().optional(),
    why: z.string().optional(),
});
export type PaymentRow = z.infer<typeof PaymentRowSchema>;

export const walletLedgerDocument = defineDocument({
    path: stateRelPath(".intentic/records/wallet-ledger.json"),
    schema: PaymentRowSchema,
    granularity: "entries",
});

export interface OpenedPayment {
    readonly url: string;
    readonly host: string;
    readonly payTo: string;
    readonly network: string;
    readonly amountUsd: string;
    readonly auto: boolean;
    readonly why: string | undefined;
}

export interface WalletLedgerStore {
    // Appends a pending row, id for settle(); throws when unwritable, which the gate reads as refuse.
    readonly open: (payment: OpenedPayment) => Promise<string>;
    readonly settle: (id: string, outcome: PaymentRow["outcome"], transaction?: string) => Promise<void>;
    // A no-signature outcome (declined, unanswered, policy-refused), recorded in one write, no pending row.
    readonly record: (payment: OpenedPayment, outcome: "declined" | "unanswered" | "refused") => Promise<void>;
    // Throws when the ledger exists but cannot be read: an empty history would reopen the whole daily cap.
    readonly all: () => Promise<readonly PaymentRow[]>;
}

// UTC, and the refusal message says so ("the cap resets at midnight UTC", payment-offer.ts). A spending cap keyed to
// the owner's own midnight would move every time they changed the setting, and a cap that moves is not a cap.
// The shared spelling rather than a local one, so every UTC bucket in the tree is findable from one name.
const utcDay = utcDayOf;

// Today's payments in USDC atomic units: `paid` plus everything still in flight, so the cap stays conservative while a
// fate is unknown.
export const spentTodayAtomic = (rows: readonly PaymentRow[], nowMs: number, usdToAtomic: (usd: string) => bigint): bigint => {
    const today = utcDay(nowMs);
    let total = 0n;
    for (const row of rows) {
        if ((row.outcome === "paid" || row.outcome === "pending") && utcDay(row.at) === today) {
            total += usdToAtomic(row.amountUsd);
        }
    }
    return total;
};

export const fileWalletLedger = (path: string, now: () => number = Date.now): WalletLedgerStore => {
    const file = jsonFile<PaymentRow[]>(path, {
        parse: (raw) => {
            const parsed = z.array(PaymentRowSchema).safeParse(raw);
            return parsed.success ? parsed.data : undefined;
        },
        fallback: () => [],
        mode: 0o600,
        // The cap's only memory of today's spend: a fresh ledger over an unreadable one would forget it.
        onUnreadable: "refuse",
        document: walletLedgerDocument,
    });
    const append = async (row: PaymentRow): Promise<void> => {
        await file.update((current) => [...current, row].slice(-ROWS_CAP));
    };
    return {
        open: async (payment) => {
            const id = randomBytes(8).toString("hex");
            await append({
                id,
                at: now(),
                url: payment.url,
                host: payment.host,
                payTo: payment.payTo,
                network: payment.network,
                amountUsd: payment.amountUsd,
                outcome: "pending",
                ...(payment.auto ? { auto: true } : {}),
                ...(payment.why !== undefined ? { why: payment.why.slice(0, WHY_MAX) } : {}),
            });
            return id;
        },
        settle: async (id, outcome, transaction) => {
            await file.update((current) =>
                current.map((row) => (row.id === id ? { ...row, outcome, ...(transaction !== undefined ? { transaction } : {}) } : row)),
            );
        },
        record: async (payment, outcome) => {
            await append({
                id: randomBytes(8).toString("hex"),
                at: now(),
                url: payment.url,
                host: payment.host,
                payTo: payment.payTo,
                network: payment.network,
                amountUsd: payment.amountUsd,
                outcome,
                ...(payment.auto ? { auto: true } : {}),
                ...(payment.why !== undefined ? { why: payment.why.slice(0, WHY_MAX) } : {}),
            });
        },
        all: async () => {
            const state = await file.state();
            if (state.unreadable) {
                throw new Error(`the wallet ledger could not be read (${state.detail}), so today's spending is unknown`);
            }
            return state.value;
        },
    };
};
