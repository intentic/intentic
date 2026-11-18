import type { ChatRoute, ChatRouteAsk } from "@intentic/sandbox-contract/schemas/chat-route";
import { noModels } from "../../mode";
import { demoClaudeAccount } from "../account/accounts";
import { demoRoles } from "../extensions/roles";

// The reading a new chat gets between send and its first turn (the daemon's chat-router.ts), answered here the way its
// routing model answers: a role whose ground the message stands on, and a model sized to the work. It never holds
// a chat up: with nothing to choose from it answers nothing, with a reason.

// What each of the demo's roles is for, in the words a message about its work tends to use.
const ROLE_WORDS = new Map<string, readonly string[]>([
    [`maya-support`, [`support`, `ticket`, `refund`, `customer`, `reply`, `macro`, `intercom`, `inbox`]],
    [`owen-growth`, [`tweet`, `post`, `linkedin`, `campaign`, `launch`, `newsletter`, `audience`, `social`]],
    [`priya-ops`, [`deploy`, `pipeline`, `release`, `stripe`, `incident`, `uptime`, `infra`]],
]);

const roleVerdict = (ask: ChatRouteAsk): NonNullable<ChatRoute[`role`]> => {
    const where = [ask.folder, ...ask.paths].filter((path) => path !== undefined);
    const byFolder = demoRoles.find((role) => {
        const startIn = role.workspace?.startIn;
        return startIn !== undefined && where.some((path) => path.startsWith(startIn));
    });
    if (byFolder !== undefined) {
        return { id: byFolder.id, reason: `It is about ${byFolder.workspace?.startIn ?? `its folder`}, ${byFolder.label}'s ground.` };
    }
    const words = ask.prompt.toLowerCase();
    const byWords = demoRoles.find((role) => (ROLE_WORDS.get(role.id) ?? []).some((word) => words.includes(word)));
    return byWords === undefined
        ? { reason: `Nothing in it belongs to one role's work, so the chat stays open to every account.` }
        : { id: byWords.id, reason: `It reads as ${byWords.label}'s work.` };
};

// Small questions go on the quick model, real code and plans on the strongest, both on the account with most room.
const modelVerdict = (ask: ChatRouteAsk): NonNullable<ChatRoute[`model`]> => {
    if (noModels) {
        return { reason: `Nothing here can run a chat yet: connect an account or add an endpoint first.` };
    }
    const account = demoClaudeAccount().id;
    const heavy = ask.planMode === true || ask.editorContext === true || ask.paths.length > 0 || ask.prompt.length > 280;
    return heavy
        ? { pick: { provider: `claude`, model: `claude-opus-5`, effort: `high`, account }, reason: `It touches real code, so it runs on the strongest model with room left.` }
        : { pick: { provider: `claude`, model: `claude-sonnet-5`, effort: `medium`, account }, reason: `A short ask: a fast model answers it as well.` };
};

export const routeChat = (ask: ChatRouteAsk): ChatRoute => {
    const route: ChatRoute = {};
    if (ask.role) {
        route.role = roleVerdict(ask);
    }
    if (ask.model) {
        route.model = modelVerdict(ask);
    }
    // A folder match or nothing to choose from spends nothing; anything else was one call to the routing model.
    if ((ask.model && !noModels) || (route.role !== undefined && route.role.id === undefined && ask.role)) {
        route.judge = `claude:claude-haiku-4-5-20251001`;
    }
    return route;
};
