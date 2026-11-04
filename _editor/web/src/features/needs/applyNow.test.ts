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

test(`a refusal for a need the daemon met while this editor still read it open is no failure`, async () => {
    let read = 0;
    await applyNow({
        current: () => ({ status: `open` }),
        apply: async () => {
            throw new Error(`That need is already met: Docker is connected as "docker".`);
        },
        fresh: async () => {
            read += 1;
            return { status: `met` };
        },
    });
    expect(read).toBe(1);
});

test(`a refusal the daemon's fresh copy still reads open fails the press`, async () => {
    const refuse = async (): Promise<never> => {
        throw new Error(`not working yet`);
    };
    await expect(applyNow({ current: () => ({ status: `open` }), apply: refuse, fresh: async () => ({ status: `open` }) })).rejects.toThrow(`not working yet`);
    await expect(applyNow({ current: () => ({ status: `open` }), apply: refuse, fresh: async () => { throw new Error(`offline`); } })).rejects.toThrow(`not working yet`);
});

test(`a need already declined or withdrawn is left alone`, async () => {
    let sent = 0;
    for (const status of [`declined`, `cancelled`] as const) {
        await applyNow({ current: () => ({ status }), apply: async () => void (sent += 1) });
    }
    expect(sent).toBe(0);
});
