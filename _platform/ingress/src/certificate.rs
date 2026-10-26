//! Where the edge's certificate comes from, kept current in its slot: a PEM pair on disk an operator renews, or the
//! platform, which orders one wildcard for every edge machine so no two of them ask the CA for the same names. A load
//! that fails keeps what the slot holds; an empty slot is asked again soon, a full one on the refresh.
//!
//! The platform's certificate is also kept on disk (2026-10-26, [`Cache`]): an edge that restarts while the api is down
//! presents the one it last held instead of none, so every sandbox behind it stays reachable through the outage. It was
//! held only in memory before, and a restart during an api outage left the slot empty until the api answered again.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::Context;
use http::{Request, StatusCode, header};
use http_body_util::{BodyExt, Empty};
use rustls::pki_types::CertificateDer;
use rustls::pki_types::pem::PemObject;
use serde::{Deserialize, Serialize};
use tokio::task::JoinHandle;

use crate::platform;
use crate::tls::CertificateSlot;

/// The platform's answer to an edge asking for the certificate it issued.
pub const CERTIFICATE_PATH: &str = "/api/ingress/certificate";

/// Where the platform's certificate is kept unless `INGRESS_TLS_CACHE_FILE` names another file (or `off`).
pub const DEFAULT_CACHE_FILE: &str = "/var/lib/intentic-ingress/certificate.json";

// A certificate lives ninety days and is renewed with thirty left, so an hour is always in time.
const REFRESH: Duration = Duration::from_secs(60 * 60);
const WHILE_EMPTY: Duration = Duration::from_secs(30);

// An answer larger than a chain and a key is not one the platform gives.
const MAX_ANSWER: usize = 256 * 1024;

pub enum Source {
    Files { chain: PathBuf, key: PathBuf },
    Platform { url: String, token: String },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Issued {
    certificate: String,
    private_key: String,
}

/// Loads now and then on the refresh, for the process's life. A `cache` fills the slot from disk before this returns,
/// so the listeners opened after it present a certificate from their first connection; the source is then asked as
/// before, every [`WHILE_EMPTY`] until it has answered once, and what it answers is written back to the cache.
pub fn keep(slot: Arc<CertificateSlot>, source: Source, cache: Option<Cache>) -> JoinHandle<()> {
    let mut kept = cache.as_ref().and_then(|cache| restore(&slot, cache));
    tokio::spawn(async move {
        let client = platform::client();
        // Whether the source itself has filled the slot this run: one filled only from disk is asked again soon.
        let mut answered = false;
        loop {
            match load(&source, &client).await {
                Ok(Some((chain, key))) => match slot.replace(&chain, &key) {
                    Ok(()) => {
                        answered = true;
                        tracing::debug!("the certificate is current");
                        if let Some(cache) = &cache {
                            let pair = (chain, key);
                            if kept.as_ref() != Some(&pair) {
                                kept = store(cache.clone(), pair).await;
                            }
                        }
                    }
                    Err(error) => {
                        tracing::error!(
                            error = format!("{error:#}"),
                            "the certificate does not load; keeping the one held"
                        )
                    }
                },
                Ok(None) => tracing::warn!("no certificate has been issued for the edge yet"),
                Err(error) => {
                    tracing::warn!(
                        error = format!("{error:#}"),
                        "the certificate could not be read; keeping the one held"
                    )
                }
            }
            tokio::time::sleep(if answered && slot.present() {
                REFRESH
            } else {
                WHILE_EMPTY
            })
            .await;
        }
    })
}

/// The kept pair put in the slot, or `None` when there is none to put there; every reason a kept file is passed over is
/// a warning, never a failure of the edge.
fn restore(slot: &CertificateSlot, cache: &Cache) -> Option<(String, String)> {
    let (chain, key) = cache.restore(SystemTime::now())?;
    match slot.replace(&chain, &key) {
        Ok(()) => {
            tracing::info!(
                file = %cache.path.display(),
                "serving the certificate kept on disk until the platform answers"
            );
            Some((chain, key))
        }
        Err(error) => {
            tracing::warn!(
                file = %cache.path.display(),
                error = format!("{error:#}"),
                "the certificate kept on disk does not load; ignoring it"
            );
            None
        }
    }
}

/// Writes the pair off the runtime's threads; what is on disk afterwards, `None` when the write failed.
async fn store(cache: Cache, pair: (String, String)) -> Option<(String, String)> {
    let path = cache.path.clone();
    let written = tokio::task::spawn_blocking(move || {
        cache.store(&pair.0, &pair.1)?;
        Ok::<_, anyhow::Error>(pair)
    })
    .await;
    match written {
        Ok(Ok(pair)) => Some(pair),
        Ok(Err(error)) => {
            tracing::warn!(
                file = %path.display(),
                error = format!("{error:#}"),
                "the certificate could not be kept on disk; a restart while the platform is down will present none"
            );
            None
        }
        Err(error) => {
            tracing::warn!(error = %error, "keeping the certificate on disk did not finish");
            None
        }
    }
}

async fn load(
    source: &Source,
    client: &platform::PlatformClient,
) -> anyhow::Result<Option<(String, String)>> {
    match source {
        Source::Files { chain, key } => Ok(Some((
            tokio::fs::read_to_string(chain).await?,
            tokio::fs::read_to_string(key).await?,
        ))),
        Source::Platform { url, token } => {
            let request = Request::get(format!("{}{CERTIFICATE_PATH}", url.trim_end_matches('/')))
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .body(Empty::new())?;
            let answer =
                tokio::time::timeout(Duration::from_secs(20), client.request(request)).await??;
            if answer.status() == StatusCode::NOT_FOUND {
                return Ok(None);
            }
            if !answer.status().is_success() {
                anyhow::bail!("the platform answered {}", answer.status());
            }
            let body = http_body_util::Limited::new(answer.into_body(), MAX_ANSWER)
                .collect()
                .await
                .map_err(|error| anyhow::anyhow!("reading the certificate: {error}"))?
                .to_bytes();
            let issued: Issued = serde_json::from_slice(&body)?;
            Ok(Some((issued.certificate, issued.private_key)))
        }
    }
}

/* THE CERTIFICATE KEPT ON DISK (2026-10-26). One JSON file holding the chain and key the platform last issued and the
api they came from, written whole or not at all (a temporary file beside it, renamed over it) and readable by the
process's user alone, since it holds the wildcard's private key. Nothing logs its contents. On Fly a machine's root
filesystem is rebuilt from the image whenever the machine starts, so the file outlives a restart only on a volume
mounted at its directory (README.md, "The certificate kept on disk"); without one it is written and lost, which is
what the edge did before. */

/// The format a kept file is written in; a file in any other is passed over.
const KEPT_VERSION: u32 = 1;

#[derive(Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct Kept {
    version: u32,
    /// The api the pair came from: a file another platform's edge left is not this edge's certificate.
    source: String,
    certificate: String,
    private_key: String,
}

