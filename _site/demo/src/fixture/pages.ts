import { type Page, standalonePage } from "@intentic/sandbox-contract";
import { PRIYA_CHAT_ID } from "./openChats";

// A page an agent showed in a chat (`show_page`), as the daemon stores it: the agent's own markup made whole on its own
// (standalonePage), under the conversation's records. Priya's reconciliation answers with one, the three payouts that do
// not match drawn against the ones that do, which is the reading a paragraph of numbers makes the reader do themselves.

const PAYOUTS_HTML = `<!doctype html>
<html><head><style>
.summary{display:flex;gap:24px;flex-wrap:wrap;margin:0 0 14px}
.stat b{display:block;font-size:20px;font-weight:600;letter-spacing:-.01em}
.stat span{color:var(--muted-foreground);font-size:12px}
.stat.bad b{color:var(--danger)}
table{width:100%;border-collapse:collapse;font-size:13px}
th{color:var(--muted-foreground);font-weight:500;text-align:left;padding:6px 8px;border-bottom:1px solid var(--border)}
td{padding:8px;border-bottom:1px solid var(--border);vertical-align:middle}
td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.bar{height:8px;border-radius:4px;background:var(--danger);opacity:.85}
.track{background:var(--muted);border-radius:4px;width:100%}
.tag{display:inline-block;padding:1px 8px;border-radius:999px;font-size:11px;background:var(--muted);color:var(--muted-foreground)}
</style></head><body>
<div class="summary">
  <div class="stat"><b>412</b><span>payouts in August</span></div>
  <div class="stat"><b>$186,340</b><span>settled</span></div>
  <div class="stat"><b>409</b><span>reconcile to the cent</span></div>
  <div class="stat bad"><b>3 · $2,242</b><span>refunded after the payout closed</span></div>
</div>
<table>
  <thead><tr><th>Customer</th><th>Paid out</th><th>Refunded</th><th class="num">Amount</th><th style="width:30%"></th></tr></thead>
  <tbody>
    <tr><td>Northwind <span class="tag">annual</span></td><td>Aug 26</td><td>Aug 29</td><td class="num">$2,180.00</td><td><div class="track"><div class="bar" style="width:100%"></div></div></td></tr>
    <tr><td>Lumen Studio</td><td>Aug 26</td><td>Sep 2</td><td class="num">$38.00</td><td><div class="track"><div class="bar" style="width:1.7%"></div></div></td></tr>
    <tr><td>Harbour Coffee</td><td>Aug 26</td><td>Sep 3</td><td class="num">$24.00</td><td><div class="track"><div class="bar" style="width:1.1%"></div></div></td></tr>
  </tbody>
</table>
</body></html>`;

export const PAYOUTS_PAGE: Page = {
    id: `7c1e9a2b4f`,
    title: `August payouts that don't reconcile`,
    path: `.intentic/records/artifacts/pages/${PRIYA_CHAT_ID}/7c1e9a2b4f.r0.html`,
    measured: 214,
};

// The stored bytes, by path, for /workspace/raw.
export const PAGE_FILES: ReadonlyMap<string, string> = new Map([[PAYOUTS_PAGE.path, standalonePage(PAYOUTS_HTML)]]);
