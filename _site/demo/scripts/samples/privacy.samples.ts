import type { GroupSamples } from "./context.ts";

export const privacySamples: GroupSamples<`privacy`> = () => ({
    status: undefined,
    setPolicy: { mode: `on`, trusted: [], classes: [`person-name`], images: `mask`, names: `dictionary`, allow: [] },
    log: undefined,
    reveal: { tokens: [] },
    image: { id: `smoke-image-0000000` },
    dictionary: { query: `kow` },
    preview: { text: `EMP-123456` },
    sources: undefined,
    forget: { source: `clients.csv (name)` },
});
