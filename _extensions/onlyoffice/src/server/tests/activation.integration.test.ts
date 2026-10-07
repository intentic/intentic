import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import { type FakeExtension, fakeExtensionApi } from "@intentic/extension-api/testing";
import { STATE_DIR } from "@intentic/sandbox-contract";
import { manifest } from "../../manifest.js";
import * as server from "../server.js";

// The backend as the host activates it, on the SDK's fake daemon (@intentic/extension-api/testing), which refuses any
// route the manifest does not declare, as the daemon would.

let extension: FakeExtension | undefined;
afterEach(async () => {
    await extension?.deactivate();
    await extension?.dispose();
    extension = undefined;
});

const exists = (path: string): Promise<boolean> => access(path).then(
    () => true,
    () => false,
);

// Whether anything still accepts a connection on the port.
const accepting = (port: number): Promise<boolean> =>
    new Promise((resolve) => {
        const socket = connect(port, "127.0.0.1");
        socket.once("connect", () => {
            socket.destroy();
            resolve(true);
        });
        socket.once("error", () => resolve(false));
    });

test("it moves what an earlier version kept into its own directories, reads its settings undeclared, and lets go on deactivate", async () => {
    extension = await fakeExtensionApi({ manifest, settings: { engine: "browser", autoStart: false } });
    const legacy = join(extension.api.workspaceRoot, STATE_DIR, "local", "onlyoffice");
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, "jwt-secret"), "kept-secret\n");

    await extension.activate(server);

    // The same secret, so a document server already holding it is adopted rather than recreated.
    expect(await readFile(join(extension.api.stateDir, "jwt-secret"), "utf8")).toBe("kept-secret\n");
    expect(await exists(legacy)).toBe(false);
    expect(extension.calls).toEqual([{ line: "GET /extension/settings", admitted: true }]);
    expect((await extension.route("/status?engine=browser")).status).toBe(200);

    const port = Number((await readFile(join(extension.api.stateDir, "listener-port"), "utf8")).trim());
    expect(await accepting(port)).toBe(true);
    await extension.deactivate();
    expect(await accepting(port)).toBe(false);
});
