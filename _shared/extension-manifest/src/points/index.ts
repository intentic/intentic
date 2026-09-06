import { z } from "zod";
import type { ContributionPoint } from "../contribution-point.js";
import { agentPoint } from "./agent.js";
import { automationTemplatesPoint } from "./automation-templates.js";
import { binPoint } from "./bin.js";
import { capabilitiesPoint } from "./capabilities.js";
import { commandsPoint } from "./commands.js";
import { documentsPoint } from "./documents.js";
import { environmentPoint } from "./environment.js";
import { filesPoint } from "./files.js";
import { listenerPoint } from "./listener.js";
import { processesPoint } from "./processes.js";
import { settingsPoint } from "./settings.js";
import { viewersPoint } from "./viewers.js";
import { viewsPoint } from "./views.js";

export * from "./agent.js";
export * from "./automation-templates.js";
export * from "./bin.js";
export * from "./capabilities.js";
export * from "./commands.js";
export * from "./documents.js";
export * from "./environment.js";
export * from "./files.js";
export * from "./listener.js";
export * from "./processes.js";
export * from "./settings.js";
export * from "./viewers.js";
export * from "./views.js";

/* EVERYTHING A MANIFEST MAY DECLARE. `contributes` is assembled from this list (manifest.ts), the authoring
 * JSON Schema is generated from it (json-schema.ts), and the SDK's surface guard reads the point names back out
 * of it, so the three cannot disagree about what this build supports.
 *
 * Collected explicitly rather than by a module-load side effect, because two readers need the answer to be the
 * same every time it is asked: the wire contract's lock file, which is a committed document a diff has to be
 * able to guard, and the generated schema, which is committed too. A registry that filled itself as modules
 * happened to load would make both of those depend on import order.
 *
 * Adding a point is a file in this directory and a line here, points.test.ts fails when a file appears without
 * the line, so the pair cannot come apart. */
export const CONTRIBUTION_POINTS = [
    viewsPoint,
    filesPoint,
    viewersPoint,
    documentsPoint,
    commandsPoint,
    settingsPoint,
    processesPoint,
    agentPoint,
    environmentPoint,
    capabilitiesPoint,
    listenerPoint,
    automationTemplatesPoint,
    binPoint,
] as const satisfies readonly ContributionPoint[];

// The `contributes` shape those points assemble to: each point's key, its schema, optional. A mapped type
// rather than a widened record so `manifest.contributes.views` keeps its exact type at every call site, the
// whole point of the schema being typed at all.
type ContributesShape = {
    [Point in (typeof CONTRIBUTION_POINTS)[number] as Point["name"]]: z.ZodOptional<Point["schema"]>;
};

/* The `contributes` object, assembled rather than hand-written, which is what makes adding a point a file plus
 * a line above, instead of an edit to a schema thirteen unrelated features share.
 *
 * Each point's description rides `z.describe` onto its own key, so it survives into the generated authoring
 * schema and reaches the author as hover text. The cast is the one place the value side and the type side meet:
 * `Object.fromEntries` can only say `Record<string, …>`, and ContributesShape is that said precisely. */
export const contributesSchema = z.object(
    Object.fromEntries(CONTRIBUTION_POINTS.map((point) => [point.name, point.schema.describe(point.description).optional()])) as ContributesShape,
);