/// The file the platform's certificate is kept in, and the api it is kept for.
#[derive(Clone, Debug)]
pub struct Cache {
    path: PathBuf,
    source: String,
}

impl Cache {
    pub fn new(path: impl Into<PathBuf>, source: &str) -> Self {
        Self {
            path: path.into(),
            source: source.trim_end_matches('/').to_owned(),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The kept chain and key when the file is this edge's and its certificate is valid at `now`; `None` otherwise, a
    /// missing file quietly and any other reason with a warning naming it.
    pub fn restore(&self, now: SystemTime) -> Option<(String, String)> {
        match self.read(now) {
            Ok(pair) => pair,
            Err(error) => {
                tracing::warn!(
                    file = %self.path.display(),
                    error = format!("{error:#}"),
                    "passing over the certificate kept on disk"
                );
                None
            }
        }
    }

    fn read(&self, now: SystemTime) -> anyhow::Result<Option<(String, String)>> {
        let bytes = match std::fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error).context("reading the file"),
        };
        let kept: Kept =
            serde_json::from_slice(&bytes).context("the file is not a kept certificate")?;
        if kept.version != KEPT_VERSION {
            anyhow::bail!("the file is in format {}, not {KEPT_VERSION}", kept.version);
        }
        if kept.source != self.source {
            anyhow::bail!(
                "the file holds a certificate from {}, not from {}",
                kept.source,
                self.source
            );
        }
        valid_at(&kept.certificate, now)?;
        Ok(Some((kept.certificate, kept.private_key)))
    }

    /// Replaces the file with this pair, whole: a reader sees the old file or the new one, never part of either.
    pub fn store(&self, chain: &str, key: &str) -> anyhow::Result<()> {
        let kept = Kept {
            version: KEPT_VERSION,
            source: self.source.clone(),
            certificate: chain.to_owned(),
            private_key: key.to_owned(),
        };
        write_privately(&self.path, &serde_json::to_vec(&kept)?)
    }
}

