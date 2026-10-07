/* GIVING THE MENU ENTRY A PACKAGE IDENTITY (README.md has the why, and what was measured).
 *
 * Windows 11 shows an app in its new context menu only through an IExplorerCommand declared by a PACKAGE, and
 * registers a package only when its signer chains to a root the PC trusts. Measured on Windows 11 25H2 (2026-10-07), as
 * a standard user:
 *   - an unsigned package is refused: "an unsigned package cannot include Executable activations" (0x80073D2B);
 *   - a self-signed one is refused even with its certificate in the user's own Trusted People store, whatever
 *     Microsoft's page on identity packages says: "terminated in a root certificate which is not trusted" (0x800B0109);
 *   - the user's Root store takes a certificate only through Windows' "Security Warning" dialog, which tells the reader
 *     that installing it is a security risk.
 * So there are two ways in, tried in this order:
 *
 *   SIGNED. A release whose build holds Intentic's code-signing certificate packs and signs the package itself
 *   (_tools/scripts/desktop/explorer-menu-msix.mjs) and ships it beside this DLL as `SIGNED_PACKAGE`. It registers
 *   with no prompt at all, on every install and update.
 *
 *   SIGNED HERE. Otherwise this DLL makes a certificate on the PC: a fresh RSA key and a self-signed code-signing
 *   certificate for `env!("EXPLORER_MENU_PUBLISHER")`; the package (build.rs's manifest plus three logos) written by
 *   Windows' own packaging API and signed with that key by the same call signtool makes; the certificate's PUBLIC half
 *   added to the PC's Trusted People store by an elevated copy of this DLL (`trust_signer`, one UAC prompt); the
 *   package registered; the private key deleted. Nothing can be signed with that certificate again, so trusting it
 *   admits this one package and nothing else. Its version is the manifest's fingerprint (build.rs), so an update that
 *   did not change the manifest finds the package already in place and asks nothing; a quiet install (an update the
 *   app runs in the background, a passive or silent one) never prompts, and keeps whatever registration is there.
 *
 * Every outcome lands in ~/.intentic/logs/explorer-menu.log, since regsvr32 /s says nothing. A failure leaves the
 * classic entry (installer-hooks.nsh writes it whenever regsvr32 does not exit 0), so the worst case is the menu as it
 * was before. Removing the package needs no prompt; the certificate stays in Trusted People, where without its key it
 * can vouch for nothing new, because taking it out would cost another UAC prompt on the way out. */
use std::ffi::c_void;
use std::io::Write;
use std::mem::ManuallyDrop;
use std::path::{Path, PathBuf};

use windows::core::{w, Interface, HSTRING, PCSTR, PCWSTR, PSTR, PWSTR};
use windows::ApplicationModel::Package;
use windows::Foundation::Uri;
use windows::Management::Deployment::{AddPackageOptions, DeploymentResult, PackageManager};
use windows::Win32::Foundation::{
    CloseHandle, ERROR_CANCELLED, E_FAIL, FILETIME, HANDLE, HWND, SYSTEMTIME, S_OK, WAIT_OBJECT_0,
};
use windows::Win32::Security::Cryptography::{
    szOID_BASIC_CONSTRAINTS2, szOID_ENHANCED_KEY_USAGE, szOID_KEY_USAGE,
    szOID_PKIX_KP_CODE_SIGNING, szOID_RSA_SHA256RSA, CertAddEncodedCertificateToStore,
    CertCloseStore, CertCreateSelfSignCertificate, CertDeleteCertificateFromStore,
    CertDuplicateCertificateContext, CertEnumCertificatesInStore, CertFreeCertificateContext,
    CertNameToStrW, CertOpenStore, CertSetCertificateContextProperty, CertStrToNameW,
    CryptEncodeObjectEx, NCryptCreatePersistedKey, NCryptDeleteKey, NCryptFinalizeKey,
    NCryptFreeObject, NCryptOpenStorageProvider, NCryptSetProperty, SignerFreeSignerContext,
    SignerSignEx2, BCRYPT_RSA_ALGORITHM, CALG_SHA_256, CERT_BASIC_CONSTRAINTS2_INFO, CERT_CONTEXT,
    CERT_CREATE_SELFSIGN_FLAGS, CERT_DIGITAL_SIGNATURE_KEY_USAGE, CERT_EXTENSION, CERT_EXTENSIONS,
    CERT_FRIENDLY_NAME_PROP_ID, CERT_KEY_SPEC, CERT_OPEN_STORE_FLAGS,
    CERT_STORE_ADD_REPLACE_EXISTING, CERT_STORE_PROV_SYSTEM_W, CERT_STORE_READONLY_FLAG,
    CERT_SYSTEM_STORE_LOCAL_MACHINE, CERT_X500_NAME_STR, CRYPT_ALGORITHM_IDENTIFIER,
    CRYPT_ATTRIBUTES, CRYPT_BIT_BLOB, CRYPT_ENCODE_OBJECT_FLAGS, CRYPT_INTEGER_BLOB,
    CRYPT_KEY_FLAGS, CRYPT_KEY_PROV_INFO, CTL_USAGE, HCERTSTORE, HCRYPTPROV_OR_NCRYPT_KEY_HANDLE,
    MS_KEY_STORAGE_PROVIDER, NCRYPT_FLAGS, NCRYPT_HANDLE, NCRYPT_KEY_HANDLE,
    NCRYPT_LENGTH_PROPERTY, NCRYPT_OVERWRITE_KEY_FLAG, NCRYPT_PROV_HANDLE, NCRYPT_SILENT_FLAG,
    SIGNER_CERT, SIGNER_CERT_0, SIGNER_CERT_POLICY_CHAIN, SIGNER_CERT_STORE,
    SIGNER_CERT_STORE_INFO, SIGNER_CONTEXT, SIGNER_FILE_INFO, SIGNER_NO_ATTR, SIGNER_PROVIDER_INFO,
    SIGNER_SIGNATURE_INFO, SIGNER_SIGN_FLAGS, SIGNER_SUBJECT_FILE, SIGNER_SUBJECT_INFO,
    SIGNER_SUBJECT_INFO_0, X509_ASN_ENCODING, X509_BASIC_CONSTRAINTS2, X509_ENHANCED_KEY_USAGE,
    X509_KEY_USAGE,
};
use windows::Win32::Storage::FileSystem::FILE_ATTRIBUTE_NORMAL;
use windows::Win32::Storage::Packaging::Appx::{
    AppxFactory, IAppxFactory, APPX_COMPRESSION_OPTION_NONE, APPX_PACKAGE_SETTINGS,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CreateUri, IStream,
    Uri_CREATE_CANONICALIZE, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, STGM_CREATE, STGM_READ,
    STGM_SHARE_DENY_WRITE, STGM_SHARE_EXCLUSIVE, STGM_WRITE,
};
use windows::Win32::System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ};
use windows::Win32::System::SystemInformation::GetSystemTime;
use windows::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject, INFINITE};
use windows::Win32::System::Time::{FileTimeToSystemTime, SystemTimeToFileTime};
use windows::Win32::UI::Shell::{
    SHCreateMemStream, SHCreateStreamOnFileEx, ShellExecuteExW, SEE_MASK_NOASYNC,
    SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
};
use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, SW_HIDE};

