// A session whose socket couldn't be authorized must stay on its retry ladder: nothing else ever reconnects it.
const socketAddress = jest.fn<() => Promise<{ base: string; query: string } | undefined>>();
jest.mock("../sandbox/session/wsTicket", () => ({ socketAddress }));

const { createTerminalSession, disposeTerminalSession } = await import("./terminalSession");

const settled = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 0));
};

it(`schedules a reconnect when minting the socket's session throws, instead of giving up for good`, async () => {
    socketAddress.mockRejectedValueOnce(new Error(`The sandbox did not finish signing in within 10 seconds.`));
    const warn = jest.spyOn(console, `warn`).mockImplementation(() => undefined);
    const session = createTerminalSession(`web-1`, () => undefined);
    await settled();
    expect({ asked: socketAddress.mock.calls.length, retrying: session.reconnect !== undefined, down: session.down }).toEqual({
        asked: 1,
        retrying: true,
        down: true,
    });
    disposeTerminalSession(session);
    warn.mockRestore();
});
