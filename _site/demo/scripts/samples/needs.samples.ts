import type { GroupSamples } from "./context.ts";

export const needsSamples: GroupSamples<`needs`> = () => ({
    list: {},
    answer: { id: `need-3m9xd`, answer: { kind: `accept` } },
    release: { id: `need-8p4ve`, answer: `decline` },
    provideSecret: { id: `need-7k2qa`, value: `sk_test_smoke` },
    grants: undefined,
    revokeGrant: { conversationId: `smoke`, kind: `folder`, what: `refs/none` },
});