/// The package's name, whoever signed it.
const PACKAGE_NAME: &str = "Intentic.ExplorerMenu";
/// The package a release signed with Intentic's certificate, beside this DLL when the release had one.
pub const SIGNED_PACKAGE: &str = "intentic-explorer-menu.msix";
/// The package this DLL signs on the PC: its publisher (the certificate's subject) and version (build.rs).
const LOCAL_PUBLISHER: &str = env!("EXPLORER_MENU_PUBLISHER");
const LOCAL_VERSION: &str = env!("EXPLORER_MENU_VERSION");
/// What certmgr shows for that certificate, so a person who finds it there can tell what it is.
const FRIENDLY_NAME: &str =
    "Intentic: Open with Intentic in the Explorer menu (this PC only, key destroyed)";

const MANIFEST: &str = include_str!(concat!(env!("OUT_DIR"), "/AppxManifest.xml"));
const LOGOS: [(&str, &[u8]); 3] = [
    (
        "StoreLogo.png",
        include_bytes!("../../src-tauri/icons/StoreLogo.png"),
    ),
    (
        "Square150x150Logo.png",
        include_bytes!("../../src-tauri/icons/Square150x150Logo.png"),
    ),
    (
        "Square44x44Logo.png",
        include_bytes!("../../src-tauri/icons/Square44x44Logo.png"),
    ),
];

/// The first Windows 11 build. Windows 10's context menu is the classic one, where the installer's registry entry is
/// already a first-class citizen, so there is nothing to register there.
const FIRST_WINDOWS_11_BUILD: u32 = 22_000;

type Outcome = Result<String, String>;

/// Run `job` on a thread of its own in the multithreaded apartment (regsvr32 calls in from a single-threaded one, where
/// waiting on a deployment would block the thread its completion is delivered to), and log how it went.
pub fn logged(what: &str, job: impl FnOnce() -> Outcome + Send + 'static) -> windows_core::HRESULT {
    let outcome = std::thread::spawn(move || unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let outcome = job();
        CoUninitialize();
        outcome
    })
    .join()
    .unwrap_or_else(|_| Err("panicked".to_string()));
    match &outcome {
        Ok(said) => log(&format!("{what}: {said}")),
        Err(said) => log(&format!("{what} failed: {said}")),
    }
    // Windows 10 is not a failure, but it must not read as success either: the installer writes the classic entry on
    // any non-zero exit.
    if outcome.is_ok() {
        S_OK
    } else {
        E_FAIL
    }
}

pub fn log(line: &str) {
    let Some(home) = std::env::var_os("USERPROFILE") else {
        return;
    };
    let dir = Path::new(&home).join(".intentic").join("logs");
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("explorer-menu.log");
    // A few lines per install or update: start over past 64 KB rather than grow for the life of the PC.
    if std::fs::metadata(&path).is_ok_and(|meta| meta.len() > 64 * 1024) {
        let _ = std::fs::remove_file(&path);
    }
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or_default();
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = writeln!(file, "{seconds} {line}");
    }
}

fn step<T>(name: &str, result: windows_core::Result<T>) -> Result<T, String> {
    result.map_err(|error| format!("{name}: {error} ({:#010x})", error.code().0))
}

/* REGISTER */

