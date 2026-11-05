import { VAULTED } from "@intentic/sandbox-contract/policy/capability-secrets";
import { opt } from "../../opt.js";
import { endpointHandler } from "./endpoint.handler.js";

// What the capability list tells the browser about a model endpoint's key: that there is one, and for a vendor's key the
// last four characters a provider's card names it by. Never the key, and nothing of a short one.

const echo = (apiKey?: string) =>
    endpointHandler.echo({ baseUrl: `https://api.anthropic.com`, protocol: `anthropic`, ...opt(`apiKey`, apiKey) }, new Map());

test("a vendor's key is named by its last four characters, and nothing more of it travels", () => {
    const key = `sk-ant-api03-${`x`.repeat(80)}a3f9`;
    const config = echo(key);
    expect(config).toMatchObject({ hasSecret: true, keyHint: `a3f9` });
    expect(JSON.stringify(config)).not.toContain(key.slice(0, -4));
});

test("a short key, the vault's own marker and no key are not hinted at", () => {
    expect(echo(`ollama`)).not.toHaveProperty(`keyHint`);
    expect(echo(VAULTED)).not.toHaveProperty(`keyHint`);
    expect(echo()).toEqual({ baseUrl: `https://api.anthropic.com`, protocol: `anthropic`, hasSecret: false });
});
