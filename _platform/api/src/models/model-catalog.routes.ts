import { Hono } from "hono";
import { ingressServer } from "../ingress.js";
import type { BrowsingCatalogStore } from "./model-catalog.js";
import { browseModels } from "./model-catalog.js";
import type { CatalogSource } from "./catalog-sources.js";

export const modelCatalogRoutes = (store: BrowsingCatalogStore, sources: readonly CatalogSource[]) => {
    const app = new Hono();
    ingressServer(app)(`modelCatalog`, async (c, kit) => {
        c.header(`Cache-Control`, `public, max-age=300`);
        return kit.answer(await browseModels(store, sources));
    });
    return app;
};