/// `quiet`: never show a prompt (an update, a passive or silent install, anything nobody is watching).
pub fn register(quiet: bool) -> Outcome {
    let build = windows_build().ok_or("could not read the Windows build number")?;
    if build < FIRST_WINDOWS_11_BUILD {
        return Err(format!(
            "Windows build {build} has the classic menu only; its registry entry stays"
        ));
    }
    let dir = crate::com::install_dir().ok_or("could not tell which folder this DLL is in")?;
    let app = crate::com::app_path().ok_or("could not tell where the app is")?;
    if !app.is_file() {
        return Err(format!("{} is not there", app.display()));
    }
    let manager = step("PackageManager", PackageManager::new())?;

    let signed = dir.join(SIGNED_PACKAGE);
    if signed.is_file() {
        match replace_package(&manager, &signed, &dir) {
            Ok(()) => {
                return Ok(format!(
                    "the release's signed package registered for {}",
                    dir.display()
                ))
            }
            // A signed package that will not register (a certificate Windows stopped trusting, say) is no reason to go
            // without the menu: carry on as a build without one would.
            Err(error) => log(&format!(
                "register: the release's signed package failed, signing one here: {error}"
            )),
        }
    }

    let ours = packages(&manager)?;
    let current = |package: &Registered| {
        package.local
            && package.version == LOCAL_VERSION
            && package.location.as_deref() == Some(dir.as_path())
    };
    if ours.iter().any(current) {
        return Ok(format!(
            "already registered (version {LOCAL_VERSION}); nothing to do"
        ));
    }
    if quiet {
        return if ours.is_empty() {
            Err("signing here needs one admin prompt, and this install is quiet; the next interactive install asks".into())
        } else {
            Ok("kept the existing registration; this install is quiet, and replacing it needs one admin prompt".into())
        };
    }

    let certificate = Certificate::create()?;
    let package = std::env::temp_dir().join(format!(
        "intentic-explorer-menu-{}.msix",
        std::process::id()
    ));
    let registered = (|| {
        write_package(&package)?;
        certificate.sign(&package)?;
        trust_elevated(&certificate)?;
        replace_package(&manager, &package, &dir)
    })();
    let _ = std::fs::remove_file(&package);
    registered.map(|()| {
        format!(
            "signed on this PC and registered for {} (version {LOCAL_VERSION})",
            dir.display()
        )
    })
    // `certificate` drops here, and its private key with it.
}

pub fn unregister() -> Outcome {
    let manager = step("PackageManager", PackageManager::new())?;
    let ours = packages(&manager)?;
    remove(&manager, &ours)?;
    Ok(format!("{} package(s) removed", ours.len()))
}

fn windows_build() -> Option<u32> {
    let mut buffer = [0u16; 32];
    let mut size = std::mem::size_of_val(&buffer) as u32;
    unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            w!("SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion"),
            w!("CurrentBuildNumber"),
            RRF_RT_REG_SZ,
            None,
            Some(buffer.as_mut_ptr() as *mut c_void),
            Some(&mut size),
        )
        .ok()
        .ok()?;
    }
    String::from_utf16_lossy(&buffer)
        .trim_end_matches('\0')
        .trim()
        .parse()
        .ok()
}

/* THE PACKAGE */

/// The identity package: its manifest and the logos it names, written by Windows' own packaging API, which builds the
/// block map and content types a package needs.
fn write_package(path: &Path) -> Result<(), String> {
    unsafe {
        let factory: IAppxFactory = step(
            "AppxFactory",
            CoCreateInstance(&AppxFactory, None, CLSCTX_INPROC_SERVER),
        )?;
        let output = step(
            "create the package file",
            SHCreateStreamOnFileEx(
                &HSTRING::from(path.as_os_str()),
                (STGM_CREATE | STGM_WRITE | STGM_SHARE_EXCLUSIVE).0,
                FILE_ATTRIBUTE_NORMAL.0,
                true,
                None,
            ),
        )?;
        let hash = step(
            "hash method",
            CreateUri(
                w!("http://www.w3.org/2001/04/xmlenc#sha256"),
                Uri_CREATE_CANONICALIZE,
                None,
            ),
        )?;
        let mut settings = APPX_PACKAGE_SETTINGS {
            forceZip32: true.into(),
            hashMethod: ManuallyDrop::new(Some(hash)),
        };
        let written = (|| {
            let writer = step(
                "package writer",
                factory.CreatePackageWriter(&output, &settings),
            )?;
            for (name, bytes) in LOGOS {
                let stream = memory_stream(bytes)?;
                step(
                    name,
                    writer.AddPayloadFile(
                        &HSTRING::from(name),
                        w!("image/png"),
                        APPX_COMPRESSION_OPTION_NONE,
                        &stream,
                    ),
                )?;
            }
            step(
                "write the package",
                writer.Close(&memory_stream(MANIFEST.as_bytes())?),
            )
        })();
        ManuallyDrop::drop(&mut settings.hashMethod);
        written
    }
}

fn memory_stream(bytes: &[u8]) -> Result<IStream, String> {
    unsafe { SHCreateMemStream(Some(bytes)) }.ok_or_else(|| "out of memory".to_string())
}

/// `file:///C:/Users/...`, percent-encoded, which is the spelling of a path Windows.Foundation.Uri takes.
fn file_uri(path: &Path, directory: bool) -> Result<Uri, String> {
    let text = path
        .to_str()
        .ok_or_else(|| format!("{} is not valid Unicode", path.display()))?;
    let mut uri = String::from("file:///");
    for byte in text.replace('\\', "/").bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/' | b':' => {
                uri.push(byte as char)
            }
            _ => uri.push_str(&format!("%{byte:02X}")),
        }
    }
    if directory && !uri.ends_with('/') {
        uri.push('/');
    }
    step("uri", Uri::CreateUri(&HSTRING::from(uri)))
}

