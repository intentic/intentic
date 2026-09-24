import { mkdtempSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileWalletLedger } from "./wallet-ledger.js";

// The ledger is the daily cap's only memory of today's spend: a ledger that cannot be read must neither read as an empty
// history nor be replaced by a fresh one, or the whole cap reopens.

const ledgerPath = (): string => join(mkdtempSync(join(tmpdir(), "wallet-ledger-")), "wallet-ledger.json");

const payment = {
    url: "https://api.example.com/premium",
    host: "api.example.com",
    payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
    network: "eip155:8453",
    amountUsd: "0.10",
    auto: false,
    why: undefined,
};

test("a ledger never written reads as no payments, and an opened row reads back pending", async () => {
    const ledger = fileWalletLedger(ledgerPath(), () => 1_000);
    expect(await ledger.all()).toEqual([]);
    const id = await ledger.open(payment);
    expect(await ledger.all()).toEqual([
        {
            id,
            at: 1_000,
            url: payment.url,
            host: payment.host,
            payTo: payment.payTo,
            network: payment.network,
            amountUsd: "0.10",
            outcome: "pending",
        },
    ]);
});

test("a ledger that cannot be read refuses the read and every write, and is left exactly as it was", async () => {
    const path = ledgerPath();
    const garbled = `[{"id":"a","at":1,"outcome":"paid","amountUsd":"4.90"`;
    await writeFile(path, garbled, "utf8");
    const ledger = fileWalletLedger(path);
    await expect(ledger.all()).rejects.toThrow("the wallet ledger could not be read (the file is not valid JSON), so today's spending is unknown");
    await expect(ledger.open(payment)).rejects.toThrow("wallet-ledger.json could not be read by this build");
    await expect(ledger.record(payment, "refused")).rejects.toThrow("wallet-ledger.json could not be read by this build");
    expect(await readFile(path, "utf8")).toBe(garbled);
});
