import type { HookRequest } from "@intentic/sandbox-contract";
import { registerExtensionMessages } from "@intentic/extension-ui/i18n";
import { extensionIdOf } from "@intentic/extension-manifest";
import { hookSetSize, modulePowers, moduleSentence, pluginOrigin } from "./hookSet.js";
import { messages } from "./i18n.js";
import { manifest } from "./manifest.js";

await registerExtensionMessages(extensionIdOf(manifest), messages);

describe(`modulePowers`, () => {
    it(`reads a module's lists as the powers the card names, in the sentence's order`, () => {
        expect(
            modulePowers({
                hooks: [`tool.call{tool=Bash}`, `prompt.compose`, `session.start`],
                calls: [`$.http.fetch`, `$.fs.write`, `$.process.spawn`, `$.env.get`, `$.fs.read`, `$.ui.status`],
            }),
        ).toEqual([`startsPrograms`, `networkRequests`, `readsEnvironment`, `changesFiles`, `readsFiles`, `decidesToolCalls`, `rewritesSystemPrompt`]);
    });

    it(`names nothing for a module that only draws`, () => {
        expect(modulePowers({ hooks: [`ui.render{component=AbovePrompt}`], calls: [`$.ui.status`] })).toEqual([]);
    });
});

describe(`moduleSentence`, () => {
    it(`says in plain words what the module does`, () => {
        expect(moduleSentence({ path: `./register.ts`, hooks: [`session.start`], calls: [`$.process.run`, `$.http.fetch`] })).toBe(
            `This plugin runs code inside Claude Code: it starts programs, makes network requests.`,
        );
    });

    it(`still says it runs code when its lists show no named power`, () => {
        expect(moduleSentence({ path: `./register.ts`, hooks: [`session.start`], calls: [] })).toBe(
            `This plugin runs code inside Claude Code, with everything the agent's session can reach.`,
        );
    });

    it(`says a module could not be read, and that a yes runs it anyway`, () => {
        expect(moduleSentence({ path: `./register.ts`, hooks: [], calls: [], unreadable: `it does not parse` })).toBe(
            `This plugin runs code inside Claude Code, and what that code does could not be read (it does not parse). Approving lets it run all the same.`,
        );
    });
});

describe(`a hook set's size and its plugins`, () => {
    const request = (over: Partial<HookRequest>): HookRequest => ({ digest: `d`.repeat(64), seenAt: 1, hooks: [], scripts: [], ...over });

    it(`counts each hook, and each plugin and marketplace the settings bring in without a hook of their own`, () => {
        expect(
            hookSetSize(
                request({
                    hooks: [{ source: `plugin`, plugin: `p`, event: `*`, type: `module`, run: `./register.ts` }],
                    plugins: [
                        { name: `p`, from: `extension` },
                        { name: `helper@tools`, from: `settings`, source: `project` },
                    ],
                    marketplaces: [{ source: `project`, name: `tools`, location: `acme/tools` }],
                }),
            ),
        ).toBe(3);
    });

    it(`names where a plugin came from`, () => {
        expect(pluginOrigin({ name: `helper@tools`, from: `settings`, source: `user` })).toBe(`enabled in ~/.claude/settings.json`);
        expect(pluginOrigin({ name: `Deploy`, from: `extension` })).toBe(`brought by an extension`);
    });
});
