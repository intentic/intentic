<!-- Passwords on this computer: the Passwords app (@intentic/ext-passwords/app) over this app's own port, with what is open kept in the window's address. -->
<script setup lang="ts">
import { PasswordsApp, type PasswordsSelection } from "@intentic/ext-passwords/app";
import { computed } from "vue";
import { type LocationQueryValue, useRoute, useRouter } from "vue-router";
import { passwordsPort } from "./passwordsState";

const route = useRoute();
const router = useRouter();
const port = passwordsPort();

// One query value as text: the router hands a repeated key as a list, which no link of ours writes, and a bare key as null.
const one = (value: LocationQueryValue | LocationQueryValue[] | undefined): string | undefined => {
    const first = Array.isArray(value) ? value[0] : value;
    return first === null || first === undefined || first === `` ? undefined : first;
};
const selection = computed(
    (): PasswordsSelection => ({ filter: one(route.query[`filter`]), item: one(route.query[`item`]), query: one(route.query[`q`]) }),
);

// Replaced, not pushed: picking a password is not a page the back button should step through one by one.
const follow = (next: PasswordsSelection): void => {
    const query: Record<string, string> = {};
    if (next.filter !== undefined) {
        query[`filter`] = next.filter;
    }
    if (next.item !== undefined) {
        query[`item`] = next.item;
    }
    if (next.query !== undefined) {
        query[`q`] = next.query;
    }
    void router.replace({ query });
};
</script>

<template>
    <PasswordsApp :port="port" :selection="selection" @update:selection="follow" />
</template>