/// `package` registered for `dir`, and then every other copy of ours removed. In that order, so that a package that
/// will not register leaves the one already working in place (and the menu with it) rather than nothing.
fn replace_package(manager: &PackageManager, package: &Path, dir: &Path) -> Result<(), String> {
    let full_name = package_full_name(package)?;
    if let Err(error) = add_package(manager, package, dir) {
        // The same identity already registered with other contents or for another folder is refused as a conflict:
        // that copy goes first, and the add is tried once more.
        let same: Vec<_> = packages(manager)?
            .into_iter()
            .filter(|old| old.full_name == full_name)
            .collect();
        if same.is_empty() {
            return Err(error);
        }
        remove(manager, &same)?;
        add_package(manager, package, dir)?;
    }
    let others: Vec<_> = packages(manager)?
        .into_iter()
        .filter(|old| old.full_name != full_name)
        .collect();
    remove(manager, &others)?;
    Ok(())
}

fn add_package(manager: &PackageManager, package: &Path, dir: &Path) -> Result<(), String> {
    let options = step("AddPackageOptions", AddPackageOptions::new())?;
    step(
        "external location",
        options.SetExternalLocationUri(&file_uri(dir, true)?),
    )?;
    // The surrogate hosting this DLL for a package being replaced.
    step("force shutdown", options.SetForceAppShutdown(true))?;
    // A package of the same family at the same or a lower version replaces the registered one rather than failing.
    step("force update", options.SetForceUpdateFromAnyVersion(true))?;
    let operation = step(
        "add package",
        manager.AddPackageByUriAsync(&file_uri(package, false)?, &options),
    )?;
    deployed("add package", operation.get(), || operation.GetResults())
}

/// The full name a package file will register under, read from its own manifest by Windows' packaging API.
fn package_full_name(package: &Path) -> Result<HSTRING, String> {
    unsafe {
        let factory: IAppxFactory = step(
            "AppxFactory",
            CoCreateInstance(&AppxFactory, None, CLSCTX_INPROC_SERVER),
        )?;
        let input = step(
            "open the package",
            SHCreateStreamOnFileEx(
                &HSTRING::from(package.as_os_str()),
                (STGM_READ | STGM_SHARE_DENY_WRITE).0,
                0,
                false,
                None,
            ),
        )?;
        let reader = step("read the package", factory.CreatePackageReader(&input))?;
        let id = step(
            "package identity",
            reader
                .GetManifest()
                .and_then(|manifest| manifest.GetPackageId()),
        )?;
        let name = step("package full name", id.GetPackageFullName())?;
        let full_name = HSTRING::from(name.to_string().unwrap_or_default());
        CoTaskMemFree(Some(name.0 as *const c_void));
        Ok(full_name)
    }
}

struct Registered {
    full_name: HSTRING,
    /// Signed on this PC, rather than by a release.
    local: bool,
    version: String,
    location: Option<PathBuf>,
}

/// Every copy of the package this user has, whoever signed it: the release's and this PC's have different publishers,
/// and so different family names, and both registered would put the entry in the menu twice.
fn packages(manager: &PackageManager) -> Result<Vec<Registered>, String> {
    let all = step(
        "list packages",
        manager.FindPackagesByUserSecurityId(&HSTRING::new()),
    )?;
    let mut ours = Vec::new();
    for package in all {
        let Ok(id) = package.Id() else { continue };
        if id.Name().map(|name| name != PACKAGE_NAME).unwrap_or(true) {
            continue;
        }
        let version = id
            .Version()
            .map(|v| format!("{}.{}.{}.{}", v.Major, v.Minor, v.Build, v.Revision))
            .unwrap_or_default();
        ours.push(Registered {
            full_name: step("package name", id.FullName())?,
            local: id
                .Publisher()
                .map(|publisher| publisher == LOCAL_PUBLISHER)
                .unwrap_or(false),
            version,
            location: external_location(&package),
        });
    }
    Ok(ours)
}

fn external_location(package: &Package) -> Option<PathBuf> {
    let path = package.EffectiveExternalPath().ok()?.to_string();
    (!path.is_empty()).then(|| PathBuf::from(path.trim_end_matches('\\')))
}

fn remove(manager: &PackageManager, packages: &[Registered]) -> Result<(), String> {
    for package in packages {
        let operation = step(
            "remove package",
            manager.RemovePackageAsync(&package.full_name),
        )?;
        deployed("remove package", operation.get(), || operation.GetResults())?;
    }
    Ok(())
}

/// A deployment's outcome in words: a failed one carries Windows' own sentence for why, which is the part worth
/// logging, and is only reachable through the results even when waiting on it already failed.
fn deployed(
    name: &str,
    waited: windows_core::Result<DeploymentResult>,
    results: impl Fn() -> windows_core::Result<DeploymentResult>,
) -> Result<(), String> {
    let result = match waited {
        Ok(result) => result,
        Err(error) => {
            let text = results()
                .and_then(|result| result.ErrorText())
                .map(|text| text.to_string())
                .unwrap_or_default();
            return Err(format!("{name}: {error} ({:#010x}) {text}", error.code().0));
        }
    };
    let code = result.ExtendedErrorCode().unwrap_or(S_OK);
    if code.is_err() {
        let text = result
            .ErrorText()
            .map(|text| text.to_string())
            .unwrap_or_default();
        return Err(format!("{name}: {:#010x} {text}", code.0));
    }
    Ok(())
}

