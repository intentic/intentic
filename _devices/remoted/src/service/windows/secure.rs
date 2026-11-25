//! What keeps the service to its owner: access lists on its folder, its secret and its pipe; whose the client binary
//! is; the per-boot secret; and the policy that lets a service send Ctrl+Alt+Del.

use std::path::Path;
use windows::Win32::Foundation::{CloseHandle, HANDLE, HLOCAL, LocalFree};
use windows::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
    GetNamedSecurityInfoW, SDDL_REVISION_1, SE_FILE_OBJECT,
};
use windows::Win32::Security::{
    DACL_SECURITY_INFORMATION, GetTokenInformation, OWNER_SECURITY_INFORMATION,
    PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID, SetFileSecurityW,
    TOKEN_ELEVATION, TOKEN_QUERY, TOKEN_USER, TokenElevation, TokenUser,
};
use windows::Win32::System::Registry::{
    HKEY, HKEY_LOCAL_MACHINE, KEY_QUERY_VALUE, KEY_SET_VALUE, REG_DWORD, RegCloseKey,
    RegDeleteValueW, RegOpenKeyExW, RegQueryValueExW, RegSetValueExW,
};
use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
use windows::core::PCWSTR;

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn wide_path(p: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    p.as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

/// Whether this process runs elevated (an administrator's yes was given).
pub fn elevated() -> bool {
    let mut token = HANDLE::default();
    // SAFETY: this process's token, queried and closed.
    unsafe {
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_err() {
            return false;
        }
        let mut e = TOKEN_ELEVATION::default();
        let mut len = 0u32;
        let ok = GetTokenInformation(
            token,
            TokenElevation,
            Some(std::ptr::from_mut(&mut e).cast()),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut len,
        )
        .is_ok();
        let _ = CloseHandle(token);
        ok && e.TokenIsElevated != 0
    }
}

/// The SID (`S-1-5-21-…`) owning a file: whose the agent's remoted is, so the pipe and the secret are that user's even
/// when the administrator who said yes is someone else.
pub fn owner_sid(path: &Path) -> Result<String, String> {
    let name = wide_path(path);
    let mut owner = PSID::default();
    let mut sd = PSECURITY_DESCRIPTOR::default();
    // SAFETY: a zero-terminated path and out-pointers; the descriptor (which holds the owner) is freed below.
    unsafe {
        let r = GetNamedSecurityInfoW(
            PCWSTR(name.as_ptr()),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION,
            Some(&mut owner),
            None,
            None,
            None,
            &mut sd,
        );
        if r.0 != 0 {
            return Err(format!("the owner of {}: error {}", path.display(), r.0));
        }
        let out = sid_string(owner);
        let _ = LocalFree(Some(HLOCAL(sd.0)));
        out
    }
}

/// The SID of the user this process runs as.
pub fn current_user_sid() -> Result<String, String> {
    let mut token = HANDLE::default();
    // SAFETY: this process's token, queried into a buffer sized by the first call, and closed.
    unsafe {
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token)
            .map_err(|e| e.to_string())?;
        let mut len = 0u32;
        let _ = GetTokenInformation(token, TokenUser, None, 0, &mut len);
        let mut buffer = vec![0u64; (len as usize).div_ceil(8)];
        let read = GetTokenInformation(
            token,
            TokenUser,
            Some(buffer.as_mut_ptr().cast()),
            len,
            &mut len,
        );
        let _ = CloseHandle(token);
        read.map_err(|e| e.to_string())?;
        let user = &*buffer.as_ptr().cast::<TOKEN_USER>();
        sid_string(user.User.Sid)
    }
}

/// A SID as its string.
fn sid_string(sid: PSID) -> Result<String, String> {
    let mut text = windows::core::PWSTR::null();
    // SAFETY: a valid SID and an out-pointer, freed below.
    unsafe {
        ConvertSidToStringSidW(sid, &mut text).map_err(|e| e.to_string())?;
        let out = text.to_string().map_err(|e| e.to_string());
        let _ = LocalFree(Some(HLOCAL(text.0.cast())));
        out
    }
}

/// Replaces a file's or folder's access list with `sddl`'s, protected from inheriting its parent's.
pub fn set_acl(path: &Path, sddl: &str) -> Result<(), String> {
    let text = wide(sddl);
    let name = wide_path(path);
    let mut sd = PSECURITY_DESCRIPTOR::default();
    // SAFETY: a zero-terminated SDDL string, the descriptor it makes (freed below), and a zero-terminated path.
    unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            PCWSTR(text.as_ptr()),
            SDDL_REVISION_1,
            &mut sd,
            None,
        )
        .map_err(|e| format!("{sddl:?}: {e}"))?;
        let ok = SetFileSecurityW(
            PCWSTR(name.as_ptr()),
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            sd,
        )
        .as_bool();
        let _ = LocalFree(Some(HLOCAL(sd.0)));
        if ok {
            Ok(())
        } else {
            Err(format!(
                "the access list of {}: {}",
                path.display(),
                std::io::Error::last_os_error()
            ))
        }
    }
}

/// A security descriptor made from SDDL, freed when dropped.
pub struct Descriptor(PSECURITY_DESCRIPTOR);

