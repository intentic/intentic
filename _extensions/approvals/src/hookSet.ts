import type { HookModule, HookPlugin, HookRequest } from "@intentic/sandbox-contract";
import { t } from "./i18n.js";

/* A hook set's plugins in plain words: what a plugin's hooks module does, read off the events it hooks and the methods
 * it calls (Claude Code's own `plugin validate`, run by the daemon), so the owner approves powers rather than method
 * names. The raw lists stay on the card beneath the sentence. */

// What saying yes lets run, counted the way the title reads it: each hook (a module is one), plus each plugin and
// marketplace the settings bring in, which are in the set without a hook of their own.
export const hookSetSize = (request: HookRequest): number =>
    request.hooks.length + (request.plugins ?? []).filter((plugin) => plugin.from === `settings`).length + (request.marketplaces?.length ?? 0);

// Each power in the order the sentence names them, with what in the module's lists shows it.
const POWERS: readonly { readonly key: string; readonly label: () => string; readonly shown: (hooks: readonly string[], calls: readonly string[]) => boolean }[] = [
    { key: `startsPrograms`, label: () => t(`hookSetBody.powers.startsPrograms`), shown: (_, calls) => calls.some((call) => call.startsWith(`$.process.`)) },
    { key: `networkRequests`, label: () => t(`hookSetBody.powers.networkRequests`), shown: (_, calls) => calls.some((call) => call.startsWith(`$.http.`) || call.startsWith(`$.net.`)) },
    { key: `readsEnvironment`, label: () => t(`hookSetBody.powers.readsEnvironment`), shown: (_, calls) => calls.some((call) => call.startsWith(`$.env.`)) },
    { key: `changesFiles`, label: () => t(`hookSetBody.powers.changesFiles`), shown: (_, calls) => calls.some((call) => call.startsWith(`$.fs.`) && /write|remove|delete|mkdir|move|rename|append|copy/iu.test(call)) },
    { key: `readsFiles`, label: () => t(`hookSetBody.powers.readsFiles`), shown: (_, calls) => calls.some((call) => call.startsWith(`$.fs.`) && !/write|remove|delete|mkdir|move|rename|append|copy/iu.test(call)) },
    { key: `decidesToolCalls`, label: () => t(`hookSetBody.powers.decidesToolCalls`), shown: (hooks) => hooks.some((hook) => /^(?:tool\.(?:call|check|permission)|classic\.PreToolUse)\b/u.test(hook)) },
    { key: `rewritesSystemPrompt`, label: () => t(`hookSetBody.powers.rewritesSystemPrompt`), shown: (hooks) => hooks.some((hook) => hook.startsWith(`prompt.compose`)) },
    { key: `changesMessages`, label: () => t(`hookSetBody.powers.changesMessages`), shown: (hooks) => hooks.some((hook) => hook.startsWith(`prompt.submit`)) },
    { key: `callsTools`, label: () => t(`hookSetBody.powers.callsTools`), shown: (_, calls) => calls.some((call) => call.startsWith(`$.tool.`)) },
    { key: `startsSubagents`, label: () => t(`hookSetBody.powers.startsSubagents`), shown: (_, calls) => calls.some((call) => call.startsWith(`$.agent.`)) },
    { key: `asksModel`, label: () => t(`hookSetBody.powers.asksModel`), shown: (_, calls) => calls.some((call) => call.startsWith(`$.model.`)) },
];

// The keys of what the module can do, by its lists; empty when they show none of the powers named above.
export const modulePowers = (module: Pick<HookModule, `hooks` | `calls`>): string[] =>
    POWERS.filter((power) => power.shown(module.hooks, module.calls)).map((power) => power.key);

// The one sentence the card leads a module with.
export const moduleSentence = (module: HookModule): string => {
    if (module.unreadable !== undefined) {
        return t(`hookSetBody.runsCodeUnreadable`, { reason: module.unreadable });
    }
    const powers = POWERS.filter((power) => power.shown(module.hooks, module.calls)).map((power) => power.label());
    return powers.length === 0 ? t(`hookSetBody.runsCode`) : t(`hookSetBody.runsCodeDoing`, { powers: powers.join(`, `) });
};

// Where a plugin came from, as its line on the card names it.
export const pluginOrigin = (plugin: HookPlugin): string => {
    const where = plugin.source === `user` ? t(`hookSetBody.fromUserSettings`) : t(`hookSetBody.fromProjectSettings`);
    switch (plugin.from) {
        case `settings`:
            return t(`hookSetBody.enabledIn`, { where });
        case `skills`:
            return t(`hookSetBody.fromSkills`);
        case `extension`:
            return t(`hookSetBody.fromExtension`);
        case `persona`:
            return t(`hookSetBody.fromPersona`);
        case `plugin`:
            return t(`hookSetBody.fromPlugin`);
    }
};
