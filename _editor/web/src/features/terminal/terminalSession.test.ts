// A session whose socket couldn't be authorized must stay on its retry ladder: nothing else ever reconnects it.
const socketAddress = jest.fn<() => Promise<{ base: string; query: string } | undefined>>();
jest.mock("../sandbox/session/wsTicket", () => ({ socketAddress }));

const { createTerminalSession, disposeTerminalSession } = await import("./terminalSession");
const { signalConnection } = await import("../../client/sandbox/useSandbox");

const settled = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 0));
};

it(`schedules a reconnect when minting the socket's session throws, instead of giving up for good`, async () => {
    socketAddress.mockRejectedValueOnce(new Error(`The sandbox did not finish signing in within 10 seconds.`));
    const warn = jest.spyOn(console, `warn`).mockImplementation(() => undefined);
    const session = createTerminalSession(`web-1`, () => undefined);
    await settled();
    expect({ asked: socketAddress.mock.calls.length, retrying: session.live.retrying(), down: session.down }).toEqual({
        asked: 1,
        retrying: true,
        down: true,
    });
    disposeTerminalSession(session);
    warn.mockRestore();
});

// The ladder climbs to half a minute; a terminal still waiting out a rung when the sandbox answers again must not stay
// dark for the rest of it.
it(`reconnects at once when the sandbox becomes reachable again, rather than waiting out its rung`, async () => {
    socketAddress.mockRejectedValueOnce(new Error(`The sandbox is restarting.`));
    const warn = jest.spyOn(console, `warn`).mockImplementation(() => undefined);
    const session = createTerminalSession(`web-2`, () => undefined);
    await settled();
    const asked = socketAddress.mock.calls.length;

    // A frame on the events stream: the sandbox is online again.
    signalConnection({ kind: `frame`, at: Date.now() });
    await settled();

    expect(socketAddress.mock.calls.length).toBe(asked + 1);
    disposeTerminalSession(session);
    warn.mockRestore();
});
