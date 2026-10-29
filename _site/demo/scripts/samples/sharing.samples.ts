import type { GroupSamples } from "./context.ts";

// A missing source exercises the per-account refusal; stopping an unknown borrow is idempotent.
export const sharingSamples: GroupSamples<`sharing`> = () => ({
    shareable: undefined,
    borrow: { card: `smoke-missing-source`, items: [{ provider: `claude`, account: `smoke-account` }] },
    borrowed: undefined,
    stop: { id: `lent-smoke` },
});