/* TRUST: the one step that needs an administrator */

/// The certificate's public half handed to an elevated copy of this DLL (`trust_signer`) through a file, behind one UAC
/// prompt. Declining the prompt is an answer, not an error worth more than a line in the log.
fn trust_elevated(certificate: &Certificate) -> Result<(), String> {
    let dll = crate::com::dll_path().ok_or("could not tell where this DLL is")?;
    let cer =
        std::env::temp_dir().join(format!("intentic-explorer-menu-{}.cer", std::process::id()));
    std::fs::write(&cer, unsafe { encoded(certificate.context) })
        .map_err(|error| format!("write certificate: {error}"))?;
    let outcome = run_elevated(&dll, &cer);
    let _ = std::fs::remove_file(&cer);
    outcome?;
    if !LocalMachineTrustedPeople::open(true)?.holds(certificate.context)? {
        return Err(
            "the elevated step finished, but the certificate is not in Trusted People".into(),
        );
    }
    Ok(())
}

fn run_elevated(dll: &Path, cer: &Path) -> Result<(), String> {
    let system = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
    let rundll32 = HSTRING::from(format!("{system}\\System32\\rundll32.exe"));
    let parameters = HSTRING::from(format!(
        "\"{}\",TrustSigner {}",
        dll.display(),
        cer.display()
    ));
    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC,
        hwnd: unsafe { GetForegroundWindow() },
        lpVerb: w!("runas"),
        lpFile: PCWSTR(rundll32.as_ptr()),
        lpParameters: PCWSTR(parameters.as_ptr()),
        nShow: SW_HIDE.0,
        ..Default::default()
    };
    if let Err(error) = unsafe { ShellExecuteExW(&mut info) } {
        if error.code() == ERROR_CANCELLED.to_hresult() {
            return Err("the admin prompt was declined; the classic entry stays".into());
        }
        return Err(format!("start the elevated step: {error}"));
    }
    let process = info.hProcess;
    let mut code = 1u32;
    unsafe {
        let waited = WaitForSingleObject(process, INFINITE);
        let _ = GetExitCodeProcess(process, &mut code);
        let _ = CloseHandle(process);
        if waited != WAIT_OBJECT_0 {
            return Err("waiting on the elevated step failed".into());
        }
    }
    if code != 0 {
        return Err(format!(
            "the elevated step failed ({code}); its reason is in this log"
        ));
    }
    Ok(())
}

/// The elevated half: add the certificate in `cer` to the PC's Trusted People, and take out the ones earlier
/// registrations added (each signed a package that is being replaced, and none has a key any more). Refuses anything
/// but a certificate this DLL makes, though whoever runs it elevated could add any certificate by other means anyway.
pub fn trust_signer(cer: &str) -> Outcome {
    let cer = cer.trim().trim_matches('"');
    let bytes = std::fs::read(cer).map_err(|error| format!("read {cer}: {error}"))?;
    let store = LocalMachineTrustedPeople::open(false)?;
    let mut added: *mut CERT_CONTEXT = std::ptr::null_mut();
    unsafe {
        step(
            "trust certificate",
            CertAddEncodedCertificateToStore(
                Some(store.0),
                X509_ASN_ENCODING,
                &bytes,
                CERT_STORE_ADD_REPLACE_EXISTING,
                Some(&mut added),
            ),
        )?;
        if !is_ours(added) {
            let _ = CertDeleteCertificateFromStore(added);
            return Err("not a certificate this DLL made; refused".into());
        }
        let name: Vec<u16> = FRIENDLY_NAME.encode_utf16().chain([0]).collect();
        let name_blob = CRYPT_INTEGER_BLOB {
            cbData: (name.len() * 2) as u32,
            pbData: name.as_ptr() as *mut u8,
        };
        let _ = CertSetCertificateContextProperty(
            added,
            CERT_FRIENDLY_NAME_PROP_ID,
            0,
            Some(&name_blob as *const _ as *const c_void),
        );
        let _ = CertFreeCertificateContext(Some(added));
    }
    let mut removed = 0;
    for certificate in store.ours()? {
        unsafe {
            if encoded(certificate) == bytes.as_slice() {
                let _ = CertFreeCertificateContext(Some(certificate));
            } else {
                step(
                    "untrust an earlier certificate",
                    CertDeleteCertificateFromStore(certificate),
                )?;
                removed += 1;
            }
        }
    }
    Ok(format!(
        "certificate trusted; {removed} earlier one(s) removed"
    ))
}

struct LocalMachineTrustedPeople(HCERTSTORE);

impl LocalMachineTrustedPeople {
    fn open(read_only: bool) -> Result<Self, String> {
        let flags = CERT_SYSTEM_STORE_LOCAL_MACHINE
            | if read_only {
                CERT_STORE_READONLY_FLAG.0
            } else {
                0
            };
        let store = unsafe {
            CertOpenStore(
                CERT_STORE_PROV_SYSTEM_W,
                Default::default(),
                None,
                CERT_OPEN_STORE_FLAGS(flags),
                Some(w!("TrustedPeople").as_ptr() as *const c_void),
            )
        };
        step("open Trusted People", store).map(LocalMachineTrustedPeople)
    }

