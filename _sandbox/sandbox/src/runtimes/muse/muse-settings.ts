import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { humanizeModelId } from "@intentic/sandbox-contract";
import { opt } from "../../opt.js";
import { engineDir } from "../../engines/engine-store.js";

// What aims Muse Code at a model API other than Meta's: its Meta provider speaks the OpenAI Responses wire, and a
// settings file can move that provider's base URL (`endpoint_transport`) and list the models it serves (`model_catalog`,
// read back on model/list as `configCatalog`). The key rides META_API_KEY as for Meta, sent as a bearer only because the
// settings pin `auth: "bearer"`: Muse withholds it from any base its own front door does not sanction otherwise.
//
// Settings rather than flags because `muse serve` reads `endpoint_transport` from the file alone (Muse Code 1.4.6: a `-c`
// override reaches the host's own model list but never a session's provider). Read from XDG_CONFIG_HOME/muse, so each
// endpoint gets a directory of its own, written once and keyed by its content; under the engine store, the one daemon
// directory every turn's namespace sees (read-only), as it already must to run the binary.

export interface MuseEndpoint {
    // The Responses root Muse appends `/responses` to, version segment included (the translator's `/v1`).
    readonly baseUrl: string;
    // The id Muse sends as the request's model.
    readonly model: string;
    readonly label?: string | undefined;
    readonly contextLimit?: number | undefined;
}

// The model-catalog profile Muse's Meta provider runs under (Muse Code 1.4.6); a catalog row naming any other is
// dropped with "profile does not match session".
const MUSE_PROFILE = "tbh";

export const museEndpointSettings = (endpoint: MuseEndpoint) => ({
    schema_version: 1,
    endpoint_transport: { base_url: endpoint.baseUrl, auth: "bearer" },
    model: endpoint.model,
    model_catalog: [
        {
            model_id: endpoint.model,
            provider_id: "meta",
            profile_id: MUSE_PROFILE,
            display_label: endpoint.label ?? humanizeModelId(endpoint.model),
            is_default: true,
            ...opt("context_limit", endpoint.contextLimit),
        },
    ],
});

/** The XDG_CONFIG_HOME whose `muse/settings.json` aims Muse at this endpoint, written if it is not there yet. */
export const museEndpointConfigHome = async (endpoint: MuseEndpoint, root: string = join(engineDir("muse"), "endpoints")): Promise<string> => {
    const text = `${JSON.stringify(museEndpointSettings(endpoint), undefined, 2)}\n`;
    const home = join(root, createHash("sha256").update(text).digest("hex").slice(0, 16));
    const dir = join(home, "muse");
    await mkdir(dir, { recursive: true });
    // Renamed into place, so a host starting beside the writer never reads half a file.
    const staged = join(dir, `.settings-${String(process.pid)}.json`);
    await writeFile(staged, text, { mode: 0o644 });
    await rename(staged, join(dir, "settings.json"));
    return home;
};
