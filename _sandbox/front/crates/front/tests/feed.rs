//! The change feed through the real binary: Node names a checkout on the control lane, and each sync answers where its
//! count stands, moved by any write that finished before it.

mod support;

use std::path::Path;
use std::process::Command;
use std::sync::Arc;

use front_wire::{FromNode, PreviewRoute, WatchedCheckout};
use support::Harness;

fn git(dir: &Path, args: &[&str]) {
    let status = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["-c", "user.name=t", "-c", "user.email=t@t"])
        .args(args)
        .status()
        .unwrap();
    assert!(status.success(), "git {args:?}");
}

#[tokio::test]
async fn a_watched_checkout_counts_its_writes_until_it_is_unwatched() {
    let harness = Harness::start("feed", Arc::new(|_: &str| PreviewRoute::Node)).await;
    harness.hello().await;
    let repo = harness.dir.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-q"]);
    std::fs::write(repo.join("a.txt"), "a\n").unwrap();
    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "-q", "-m", "one"]);
    let dir = repo.to_str().unwrap();
    let git_dir = repo.join(".git").to_str().unwrap().to_owned();

    assert_eq!(harness.sync(1, &[dir]).await, vec![None]);
    harness
        .send(&FromNode::Watch {
            checkout: WatchedCheckout {
                dir: dir.to_owned(),
                git_dir: git_dir.clone(),
                common_dir: git_dir,
            },
        })
        .await;
    // The watch lands off the lane's reader, so the first count may still be arriving.
    let mut first = None;
    for id in 2..100 {
        first = harness.sync(id, &[dir]).await[0];
        if first.is_some() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    let first = first.expect("the checkout is counted");
    assert_eq!(harness.sync(100, &[dir]).await, vec![Some(first)]);
    std::fs::write(repo.join("a.txt"), "b\n").unwrap();
    let [Some(after)] = harness.sync(101, &[dir]).await[..] else {
        panic!("the checkout is still counted");
    };
    assert!(after > first);

    harness
        .send(&FromNode::Unwatch {
            dir: dir.to_owned(),
        })
        .await;
    assert_eq!(harness.sync(102, &[dir]).await, vec![None]);
}