    /// Our certificates in the store, by subject and issuer: owned duplicates, each to be freed or deleted.
    fn ours(&self) -> Result<Vec<*mut CERT_CONTEXT>, String> {
        let mut found = Vec::new();
        let mut current: *mut CERT_CONTEXT = std::ptr::null_mut();
        unsafe {
            loop {
                current = CertEnumCertificatesInStore(self.0, Some(current));
                if current.is_null() {
                    break;
                }
                if is_ours(current) {
                    found.push(CertDuplicateCertificateContext(Some(current)));
                }
            }
        }
        Ok(found)
    }

    fn holds(&self, certificate: *const CERT_CONTEXT) -> Result<bool, String> {
        let mut held = false;
        for candidate in self.ours()? {
            unsafe {
                held |= encoded(candidate) == encoded(certificate);
                let _ = CertFreeCertificateContext(Some(candidate));
            }
        }
        Ok(held)
    }
}

impl Drop for LocalMachineTrustedPeople {
    fn drop(&mut self) {
        unsafe {
            let _ = CertCloseStore(Some(self.0), 0);
        }
    }
}

/* THE CERTIFICATE */

struct Certificate {
    provider: NCRYPT_PROV_HANDLE,
    key: NCRYPT_KEY_HANDLE,
    context: *mut CERT_CONTEXT,
}

impl Certificate {
    fn create() -> Result<Self, String> {
        let mut certificate = Certificate {
            provider: NCRYPT_PROV_HANDLE::default(),
            key: NCRYPT_KEY_HANDLE::default(),
            context: std::ptr::null_mut(),
        };
        // A persisted key, under a name of its own, because the signer finds a certificate's key by the name its
        // properties carry. It lives for the length of one registration: dropping the certificate deletes it.
        let container: Vec<u16> = format!(
            "Intentic-ExplorerMenu-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|elapsed| elapsed.as_nanos())
                .unwrap_or_default()
        )
        .encode_utf16()
        .chain([0])
        .collect();
        unsafe {
            step(
                "key storage provider",
                NCryptOpenStorageProvider(&mut certificate.provider, MS_KEY_STORAGE_PROVIDER, 0),
            )?;
            step(
                "create key",
                NCryptCreatePersistedKey(
                    certificate.provider,
                    &mut certificate.key,
                    BCRYPT_RSA_ALGORITHM,
                    PCWSTR(container.as_ptr()),
                    CERT_KEY_SPEC(0),
                    NCRYPT_OVERWRITE_KEY_FLAG,
                ),
            )?;
            step(
                "key length",
                NCryptSetProperty(
                    NCRYPT_HANDLE(certificate.key.0),
                    NCRYPT_LENGTH_PROPERTY,
                    &2048u32.to_le_bytes(),
                    NCRYPT_FLAGS(0),
                ),
            )?;
            step(
                "finalize key",
                NCryptFinalizeKey(certificate.key, NCRYPT_SILENT_FLAG),
            )?;

            let subject = subject_name()?;
            let subject_blob = blob_of(&subject);
            // Code signing, an end entity, digital signatures only: what app deployment asks of a package's signer.
            let mut code_signing = PSTR(szOID_PKIX_KP_CODE_SIGNING.0 as *mut u8);
            let usage = encode(
                X509_ENHANCED_KEY_USAGE,
                &CTL_USAGE {
                    cUsageIdentifier: 1,
                    rgpszUsageIdentifier: &mut code_signing,
                },
            )?;
            let constraints = encode(
                X509_BASIC_CONSTRAINTS2,
                &CERT_BASIC_CONSTRAINTS2_INFO {
                    fCA: false.into(),
                    fPathLenConstraint: false.into(),
                    dwPathLenConstraint: 0,
                },
            )?;
            let mut key_usage_bits = [CERT_DIGITAL_SIGNATURE_KEY_USAGE as u8];
            let key_usage = encode(
                X509_KEY_USAGE,
                &CRYPT_BIT_BLOB {
                    cbData: 1,
                    pbData: key_usage_bits.as_mut_ptr(),
                    cUnusedBits: 7,
                },
            )?;
            let mut extensions = [
                extension(szOID_ENHANCED_KEY_USAGE, &usage),
                extension(szOID_BASIC_CONSTRAINTS2, &constraints),
                extension(szOID_KEY_USAGE, &key_usage),
            ];
            let extensions = CERT_EXTENSIONS {
                cExtension: extensions.len() as u32,
                rgExtension: extensions.as_mut_ptr(),
            };
            let provider_info = CRYPT_KEY_PROV_INFO {
                pwszContainerName: PWSTR(container.as_ptr() as *mut u16),
                pwszProvName: PWSTR(MS_KEY_STORAGE_PROVIDER.0 as *mut u16),
                dwProvType: 0,
                dwFlags: CRYPT_KEY_FLAGS(0),
                cProvParam: 0,
                rgProvParam: std::ptr::null_mut(),
                dwKeySpec: 0,
            };
            let algorithm = CRYPT_ALGORITHM_IDENTIFIER {
                pszObjId: PSTR(szOID_RSA_SHA256RSA.0 as *mut u8),
                Parameters: CRYPT_INTEGER_BLOB::default(),
            };
            // Valid from yesterday (a clock a little behind must not see it as not yet valid) for twenty years: the key
            // is gone in a moment, so the length only decides how long Windows keeps accepting the package it signed.
            let (start, end) = (days_from_now(-1)?, days_from_now(20 * 365)?);
            certificate.context = CertCreateSelfSignCertificate(
                Some(HCRYPTPROV_OR_NCRYPT_KEY_HANDLE(certificate.key.0)),
                &subject_blob,
                CERT_CREATE_SELFSIGN_FLAGS(0),
                Some(&provider_info),
                Some(&algorithm),
                Some(&start),
                Some(&end),
                Some(&extensions),
            );
            if certificate.context.is_null() {
                return Err(format!(
                    "create certificate: {}",
                    windows_core::Error::from_win32()
                ));
            }
        }
        Ok(certificate)
    }

