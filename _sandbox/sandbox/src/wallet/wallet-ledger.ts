import { randomBytes } from "node:crypto";
import { z } from "zod";
import { jsonFile } from "../store/json-file.js";

/* THE WALLET LEDGER: one row per payment attempt that got as far as a signature being asked for, plus the
 * declines and expiries around it — the owner-facing record the history command, the status meter and the
 * daily-cap arithmetic all read.
 *
 * A row is OPENED (pending) before the signature is requested and SETTLED after the endpoint answers, and
 * the open is deliberately load-bearing: a ledger that cannot be written refuses the payment (the gate
 * fails closed), and a pending row counts against the daily cap the whole time it is in flight, so two
 * parallel `wallet fetch` calls cannot race one cap. A `pending` row that never settles (the daemon died
 * mid-payment) stays visible as exactly what it is — an authorization whose fate this side did not witness,
 * bounded by its own five-minute validity window.
 *
 * This is the SANDBOX's record. The unfakeable one lives with the platform signer, which writes its own row
 * for every signature it mints — this file is what the owner reads where they already are, not the thing the
 * money's history rests on. Amounts are USD strings (USDC's display form); the arithmetic converts through
 * atomic units, never floats. */

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
    /* `pending` — signature requested, endpoint not yet answered. `paid` — the endpoint served after the
     * payment (settlement's word when it sent one, the 2xx's otherwise). `failed` — signed but refused or
     * unsettled; the authorization expires unused. `declined`/`unanswered` — the card said no / nobody
     * answered; nothing was signed. `refused` — policy or the platform signer said no before a card or after
     * a yes; nothing moved. */
    outcome: z.enum(["pending", "paid", "failed", "declined", "unanswered", "refused"]),
    transaction: z.string().optional(),
    // Whether the payment settled without a card (inside the owner's auto-approve band).
    auto: z.boolean().optional(),
    why: z.string().optional(),
});
export type PaymentRow = z.infer<typeof PaymentRowSchema>;

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
    // Append a pending row; the returned id is what settle() names. Throws when the file cannot be written,
    // which the gate reads as "refuse the payment" — no spend without a row.
    readonly open: (payment: OpenedPayment) => Promise<string>;
    readonly settle: (id: string, outcome: PaymentRow["outcome"], transaction?: string) => Promise<void>;
    // A no-signature outcome (declined, unanswered, policy-refused) — recorded in one write, no pending row.
    readonly record: (payment: OpenedPayment, outcome: "declined" | "unanswered" | "refused") => Promise<void>;
    readonly all: () => Promise<readonly PaymentRow[]>;
}

const utcDay = (at: number): string => new Date(at).toISOString().slice(0, 10);

// What today's payments add up to, in USDC atomic units — `paid` plus everything still in flight, so the cap
// is conservative while an authorization's fate is unknown.
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
        all: () => file.read(),
    };
};
