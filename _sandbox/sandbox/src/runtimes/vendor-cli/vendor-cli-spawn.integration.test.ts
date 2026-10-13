import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { methods, RequestError } from "@agentclientprotocol/sdk";
import { unstubbed } from "@intentic/testing";
import { createLogger } from "../../logger.js";
import { opt } from "../../opt.js";
import type { TerminalRunner } from "../../terminal/terminal-run.js";
import { createAcpConnections } from "../acp/acp-connection.js";
import { GROK_BUILD } from "../grok-build/grok-build-cli.js";
import { KIMI_CLI } from "../kimi-cli/kimi-cli.js";
import { releaseCliLogin, startCliLogin } from "./vendor-cli-login.js";
import { cliBinary, type VendorCli } from "./vendor-cli.js";

/* The real CLIs, where this machine has them: the launch line answers ACP as the records say, and a home with no sign-in
   is refused as signed out. Skipped where a CLI is not installed. INTENTIC_TEST_KIMI_BIN / INTENTIC_TEST_GROK_BIN point
   at a copy outside the engine store; INTENTIC_LIVE_CLI_LOGIN=1 also starts each vendor's real device login (it asks the
   vendor for a code, so it is off by default). */

const logger = createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" });

const installed = async (cli: VendorCli, override: string | undefined): Promise<string | undefined> => override ?? (await cliBinary(cli));

const CLIS = [
    { cli: KIMI_CLI, binary: await installed(KIMI_CLI, process.env["INTENTIC_TEST_KIMI_BIN"]) },
    { cli: GROK_BUILD, binary: await installed(GROK_BUILD, process.env["INTENTIC_TEST_GROK_BIN"]) },
];

describe.each(CLIS)("$cli.name", ({ cli, binary }) => {
    let home = "";
    beforeEach(async () => {
        home = await mkdtemp(join(tmpdir(), `${cli.runtime}-home-`));
    });
    afterEach(async () => {
        await rm(home, { recursive: true, force: true });
    });

    test.skipIf(binary === undefined)(
        "answers ACP with loadable sessions and http MCP, and refuses a signed-out home",
        async () => {
            const connections = createAcpConnections(logger, unstubbed<TerminalRunner>("terminal", { visible: false }));
            const id = `${cli.runtime}:test`;
            try {
                const launch = cli.launch(binary!, home);
                const connection = await connections.acquire(id, launch, home);
                expect(connection.capabilities.loadSession).toBe(true);
                expect(connection.capabilities.mcpCapabilities?.http).toBe(true);
                const opened = connection.agent.request(methods.agent.session.new, {
                    cwd: home,
                    mcpServers: [],
                    ...opt("_meta", launch.sessionMeta),
                });
                // The code the ACP floor turns into `acp-auth-required`, which the CLI loop reads as a sign-in to renew.
                await expect(opened).rejects.toMatchObject({ code: RequestError.authRequired().code });
            } finally {
                connections.drop(id);
            }
        },
        60_000,
    );

    test.skipIf(binary === undefined || process.env["INTENTIC_LIVE_CLI_LOGIN"] !== "1")(
        "its own device login offers a page and a code",
        async () => {
            const started = await startCliLogin(cli, binary!, home);
            try {
                expect(started.url).toMatch(/^https:\/\//);
                expect(started.url).toContain(started.code);
            } finally {
                await releaseCliLogin(started.handshake);
            }
        },
        60_000,
    );
});
