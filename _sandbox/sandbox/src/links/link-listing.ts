// One link card as `links` lists it for the agent: where it goes, whether that sandbox answers right now, the terms its
// tasks run under there, and whether its owner shares its records with this sandbox (`--on <link>`, its records tools).
export interface LinkListing {
    readonly to: string;
    readonly sandbox: string;
    readonly online: boolean;
    readonly why?: string;
    readonly persona?: string;
    readonly approve?: boolean;
    readonly turnsPerHour?: number;
    readonly records?: boolean;
}