/// Whether the chain's first certificate is valid at `now`, by its own dates. Its trust is not this check's: the edge
/// serves it, the browser judges it, and the slot has already refused one whose key is not its own.
fn valid_at(chain: &str, now: SystemTime) -> anyhow::Result<()> {
    let leaf = CertificateDer::pem_slice_iter(chain.as_bytes())
        .next()
        .context("the file holds no certificate")?
        .context("reading the kept certificate")?;
    let (_, certificate) = x509_parser::parse_x509_certificate(leaf.as_ref())
        .map_err(|error| anyhow::anyhow!("parsing the kept certificate: {error}"))?;
    let at = now
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_secs() as i64)
        .unwrap_or(0);
    let validity = certificate.validity();
    if at < validity.not_before.timestamp() {
        anyhow::bail!(
            "the kept certificate is not valid until {}",
            validity.not_before
        );
    }
    if at >= validity.not_after.timestamp() {
        anyhow::bail!("the kept certificate expired {}", validity.not_after);
    }
    Ok(())
}

/// Writes `bytes` to `path` through a temporary file in the same directory, renamed over it once it is on disk, the
/// directory made if it is missing. Unix gives the file mode 0600 and a new directory 0700.
fn write_privately(path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
    let directory = match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent,
        _ => Path::new("."),
    };
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder
        .create(directory)
        .with_context(|| format!("making {}", directory.display()))?;
    let name = path
        .file_name()
        .context("the cache file has no name")?
        .to_string_lossy();
    let temporary = directory.join(format!(".{name}.{}.tmp", std::process::id()));
    // A temporary file a crash left behind may carry another mode, and an existing file keeps the mode it has.
    let _ = std::fs::remove_file(&temporary);
    let written = (|| -> anyhow::Result<()> {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let mut file = options
            .open(&temporary)
            .with_context(|| format!("creating {}", temporary.display()))?;
        file.write_all(bytes)?;
        file.sync_all()?;
        std::fs::rename(&temporary, path)
            .with_context(|| format!("renaming it over {}", path.display()))?;
        Ok(())
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(&temporary);
        return written;
    }
    // The rename is durable once the directory is: best effort, since a lost rename only costs the next restart.
    #[cfg(unix)]
    if let Ok(directory) = std::fs::File::open(directory) {
        let _ = directory.sync_all();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const API: &str = "https://api.example.test";

    struct Pair {
        chain: String,
        key: String,
    }

    fn issue_between(not_before: (i32, u8, u8), not_after: (i32, u8, u8)) -> Pair {
        let mut params =
            rcgen::CertificateParams::new(vec!["*.sbx.test".to_owned(), "sbx.test".to_owned()])
                .unwrap();
        params.not_before = rcgen::date_time_ymd(not_before.0, not_before.1, not_before.2);
        params.not_after = rcgen::date_time_ymd(not_after.0, not_after.1, not_after.2);
        let key = rcgen::KeyPair::generate().unwrap();
        let certificate = params.self_signed(&key).unwrap();
        Pair {
            chain: certificate.pem(),
            key: key.serialize_pem(),
        }
    }

    fn current() -> Pair {
        let issued = rcgen::generate_simple_self_signed(vec!["*.sbx.test".to_owned()]).unwrap();
        Pair {
            chain: issued.cert.pem(),
            key: issued.signing_key.serialize_pem(),
        }
    }

    struct Dir(PathBuf);

    impl Dir {
        fn new(name: &str) -> Self {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "ingress-cache-{name}-{}-{unique}",
                std::process::id()
            ));
            Self(path)
        }
    }

    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    // A restart while the api is down is the whole point: the pair written last is the pair read back, and the slot
    // takes it.
    #[test]
    fn a_kept_certificate_is_restored_and_fills_the_slot() {
        let dir = Dir::new("restore");
        let cache = Cache::new(dir.0.join("nested/certificate.json"), API);
        let pair = current();
        cache.store(&pair.chain, &pair.key).unwrap();

        let restored = cache.restore(SystemTime::now()).unwrap();
        assert_eq!(restored, (pair.chain.clone(), pair.key.clone()));

        let slot = CertificateSlot::default();
        assert_eq!(restore(&slot, &cache), Some((pair.chain, pair.key)));
        assert!(slot.present());
    }

    #[test]
    fn no_file_is_nothing_to_restore() {
        let dir = Dir::new("missing");
        let cache = Cache::new(dir.0.join("certificate.json"), API);
        assert_eq!(cache.restore(SystemTime::now()), None);
        assert_eq!(
            cache.read(SystemTime::now()).unwrap(),
            None,
            "a missing file is not an error"
        );
    }

    #[test]
    fn an_expired_or_not_yet_valid_certificate_is_passed_over() {
        let dir = Dir::new("dates");
        let cache = Cache::new(dir.0.join("certificate.json"), API);
        let expired = issue_between((2020, 1, 1), (2021, 1, 1));
        cache.store(&expired.chain, &expired.key).unwrap();
        let error = cache.read(SystemTime::now()).unwrap_err();
        assert!(format!("{error:#}").contains("expired"), "{error:#}");
        assert_eq!(cache.restore(SystemTime::now()), None);

        let early = issue_between((2090, 1, 1), (2091, 1, 1));
        cache.store(&early.chain, &early.key).unwrap();
        let error = cache.read(SystemTime::now()).unwrap_err();
        assert!(
            format!("{error:#}").contains("not valid until"),
            "{error:#}"
        );

        // The same certificate is good on a day inside its dates.
        let inside = UNIX_EPOCH + Duration::from_secs(4_102_444_800 + 86_400 * 30); // 2100-01-31
        let later = issue_between((2100, 1, 1), (2101, 1, 1));
        cache.store(&later.chain, &later.key).unwrap();
        assert!(cache.restore(inside).is_some());
    }

    #[test]
    fn a_file_from_another_platform_is_passed_over() {
        let dir = Dir::new("foreign");
        let path = dir.0.join("certificate.json");
        let pair = current();
        Cache::new(&path, "https://api.other.test")
            .store(&pair.chain, &pair.key)
            .unwrap();
        let ours = Cache::new(&path, API);
        let error = ours.read(SystemTime::now()).unwrap_err();
        assert!(format!("{error:#}").contains("api.other.test"), "{error:#}");
        assert_eq!(ours.restore(SystemTime::now()), None);
        // A trailing slash is the same api.
        assert!(
            Cache::new(&path, "https://api.other.test/")
                .restore(SystemTime::now())
                .is_some()
        );
    }

    #[test]
    fn a_corrupt_file_is_passed_over_and_never_fatal() {
        let dir = Dir::new("corrupt");
        std::fs::create_dir_all(&dir.0).unwrap();
        let path = dir.0.join("certificate.json");
        let cache = Cache::new(&path, API);
        let pair = current();
        let corrupt: [Vec<u8>; 5] = [
            b"\x00\xffnot json".to_vec(),
            b"{\"version\":1}".to_vec(),
            serde_json::to_vec(&Kept {
                version: 2,
                source: API.to_owned(),
                certificate: pair.chain.clone(),
                private_key: pair.key.clone(),
            })
            .unwrap(),
            serde_json::to_vec(&Kept {
                version: KEPT_VERSION,
                source: API.to_owned(),
                certificate: "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n"
                    .to_owned(),
                private_key: pair.key.clone(),
            })
            .unwrap(),
            serde_json::to_vec(&Kept {
                version: KEPT_VERSION,
                source: API.to_owned(),
                certificate: String::new(),
                private_key: pair.key.clone(),
            })
            .unwrap(),
        ];
        for bytes in corrupt {
            std::fs::write(&path, &bytes).unwrap();
            assert!(cache.read(SystemTime::now()).is_err());
            assert_eq!(cache.restore(SystemTime::now()), None);
        }
    }

    // A file whose key is not its certificate's parses and is in date, and the slot still refuses it.
    #[test]
    fn a_kept_pair_whose_key_is_not_its_certificates_leaves_the_slot_empty() {
        let dir = Dir::new("mismatch");
        let cache = Cache::new(dir.0.join("certificate.json"), API);
        let (first, second) = (current(), current());
        cache.store(&first.chain, &second.key).unwrap();
        let slot = CertificateSlot::default();
        assert_eq!(restore(&slot, &cache), None);
        assert!(!slot.present());
    }

    #[cfg(unix)]
    #[test]
    fn the_file_is_written_whole_and_private() {
        use std::os::unix::fs::PermissionsExt;

        let dir = Dir::new("private");
        let path = dir.0.join("state/certificate.json");
        let cache = Cache::new(&path, API);
        let (first, second) = (current(), current());
        cache.store(&first.chain, &first.key).unwrap();
        // A file left with a wider mode by hand is replaced by a private one, not rewritten in place.
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        cache.store(&second.chain, &second.key).unwrap();

        let mode = |path: &Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&path), 0o600);
        assert_eq!(mode(path.parent().unwrap()), 0o700);
        assert_eq!(
            cache.restore(SystemTime::now()),
            Some((second.chain, second.key))
        );
        let left: Vec<_> = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            left,
            vec!["certificate.json".to_owned()],
            "no temporary file is left"
        );
    }

    #[test]
    fn a_directory_that_cannot_be_made_fails_the_write_and_nothing_else() {
        let dir = Dir::new("blocked");
        std::fs::create_dir_all(&dir.0).unwrap();
        // A file where the cache's directory would be.
        std::fs::write(dir.0.join("state"), b"in the way").unwrap();
        let cache = Cache::new(dir.0.join("state/certificate.json"), API);
        let pair = current();
        assert!(cache.store(&pair.chain, &pair.key).is_err());
        assert_eq!(cache.restore(SystemTime::now()), None);
    }
}