    /// Sign the package the way signtool does: SignerSignEx2 with the app-package SIP's own client data, without which
    /// the SIP refuses ("The SIP_SUBJECTINFO structure used to sign the package didn't contain the required data", the
    /// answer PowerShell's Set-AuthenticodeSignature gets for an .msix).
    fn sign(&self, package: &Path) -> Result<(), String> {
        let path = HSTRING::from(package.as_os_str());
        let mut index = 0u32;
        let file = SIGNER_FILE_INFO {
            cbSize: std::mem::size_of::<SIGNER_FILE_INFO>() as u32,
            pwszFileName: PCWSTR(path.as_ptr()),
            hFile: HANDLE::default(),
        };
        let subject = SIGNER_SUBJECT_INFO {
            cbSize: std::mem::size_of::<SIGNER_SUBJECT_INFO>() as u32,
            pdwIndex: &mut index,
            dwSubjectChoice: SIGNER_SUBJECT_FILE,
            Anonymous: SIGNER_SUBJECT_INFO_0 {
                pSignerFileInfo: &file as *const _ as *mut _,
            },
        };
        let store = SIGNER_CERT_STORE_INFO {
            cbSize: std::mem::size_of::<SIGNER_CERT_STORE_INFO>() as u32,
            pSigningCert: self.context,
            dwCertPolicy: SIGNER_CERT_POLICY_CHAIN,
            hCertStore: HCERTSTORE::default(),
        };
        let signer = SIGNER_CERT {
            cbSize: std::mem::size_of::<SIGNER_CERT>() as u32,
            dwCertChoice: SIGNER_CERT_STORE,
            Anonymous: SIGNER_CERT_0 {
                pCertStoreInfo: &store as *const _ as *mut _,
            },
            hwnd: HWND::default(),
        };
        // SHA-256, which must be the hash the package's block map was written with (write_package).
        let signature = SIGNER_SIGNATURE_INFO {
            cbSize: std::mem::size_of::<SIGNER_SIGNATURE_INFO>() as u32,
            algidHash: CALG_SHA_256,
            dwAttrChoice: SIGNER_NO_ATTR,
            ..Default::default()
        };
        let mut context: *mut SIGNER_CONTEXT = std::ptr::null_mut();
        let mut params = SignerSignEx2Params {
            dwFlags: 0,
            pSubjectInfo: &subject,
            pSigningCert: &signer,
            pSignatureInfo: &signature,
            pProviderInfo: std::ptr::null(),
            dwTimestampFlags: 0,
            pszAlgorithmOid: PCSTR::null(),
            pwszTimestampURL: PCWSTR::null(),
            pCryptAttrs: std::ptr::null(),
            pSipData: std::ptr::null_mut(),
            pSignerContext: &mut context,
            pCryptoPolicy: std::ptr::null(),
            pReserved: std::ptr::null(),
        };
        let mut sip = AppxSipClientData {
            pSignerParams: &mut params,
            pAppxSipState: std::ptr::null_mut(),
        };
        params.pSipData = &mut sip as *mut _ as *mut c_void;
        let signed = unsafe {
            SignerSignEx2(
                SIGNER_SIGN_FLAGS(params.dwFlags),
                params.pSubjectInfo,
                params.pSigningCert,
                params.pSignatureInfo,
                None,
                None,
                PCSTR::null(),
                PCWSTR::null(),
                None,
                Some(params.pSipData as *const c_void),
                params.pSignerContext,
                None,
                None,
            )
        };
        unsafe {
            if !sip.pAppxSipState.is_null() {
                // An IUnknown the SIP hands back for the caller to release.
                drop(windows_core::IUnknown::from_raw(sip.pAppxSipState));
            }
            if !context.is_null() {
                let _ = SignerFreeSignerContext(context);
            }
        }
        step("sign package", signed)
    }
}

impl Drop for Certificate {
    fn drop(&mut self) {
        unsafe {
            if !self.context.is_null() {
                let _ = CertFreeCertificateContext(Some(self.context));
            }
            if !self.key.is_invalid() {
                // Deletes the key from disk and frees the handle.
                if NCryptDeleteKey(self.key, NCRYPT_SILENT_FLAG.0).is_err() {
                    let _ = NCryptFreeObject(NCRYPT_HANDLE(self.key.0));
                    log("could not delete the signing key");
                }
            }
            if !self.provider.is_invalid() {
                let _ = NCryptFreeObject(NCRYPT_HANDLE(self.provider.0));
            }
        }
    }
}

