import { join } from "node:path";
import { settingsContract } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import { forkablePrompt, intenticSystemPrompt } from "../agent/prompt/intentic-prompt.js";
import { presetSystemPrompt } from "../agent/prompt/preset-prompt.js";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../app-env.js";
import { readInputSavings } from "../logs/filter-stats.js";
import { declaredRepoChecks, readRepoDeclaration, summariesOf } from "../rules/repo-checks.js";
import { ManifestUnreadableError } from "../store/json-file.js";
import { readTurnExperiments } from "../usage/turn-experiments.js";
import { fieldNotesStatus } from "./field-notes-status.js";
import { fileMemberAudiences, memberAudienceDocument, type MemberAudiences } from "./member-audience.js";
import { settingsDocument } from "./settings-store.js";
import { versionedSettingsWrite } from "../seams/settings-versions.js";
import { reconcileBakedSkills } from "./skills.js";

// `get` applies defaults when the manifest is absent, `set` overwrites it. `savings` reads whichever backend's ledger
// is currently compressing: the setting picking the cleaner also picks the ledger read here.
// Whose answer a call reads and writes: the verified address, and "" for the one person of a sandbox nobody signs in to.
const memberOf = (context: OrpcContext): string => context.identity?.email.toLowerCase() ?? "";

export const createSettingsRoutes = (services: Services) => {
    const i = implement(settingsContract).$context<OrpcContext>();
    // Opened on first use, not here: most of these routes never touch it, and a route under test may carry no config.
    let audiences: MemberAudiences | undefined;
    const memberAudiences = (): MemberAudiences =>
        (audiences ??= fileMemberAudiences(join(services.config.historyRoot, memberAudienceDocument.path)));
    // Every settings.json write here is a page's own (the Agent tab, the checks list) or the app's (a browser's clock), so
    // each is committed as it lands (settings-versions.ts): left uncommitted, a land touching the file was refused as the
    // owner's edits. Not when the file already held uncommitted edits: those may be the owner's own, by hand.
    const versioned = <T>(subject: string, write: () => Promise<T>): Promise<T> =>
        versionedSettingsWrite(services, [settingsDocument.path], `Settings: ${subject}`, write);
    return {
        get: i.get.handler(() => services.sandboxSettings.get()),
        set: i.set.handler(async ({ input }) => {
            await versioned("agent settings", () => services.sandboxSettings.set(input)).catch((error: unknown) => {
                // The owner's file to fix, not a server fault: the message names it and what this build could not read.
                if (error instanceof ManifestUnreadableError) {
                    throw new ORPCError("CONFLICT", { message: error.message });
                }
                throw error;
            });
            // Converges the baked tools with the new list for the next turn; a failed write only warns, the save still
            // succeeds.
            await reconcileBakedSkills(services, input.skills).catch((error: unknown) => services.logger.warn({ err: error }, "skill reconcile failed"));
            return { ok: true } as const;
        }),
        fieldNotes: i.fieldNotes.handler(() => fieldNotesStatus(services)),
        // Take-if-empty, never overwrite: this is called by every browser that opens the workspace, and the second one
        // must not move the first one's chores onto its own clock. An owner changing their mind goes through `set`.
        adoptTimezone: i.adoptTimezone.handler(async ({ input }) => {
            const settings = await services.sandboxSettings.get();
            if (settings.timezone !== "") {
                return { timezone: settings.timezone, adopted: false };
            }
            await versioned(`timezone ${input.timezone}`, () => services.sandboxSettings.set({ ...settings, timezone: input.timezone }));
            services.logger.info({ timezone: input.timezone }, "sandbox timezone adopted from a browser");
            return { timezone: input.timezone, adopted: true };
        }),
        // The caller's own words, by the address they signed in with. An answer replaces theirs; an offer (a browser
        // handing over what it kept on its own) is taken only while they have none, so their second device adopts the
        // first one's words instead of overwriting them.
        audience: i.audience.handler(async ({ context }) => {
            const audience = await memberAudiences().get(memberOf(context));
            return audience === undefined ? {} : { audience };
        }),
        setAudience: i.setAudience.handler(({ input, context }) => memberAudiences().answer(memberOf(context), input.audience, input.offer === true)),
        savings: i.savings.handler(async ({ input }) => {
            const [inputSavings, experiments] = await Promise.all([
                readInputSavings(services.config.historyRoot, input),
                readTurnExperiments(services.usage, input),
            ]);
            return { input: inputSavings, ...experiments };
        }),
        // Both are read from the installed CLI for its default model, Intentic's cut from Claude's; the workspace root only
        // says where to spawn that probe, nothing is read from it. Handed over as the copy a person reads and forks, so
        // without the lines the CLI renders for its own run (forkablePrompt).
        builtinPrompt: i.builtinPrompt.handler(async ({ input }) =>
            forkablePrompt(
                await (input.base === "intentic" ? intenticSystemPrompt(services.workspace.root) : presetSystemPrompt(services.workspace.root)),
            ),
        ),
        // When each rule last fired, so the settings list can show a rule that's gone quiet as quiet rather than merely
        // present.
        firings: i.firings.handler(() => services.ruleFirings.get()),
        // Read off the repositories every time rather than cached: the declaration is a tracked file that a commit, a
        // pull or an agent can change between two openings of this screen.
        repoChecks: i.repoChecks.handler(async () => {
            const [declarations, settings, firings] = await Promise.all([
                declaredRepoChecks(services.workspace.root),
                services.sandboxSettings.get(),
                services.ruleFirings.get(),
            ]);
            return { repos: summariesOf(declarations, settings.adoptedChecks, firings) };
        }),
/* ADOPTION: the owner's answer to what a repository asks for, recorded against the fingerprint of what it asks for NOW. */
        adoptRepoChecks: i.adoptRepoChecks.handler(async ({ input }) => {
            const settings = await services.sandboxSettings.get();
            const adopted = { ...settings.adoptedChecks };
            if (input.on) {
                const declaration = await readRepoDeclaration(services.workspace.root, input.repo);
                if (declaration === undefined || declaration.checks.length === 0) {
                    throw new ORPCError("NOT_FOUND", { message: `${input.repo} does not declare any checks to switch on.` });
                }
                adopted[input.repo] = declaration.fingerprint;
            } else {
                delete adopted[input.repo];
            }
            await versioned(`checks ${input.on ? "on" : "off"} for ${input.repo}`, () => services.sandboxSettings.set({ ...settings, adoptedChecks: adopted }));
            services.logger.info({ repo: input.repo, on: input.on }, "repo checks: adoption changed");
            return { ok: true } as const;
        }),
    };
};
