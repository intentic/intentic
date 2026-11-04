import { join } from "node:path";
import { settingsContract } from "@intentic/sandbox-contract/contracts/settings.contract";
import { effectiveAudience } from "@intentic/sandbox-contract/schemas/sandbox-mode";
import { implement } from "@orpc/server";
import type { OrpcContext } from "../app-env.js";
import type { Services } from "../composition.js";
import { opt } from "../opt.js";
import { fileMemberAudiences, memberAudienceDocument, type MemberAudiences } from "./member-audience.js";
import { memberOf } from "./member-of.js";

// THE WORDS A PERSON READS HERE: their own choice (member-audience.ts) when they made one, otherwise what the sandbox's
// mode speaks (sandbox-mode.ts). Only what that needs: the history root the choices are kept under, and the settings
// that carry the mode.
export const createAudienceRoutes = (services: Pick<Services, "config" | "sandboxSettings">) => {
    const i = implement(settingsContract).$context<OrpcContext>();
    // Opened on first use, not here: most settings routes never touch it, and a route under test may carry no config.
    let audiences: MemberAudiences | undefined;
    const memberAudiences = (): MemberAudiences =>
        (audiences ??= fileMemberAudiences(join(services.config.historyRoot, memberAudienceDocument.path)));
    return {
        // `audience` is always answered, so an app from before the mode adopts the sandbox's words instead of offering its
        // own; `override` and `mode` are what a newer one shows the choice by.
        audience: i.audience.handler(async ({ context }) => {
            const [override, { mode }] = await Promise.all([memberAudiences().get(memberOf(context)), services.sandboxSettings.get()]);
            return { audience: effectiveAudience(mode, override), mode, ...opt("override", override) };
        }),
        // A choice replaces the caller's own, null forgets it. An offer is what a browser from before the mode sends: the
        // answer it kept on its own, handed to every sandbox it opened. It is never taken, so one browser's answer stops
        // travelling to sandboxes it was never given for, and the words come back as this sandbox speaks them, which that
        // browser then adopts.
        setAudience: i.setAudience.handler(async ({ input, context }) => {
            const member = memberOf(context);
            const offered = input.offer === true;
            const [override, { mode }] = await Promise.all([
                offered ? memberAudiences().get(member) : memberAudiences().choose(member, input.audience ?? undefined),
                services.sandboxSettings.get(),
            ]);
            return { audience: effectiveAudience(mode, override), adopted: !offered, ...opt("override", override) };
        }),
    };
};
