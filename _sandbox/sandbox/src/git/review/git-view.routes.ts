import { provenanceOf, refuseUnlessVisible } from "../../auth/fleet-scope.js";
import { call, getRouter, isProcedure, ORPCError } from "@orpc/server";
import { GitViewQuerySchema, type GitView } from "@intentic/sandbox-contract/schemas/git/git-view";
import type { Services } from "../../composition.js";
import type { routesInView } from "../git.routes.js";
import { gitImplementer } from "../index.routes.js";
import { gitViewKey } from "./git-view.js";
import { opt } from "../../opt.js";

export const gitRoutesInViews = (services: Pick<Services, "agents">, build: (view?: GitView) => ReturnType<typeof routesInView>) => {
    const shared = build();
    const views = new Map<string, ReturnType<typeof routesInView>>();
    return gitImplementer().use(async ({ context, path, next, signal }, input, output) => {
        const parsed = GitViewQuerySchema.safeParse(input ?? {});
        if (!parsed.success) {
            throw new ORPCError("BAD_REQUEST", { message: "Invalid checkout selection." });
        }
        const view = parsed.success ? parsed.data.view : undefined;
        if (view?.agent !== undefined) {
            const entry = services.agents.entry(view.agent);
            if (entry !== undefined) { refuseUnlessVisible(context.identity, provenanceOf(entry)); }
        }
        const key = gitViewKey(view);
        if (key === "" || view === undefined) {
            return next();
        }
        let routes = views.get(key);
        if (routes === undefined) {
            routes = build(view);
            views.set(key, routes);
        }
        const name = path.at(-1);
        const route = name === undefined ? undefined : getRouter(routes, [name]);
        if (!isProcedure(route)) {
            throw new ORPCError("NOT_FOUND");
        }
        return output(await call(route, input, { context, ...opt("signal", signal) }));
    }).router(shared);
};