/// Issued by and to `LOCAL_PUBLISHER`, compared as text: the same name can be encoded more than one way (Windows writes a
/// PrintableString, OpenSSL a UTF8String), and a byte comparison of the two says they differ.
unsafe fn is_ours(certificate: *const CERT_CONTEXT) -> bool {
    let info = &*(*certificate).pCertInfo;
    name_text(&info.Subject) == LOCAL_PUBLISHER && name_text(&info.Issuer) == LOCAL_PUBLISHER
}

unsafe fn name_text(name: &CRYPT_INTEGER_BLOB) -> String {
    let length = CertNameToStrW(X509_ASN_ENCODING, name, CERT_X500_NAME_STR, None);
    let mut buffer = vec![0u16; length as usize];
    let written = CertNameToStrW(
        X509_ASN_ENCODING,
        name,
        CERT_X500_NAME_STR,
        Some(&mut buffer),
    );
    String::from_utf16_lossy(&buffer[..written.saturating_sub(1) as usize])
}

unsafe fn encoded<'a>(certificate: *const CERT_CONTEXT) -> &'a [u8] {
    std::slice::from_raw_parts(
        (*certificate).pbCertEncoded,
        (*certificate).cbCertEncoded as usize,
    )
}

fn blob_of(bytes: &[u8]) -> CRYPT_INTEGER_BLOB {
    CRYPT_INTEGER_BLOB {
        cbData: bytes.len() as u32,
        pbData: bytes.as_ptr() as *mut u8,
    }
}

fn subject_name() -> Result<Vec<u8>, String> {
    let name = HSTRING::from(LOCAL_PUBLISHER);
    let mut size = 0u32;
    unsafe {
        step(
            "subject name",
            CertStrToNameW(
                X509_ASN_ENCODING,
                &name,
                CERT_X500_NAME_STR,
                None,
                None,
                &mut size,
                None,
            ),
        )?;
        let mut bytes = vec![0u8; size as usize];
        step(
            "subject name",
            CertStrToNameW(
                X509_ASN_ENCODING,
                &name,
                CERT_X500_NAME_STR,
                None,
                Some(bytes.as_mut_ptr()),
                &mut size,
                None,
            ),
        )?;
        bytes.truncate(size as usize);
        Ok(bytes)
    }
}

fn encode<T>(kind: PCSTR, value: &T) -> Result<Vec<u8>, String> {
    let mut size = 0u32;
    let info = value as *const T as *const c_void;
    unsafe {
        step(
            "encode extension",
            CryptEncodeObjectEx(
                X509_ASN_ENCODING,
                kind,
                info,
                CRYPT_ENCODE_OBJECT_FLAGS(0),
                None,
                None,
                &mut size,
            ),
        )?;
        let mut bytes = vec![0u8; size as usize];
        step(
            "encode extension",
            CryptEncodeObjectEx(
                X509_ASN_ENCODING,
                kind,
                info,
                CRYPT_ENCODE_OBJECT_FLAGS(0),
                None,
                Some(bytes.as_mut_ptr() as *mut c_void),
                &mut size,
            ),
        )?;
        bytes.truncate(size as usize);
        Ok(bytes)
    }
}

fn extension(oid: PCSTR, value: &[u8]) -> CERT_EXTENSION {
    CERT_EXTENSION {
        pszObjId: PSTR(oid.0 as *mut u8),
        fCritical: false.into(),
        Value: blob_of(value),
    }
}

fn days_from_now(days: i64) -> Result<SYSTEMTIME, String> {
    unsafe {
        let now = GetSystemTime();
        let mut file = FILETIME::default();
        step("clock", SystemTimeToFileTime(&now, &mut file))?;
        let ticks = ((file.dwHighDateTime as i64) << 32 | file.dwLowDateTime as i64)
            + days * 864_000_000_000;
        let file = FILETIME {
            dwLowDateTime: ticks as u32,
            dwHighDateTime: (ticks >> 32) as u32,
        };
        let mut time = SYSTEMTIME::default();
        step("clock", FileTimeToSystemTime(&file, &mut time))?;
        Ok(time)
    }
}

/* What SignerSignEx2 needs for an app package and windows-rs does not declare: the parameter block the app-package SIP
 * reads back through its client data. Laid out as Microsoft's "How to programmatically sign an app package" gives it. */
#[repr(C)]
#[allow(non_snake_case)]
struct SignerSignEx2Params {
    dwFlags: u32,
    pSubjectInfo: *const SIGNER_SUBJECT_INFO,
    pSigningCert: *const SIGNER_CERT,
    pSignatureInfo: *const SIGNER_SIGNATURE_INFO,
    pProviderInfo: *const SIGNER_PROVIDER_INFO,
    dwTimestampFlags: u32,
    pszAlgorithmOid: PCSTR,
    pwszTimestampURL: PCWSTR,
    pCryptAttrs: *const CRYPT_ATTRIBUTES,
    pSipData: *mut c_void,
    pSignerContext: *mut *mut SIGNER_CONTEXT,
    pCryptoPolicy: *const c_void,
    pReserved: *const c_void,
}

#[repr(C)]
#[allow(non_snake_case)]
struct AppxSipClientData {
    pSignerParams: *mut SignerSignEx2Params,
    pAppxSipState: *mut c_void,
}
