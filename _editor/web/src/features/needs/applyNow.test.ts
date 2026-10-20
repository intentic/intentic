import { applyNow } from "./applyNow";

test(`apply goes out for a need still open, and a refusal fails the press`, async () => {
    let sent = 0;
    const refuse = async (): Promise<never> => {
        sent += 1;
        throw new Error(`not working yet`);
    };
    await expect(applyNow({ current: () => ({ status: `open` }), apply: refuse })).rejects.toThrow(`not working yet`);
    expect(sent).toBe(1);
});

test(`a need the daemon already met is left alone`, async () => {
    let sent = 0;
    await applyNow({ current: () => ({ status: `met` }), apply: async () => void (sent += 1) });
    expect(sent).toBe(0);
});

test(`lenient: a connection still coming up does not fail the press`, async () => {
    let sent = 0;
    await applyNow(
        {
            current: () => undefined,
            apply: async () => {
                sent += 1;
                throw new Error(`not working yet`);
            },
        },
        true,
    );
    expect(sent).toBe(1);
});
