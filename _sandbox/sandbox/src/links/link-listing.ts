// One link card as `links` lists it for the agent: where it goes, whether that sandbox answers right now, the terms its
// tasks run under there, whether its owner shares its records with this sandbox (`--on <link>`, its records tools), and
// whether this link may operate it (its run_command, read_file and write_file tools).
export interface LinkListing {
    readonly to: string;
    readonly sandbox: string;
    readonly online: boolean;
    readonly why?: string;
    readonly persona?: string;
    readonly approve?: boolean;
    readonly turnsPerHour?: number;
    readonly records?: boolean;
    // Whether this link may operate that sandbox: run commands, read and write files there as its owner's terminal would.
    readonly operate?: boolean;
}
