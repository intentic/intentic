import type { GroupSamples } from "./context.ts";

export const servicesSamples: GroupSamples<`services`> = () => ({ list: undefined, save: { id: `smoke-service`, steward: `ada@acme.dev` }, remove: { id: `smoke-service` } });
