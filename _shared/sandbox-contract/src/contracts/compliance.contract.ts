import { procedure } from "../protocol/route-meta.js";
import {
    ComplianceDocumentQuerySchema,
    ComplianceDocumentSchema,
    ComplianceReportSchema,
    PresetApplyResultSchema,
    PresetApplySchema,
    PresetPreviewSchema,
} from "../schemas/compliance.js";

// The data protection page: where data can leave this sandbox, what protects it, the documents a data protection officer
// files about it, and the public-office preset. Maintainer and up, never an agent's or a panel's: the map of every
// outbound path is the reconnaissance an attacker would want, and the preset changes the policies the agent is held to.
// Applying the preset is the owner's alone, since it may turn on the privacy shield, which only the owner may change.
const maintainerRoute = procedure.meta({ floor: "maintainer", control: "never", panel: false });

export const complianceContract = {
    report: maintainerRoute
        .route({
            method: "GET",
            path: "/compliance",
            summary: "Where data can leave, and what protects it",
            description:
                "Every outbound path as configured right now (model providers, mail, team chat, connectors, speech, the web, the platform, updates, analytics), each with its destination, whether personal data can travel on it and whether the privacy shield covers it; and the technical and organisational measures with whether each is in place.",
        })
        .output(ComplianceReportSchema),
    document: maintainerRoute
        .route({
            method: "GET",
            path: "/compliance/document",
            summary: "A data protection document, filled in from this sandbox",
            description:
                "The record of processing activities entry, the data protection impact assessment draft, or the list of technical and organisational measures, in Polish or English, as Markdown or a Word document. What the sandbox knows is filled in; what only the office can say is left as a marked blank.",
        })
        .input(ComplianceDocumentQuerySchema)
        .output(ComplianceDocumentSchema),
    preset: maintainerRoute
        .route({
            method: "GET",
            path: "/compliance/preset",
            summary: "What the public-office preset would change",
            description:
                "Each stricter setting the preset proposes, with the value this sandbox has now beside it. Reading it changes nothing.",
        })
        .output(PresetPreviewSchema),
    applyPreset: procedure
        .meta({ floor: "owner", control: "never", panel: false })
        .route({
            method: "POST",
            path: "/compliance/preset",
            summary: "Apply chosen items of the public-office preset",
            description:
                "Applies only the items named, each to its proposed value, and leaves everything else as it is. An item already at its value, or one this sandbox cannot take (a name model that is not installed), is skipped and said so.",
        })
        .input(PresetApplySchema)
        .output(PresetApplyResultSchema),
};
