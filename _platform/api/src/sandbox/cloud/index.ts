import type { CloudCredentials, CloudOptions } from "@intentic-app/api-contract";
import type { CloudCreate } from "./common.js";
import { digitaloceanCreate, digitaloceanOptions } from "./digitalocean.js";
import { hetznerCreate, hetznerOptions } from "./hetzner.js";
import { oracleCreate, oracleOptions } from "./oracle.js";

// The provider switch the sandbox routes call, the only place the CloudCredentials union meets the three
// adapters, so a provider added to the contract fails to compile here until it is wired.

export const cloudOptions = (credentials: CloudCredentials): Promise<CloudOptions> => {
    switch (credentials.provider) {
        case `hetzner`:
            return hetznerOptions(credentials.token);
        case `digitalocean`:
            return digitaloceanOptions(credentials.token);
        case `oracle`:
            return oracleOptions(credentials.config, credentials.privateKey);
    }
};

export const cloudCreate = (credentials: CloudCredentials, create: CloudCreate): Promise<{ serverId: string }> => {
    switch (credentials.provider) {
        case `hetzner`:
            return hetznerCreate(credentials.token, create);
        case `digitalocean`:
            return digitaloceanCreate(credentials.token, create);
        case `oracle`:
            return oracleCreate(credentials.config, credentials.privateKey, create);
    }
};