impl Descriptor {
    pub fn new(sddl: &str) -> Result<Descriptor, String> {
        let text = wide(sddl);
        let mut sd = PSECURITY_DESCRIPTOR::default();
        // SAFETY: a zero-terminated SDDL string and an out-pointer, freed by Drop.
        unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                PCWSTR(text.as_ptr()),
                SDDL_REVISION_1,
                &mut sd,
                None,
            )
        }
        .map_err(|e| format!("{sddl:?}: {e}"))?;
        Ok(Descriptor(sd))
    }

    /// Attributes naming this descriptor, not inherited; valid while `self` lives.
    pub fn attributes(&self) -> windows::Win32::Security::SECURITY_ATTRIBUTES {
        windows::Win32::Security::SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<windows::Win32::Security::SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: self.0.0,
            bInheritHandle: false.into(),
        }
    }
}

// SAFETY: the descriptor is this value's own allocation, read-only once made, and freed only by Drop.
unsafe impl Send for Descriptor {}

impl Drop for Descriptor {
    fn drop(&mut self) {
        // SAFETY: the descriptor ConvertString… allocated.
        unsafe {
            let _ = LocalFree(Some(HLOCAL(self.0.0)));
        }
    }
}

/// 32 random bytes as hex, from the system's generator.
pub fn random_secret() -> Result<String, String> {
    use windows::Win32::Security::Cryptography::{
        BCRYPT_USE_SYSTEM_PREFERRED_RNG, BCryptGenRandom,
    };
    let mut bytes = [0u8; 32];
    // SAFETY: a buffer to fill.
    let r = unsafe { BCryptGenRandom(None, &mut bytes, BCRYPT_USE_SYSTEM_PREFERRED_RNG) };
    if r.0 != 0 {
        return Err(format!("BCryptGenRandom: {:#x}", r.0));
    }
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

const POLICY_KEY: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System";
const SAS_VALUE: &str = "SoftwareSASGeneration";

fn policy_key(access: windows::Win32::System::Registry::REG_SAM_FLAGS) -> Result<HKEY, String> {
    let key = wide(POLICY_KEY);
    let mut h = HKEY::default();
    // SAFETY: a zero-terminated subkey and an out-pointer.
    let r = unsafe {
        RegOpenKeyExW(
            HKEY_LOCAL_MACHINE,
            PCWSTR(key.as_ptr()),
            None,
            access,
            &mut h,
        )
    };
    if r.0 != 0 {
        return Err(format!("HKLM\\{POLICY_KEY}: error {}", r.0));
    }
    Ok(h)
}

/// `SoftwareSASGeneration` now (None: not set, which lets no service send Ctrl+Alt+Del).
pub fn sas_policy() -> Option<u32> {
    let h = policy_key(KEY_QUERY_VALUE).ok()?;
    let name = wide(SAS_VALUE);
    let mut value = 0u32;
    let mut size = 4u32;
    // SAFETY: the key opened above, a zero-terminated value name and a 4-byte buffer.
    let r = unsafe {
        let r = RegQueryValueExW(
            h,
            PCWSTR(name.as_ptr()),
            None,
            None,
            Some(std::ptr::from_mut(&mut value).cast()),
            Some(&mut size),
        );
        let _ = RegCloseKey(h);
        r
    };
    (r.0 == 0).then_some(value)
}

/// Sets `SoftwareSASGeneration` (None deletes it).
pub fn set_sas_policy(value: Option<u32>) -> Result<(), String> {
    let h = policy_key(KEY_SET_VALUE)?;
    let name = wide(SAS_VALUE);
    // SAFETY: the key opened above and a zero-terminated value name; closed after.
    let r = unsafe {
        let r = match value {
            Some(v) => RegSetValueExW(
                h,
                PCWSTR(name.as_ptr()),
                None,
                REG_DWORD,
                Some(&v.to_le_bytes()),
            ),
            None => RegDeleteValueW(h, PCWSTR(name.as_ptr())),
        };
        let _ = RegCloseKey(h);
        r
    };
    // ERROR_FILE_NOT_FOUND deleting a value that is not there is what was wanted.
    if r.0 == 0 || (value.is_none() && r.0 == 2) {
        Ok(())
    } else {
        Err(format!("{SAS_VALUE}: error {}", r.0))
    }
}

/// Whether the policy lets a service send Ctrl+Alt+Del (1: services, 3: services and ease of access applications).
pub fn sas_allows_services(value: Option<u32>) -> bool {
    matches!(value, Some(1 | 3))
}

/// Sends Ctrl+Alt+Del to the console session, as a service may when the policy allows it.
pub fn send_sas() {
    #[link(name = "sas", kind = "raw-dylib")]
    unsafe extern "system" {
        fn SendSAS(as_user: i32);
    }
    // SAFETY: a plain call; FALSE because the caller is a service.
    unsafe { SendSAS(0) };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_policy_naming_services_lets_the_service_send_ctrl_alt_del() {
        assert!(!sas_allows_services(None));
        assert!(!sas_allows_services(Some(0)));
        assert!(sas_allows_services(Some(1)));
        assert!(!sas_allows_services(Some(2)));
        assert!(sas_allows_services(Some(3)));
    }
}
