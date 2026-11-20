import { RemoteStartResultSchema } from "@intentic/sandbox-contract/schemas/device-remote";
import { type RemotedAnswer, type RemotedAsk, RemotedRefused, remotedControl } from "./remoted-control.js";

// remoted's control routes as its http.rs answers them, read into what the daemon and the contract hold.

const answering =
    (answers: Readonly<Record<string, RemotedAnswer>>): RemotedAsk =>
    async (_socket, method, path) =>
        answers[`${method} ${path}`];

test("/info is read as remoteStart answers it, whatever else remoted says beside it", async () => {
    const said = {
        version: "1.2.3",
        monitors: [{ id: "0", name: "DP-1", x: 0, y: 0, width: 2560, height: 1440, scale: 1, primary: true, refreshHz: 144 }],
        environments: ["native", "wsl:archlinux"],
        encoders: ["h264"],
        allow: { view: true, control: false, terminal: true },
        paused: false,
    };
    const info = await remotedControl("/x.sock", answering({ "GET /info": { status: 200, body: JSON.stringify(said) } })).info();
    expect(RemoteStartResultSchema.parse(info)).toEqual({
        version: "1.2.3",
        monitors: [{ id: "0", name: "DP-1", x: 0, y: 0, width: 2560, height: 1440, scale: 1, primary: true }],
        environments: ["native", "wsl:archlinux"],
        allow: { view: true, control: false, terminal: true },
    });
});

test("terminals are listed and made as remoted names them, and a refusal carries its words", async () => {
    const listed = { session: "t-1", title: "bash", environment: "native", createdAt: 1_700_000_000_000, viewers: 2 };
    const control = remotedControl(
        "/x.sock",
        answering({
            "GET /terminals": { status: 200, body: JSON.stringify([listed]) },
            "POST /terminals": { status: 429, body: JSON.stringify({ error: "16 terminals at most for one sandbox on this computer" }) },
        }),
    );
    expect(await control.terminals()).toEqual([listed]);
    const refused = await control.openTerminal({ session: "t-2", cols: 80, rows: 24 }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(RemotedRefused);
    expect(refused instanceof RemotedRefused ? [refused.status, refused.message] : []).toEqual([429, "16 terminals at most for one sandbox on this computer"]);
});
