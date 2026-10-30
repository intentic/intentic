import { WORKSPACE_ROOT } from "@intentic/constants";
import { parse } from "smol-toml";
import type { CodexTurn } from "../codex-app-server.js";
import { codexAppServerArgv } from "./codex-cli-config.js";

const turn = (provider: Pick<CodexTurn, "modelProvider" | "config">): CodexTurn => ({
    prompt: "hello",
    env: { CODEX_HOME: "/codex" },
    options: { workingDirectory: WORKSPACE_ROOT, sandboxMode: "danger-full-access", approvalPolicy: "never" },
    signal: new AbortController().signal,
    ...provider,
});

test.each(["translator", "intentic-zai"])("%s is selected and defined in app-server's startup config", (id) => {
    const provider = {
        name: 'A provider with "quotes" and\na second line',
        base_url: "http://127.0.0.1:8788/v1",
        wire_api: "responses",
        env_key: "CODEX_API_KEY",
        http_headers: { "x.route": "hosted", "x-openai-actor-authorization": "intentic" },
        supports_websockets: false,
    };
    const argv = codexAppServerArgv(
        "codex",
        turn({
            modelProvider: id,
            config: {
                [`model_providers.${id}`]: provider,
                "model_providers.unselected": { name: "another turn's route" },
                "mcp_servers.gate": { url: "http://127.0.0.1:9000/mcp" },
            },
        }),
    );

    expect(argv.command).toBe("codex");
    expect(argv.args.slice(0, 2)).toEqual(["app-server", "--stdio"]);
    expect(argv.args.filter((arg) => arg === "-c")).toHaveLength(2);
    const config = parse(
        argv.args
            .slice(2)
            .filter((arg) => arg !== "-c")
            .join("\n"),
    );
    expect(config).toEqual({ model_provider: id, model_providers: { [id]: provider } });
});

test("a provider already defined in CODEX_HOME still gets selected at startup", () => {
    expect(codexAppServerArgv("codex", turn({ modelProvider: "translator" }))).toEqual({
        command: "codex",
        args: ["app-server", "--stdio", "-c", 'model_provider="translator"'],
    });
});

test("a native turn leaves provider selection to Codex", () => {
    expect(codexAppServerArgv("codex", turn({}))).toEqual({ command: "codex", args: ["app-server", "--stdio"] });
});
