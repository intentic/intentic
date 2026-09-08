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

// Everything a manifest may declare. `contributes` (manifest.ts), the authoring schema (json-schema.ts) and the SDK's
// surface guard are all generated from this list, so the three can't disagree about what this build supports. Adding a
// point is a file plus a line here; points.test.ts fails if they come apart.
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

// The `contributes` shape those points assemble to. A mapped type rather than a widened record, so
// `manifest.contributes.views` keeps its exact type at every call site.
type ContributesShape = {
    [Point in (typeof CONTRIBUTION_POINTS)[number] as Point["name"]]: z.ZodOptional<Point["schema"]>;
};

// The `contributes` object, assembled rather than hand-written, so adding a point is a file plus a line above. Each
// point's description rides `z.describe` onto its own key, reaching the generated authoring schema as hover text.
export const contributesSchema = z.object(
    Object.fromEntries(CONTRIBUTION_POINTS.map((point) => [point.name, point.schema.describe(point.description).optional()])) as ContributesShape,
);
