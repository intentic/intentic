#![cfg(target_os = "linux")]

use glib::prelude::*;

// GHSA-wrw7-89jp-8q8g: each of these methods passes through the C out-pointer in impl_get.
// Cargo.toml optimises glib in the test profile so an immutable out-pointer cannot pass in debug only.
#[test]
fn reads_strings_from_both_ends() {
    let strings = ["first", "", "Zażółć 🦀", "last"];
    let variant = strings.to_variant();
    let mut iter = variant.array_iter_str().unwrap();

    assert_eq!(iter.next(), Some("first"));
    assert_eq!(iter.next_back(), Some("last"));
    assert_eq!(iter.next(), Some(""));
    assert_eq!(iter.next_back(), Some("Zażółć 🦀"));
    assert_eq!(iter.next(), None);
    assert_eq!(iter.next_back(), None);
}

#[test]
fn reads_skipped_and_last_strings() {
    let variant = ["zero", "one", "two", "three", "four"].to_variant();
    let mut iter = variant.array_iter_str().unwrap();

    assert_eq!(iter.nth(1), Some("one"));
    assert_eq!(iter.nth_back(1), Some("three"));
    assert_eq!(iter.last(), Some("two"));
    assert_eq!(variant.array_iter_str().unwrap().last(), Some("four"));
    assert_eq!(
        variant.array_iter_str().unwrap().collect::<Vec<_>>(),
        ["zero", "one", "two", "three", "four"]
    );
}

#[test]
fn empty_and_exhausted_iterators_do_not_read_a_child() {
    let empty: [&str; 0] = [];
    let variant = empty.to_variant();
    let mut iter = variant.array_iter_str().unwrap();
    assert_eq!(iter.next(), None);
    assert_eq!(iter.next_back(), None);
    assert_eq!(iter.nth(1), None);
    assert_eq!(iter.nth_back(1), None);
    assert_eq!(iter.last(), None);

    let variant = ["only"].to_variant();
    assert_eq!(variant.array_iter_str().unwrap().nth(1), None);
    assert_eq!(variant.array_iter_str().unwrap().nth_back(1), None);
}
