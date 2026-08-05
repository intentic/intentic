export interface Widget {
    name: string;
}

// Builds one widget. Fixture anchor for def/refs tests.
export const createWidget = (name: string): Widget => ({ name });
