import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { fileSecretUses, lastUseByName } from "./secret-uses.js";

/* The use ledger: append-only rows on disk, capped, newest-last, what the inventory joins as "last used".
 * Driven against the real file store because the cap and the round-trip ARE the behaviour. */

const store = () => fileSecretUses(join(mkdtempSync(join(tmpdir(), "secret-uses-")), "secret-uses.json"));

test("rows round-trip in order and the newest per name wins the join", async () => {
    const uses = store();
    await uses.record({ name: "CLOUDFLARE_API_TOKEN", lane: "shell", detail: "curl https://api", at: 1 });
    await uses.record({ name: "GRAFANA_ADMIN_PASSWORD", lane: "browser", detail: "grafana.example.com", at: 2 });
    await uses.record({ name: "CLOUDFLARE_API_TOKEN", lane: "shell", detail: "komodo write/UpdateStack", at: 3 });
    const all = await uses.all();
    expect(all).toHaveLength(3);
    const last = lastUseByName(all);
    expect(last.get("CLOUDFLARE_API_TOKEN")?.detail).toBe("komodo write/UpdateStack");
    expect(last.get("GRAFANA_ADMIN_PASSWORD")?.lane).toBe("browser");
});

test("the ledger is capped: a what-happened-recently surface, not an archive", async () => {
    const uses = store();
    for (let index = 0; index < 230; index += 1) {
        await uses.record({ name: `K${index}`, lane: "shell", at: index });
    }
    const all = await uses.all();
    expect(all).toHaveLength(200);
    // Newest kept, oldest dropped.
    expect(all[0]?.name).toBe("K30");
    expect(all.at(-1)?.name).toBe("K229");
});
