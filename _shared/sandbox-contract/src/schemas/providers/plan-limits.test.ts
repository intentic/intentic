import { sandboxAnswerSchema } from "../../index.js";
import { ProviderRefusalsSchema } from "./plan-limits.js";

// 2026-10-21: /agent/refusals went from one refusal per provider to a list per provider, and the editor parses every
// answer with its own build's schema. Against a released daemon (1.249.0 to 1.345.0) the parse failed, the read was kept
// as nothing, and every spent account and model read as ready.
test("reads a released daemon's one refusal per provider as a list of one, and today's lists as they are", () => {
    const spent = { at: 1_760_000_000_000, kind: "limit", message: "Claude AI usage limit reached", account: "acct-1", resetsAt: 1_760_010_000 };
    const schema = sandboxAnswerSchema(["agent", "refusals"]);
    const older = schema?.safeParse({ refusals: { claude: spent } });
    expect(older?.success).toBe(true);
    expect(older?.data).toEqual({ refusals: { claude: [spent] } });
    const today = { refusals: { claude: [spent, { at: 1_760_000_000_001, kind: "auth", message: "OAuth token revoked", account: "acct-2" }], codex: [] } };
    expect(schema?.safeParse(today).data).toEqual(today);
    expect(ProviderRefusalsSchema.safeParse({ refusals: { claude: "spent" } }).success).toBe(false);
});
