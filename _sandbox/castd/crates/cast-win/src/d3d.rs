//! A D3D11 device on one adapter, shared by the threads of one screen: the duplication thread copies the desktop's
//! damage into a texture of its own, the capture thread copies it on into the frame the encoder reads, the encode
//! thread hands that frame to NVENC or a Media Foundation transform. Multithread protection serialises the immediate
//! context between them.

use crate::displays::Adapter;
use std::any::Any;
use windows::Win32::Foundation::{CloseHandle, HANDLE, HMODULE};
use windows::Win32::Graphics::Direct3D::{
    D3D_DRIVER_TYPE_UNKNOWN, D3D_FEATURE_LEVEL, D3D_FEATURE_LEVEL_10_0, D3D_FEATURE_LEVEL_10_1,
    D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_11_1,
};
use windows::Win32::Graphics::Direct3D11::{
    D3D11_BIND_FLAG, D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE, D3D11_BOX,
    D3D11_CPU_ACCESS_READ, D3D11_CPU_ACCESS_WRITE, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
    D3D11_CREATE_DEVICE_VIDEO_SUPPORT, D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX,
    D3D11_RESOURCE_MISC_SHARED_NTHANDLE, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC,
    D3D11_USAGE_DEFAULT, D3D11_USAGE_STAGING, D3D11CreateDevice, ID3D11Device, ID3D11Device1,
    ID3D11DeviceContext, ID3D11Multithread, ID3D11Texture2D,
};
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_FORMAT, DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC,
};
use windows::Win32::Graphics::Dxgi::{
    DXGI_SHARED_RESOURCE_READ, DXGI_SHARED_RESOURCE_WRITE, IDXGIKeyedMutex, IDXGIResource1,
};
use windows::core::Interface;

/// One adapter's device and its immediate context.
#[derive(Clone)]
pub struct Device {
    pub device: ID3D11Device,
    pub ctx: ID3D11DeviceContext,
    pub adapter: Adapter,
}

// The device is free-threaded and its context protected (`new` turns multithread protection on).
unsafe impl Send for Device {}
unsafe impl Sync for Device {}

impl Device {
    /// A device on `adapter`, with BGRA (the desktop's format) and video (Media Foundation, the video processor).
    pub fn new(adapter: &Adapter) -> Result<Device, String> {
        let levels: [D3D_FEATURE_LEVEL; 4] = [
            D3D_FEATURE_LEVEL_11_1,
            D3D_FEATURE_LEVEL_11_0,
            D3D_FEATURE_LEVEL_10_1,
            D3D_FEATURE_LEVEL_10_0,
        ];
        let mut device = None;
        let mut ctx = None;
        let flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT;
        // SAFETY: an adapter DXGI gave out, and out-pointers to fill.
        unsafe {
            D3D11CreateDevice(
                &adapter.adapter,
                D3D_DRIVER_TYPE_UNKNOWN,
                HMODULE::default(),
                flags,
                Some(&levels),
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut ctx),
            )
        }
        .map_err(|e| format!("D3D11CreateDevice on {}: {e}", adapter.name))?;
        let device: ID3D11Device = device.ok_or("D3D11CreateDevice made no device")?;
        let ctx: ID3D11DeviceContext = ctx.ok_or("D3D11CreateDevice made no context")?;
        if let Ok(mt) = device.cast::<ID3D11Multithread>() {
            // SAFETY: a plain flag on the device's own lock.
            let _ = unsafe { mt.SetMultithreadProtected(true) };
        }
        Ok(Device {
            device,
            ctx,
            adapter: adapter.clone(),
        })
    }

    /// Whether `other` is on the same GPU, so a texture of one can be read by the other's encoder in place.
    pub fn same_gpu(&self, other: &Device) -> bool {
        self.adapter.luid == other.adapter.luid
    }

    /// Why the device stopped working (a driver update, a GPU reset), or None while it works.
    pub fn removed(&self) -> Option<String> {
        // SAFETY: a plain query.
        match unsafe { self.device.GetDeviceRemovedReason() } {
            Ok(()) => None,
            Err(e) => Some(e.to_string()),
        }
    }

    /// A BGRA texture in video memory that copies land in and encoders read.
    pub fn texture(&self, w: u32, h: u32) -> Result<ID3D11Texture2D, String> {
        self.texture2d(
            w,
            h,
            DXGI_FORMAT_B8G8R8A8_UNORM,
            D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE,
            Cpu::None,
        )
    }

    /// A BGRA texture in video memory another device on the same GPU opens (`open_shared`), guarded by a keyed mutex.
    pub fn shared_texture(&self, w: u32, h: u32) -> Result<(ID3D11Texture2D, Shared), String> {
        let desc = D3D11_TEXTURE2D_DESC {
            Width: w,
            Height: h,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: (D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE).0 as u32,
            CPUAccessFlags: 0,
            MiscFlags: (D3D11_RESOURCE_MISC_SHARED_NTHANDLE | D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX)
                .0 as u32,
        };
        let mut tex = None;
        // SAFETY: a description and an out-pointer.
        unsafe { self.device.CreateTexture2D(&desc, None, Some(&mut tex)) }
            .map_err(|e| format!("CreateTexture2D (shared) {w}x{h}: {e}"))?;
        let tex: ID3D11Texture2D = tex.ok_or("CreateTexture2D made no texture")?;
        let res: IDXGIResource1 = tex.cast().map_err(|e| e.to_string())?;
        // SAFETY: a handle this process owns until `Shared` drops it.
        let handle = unsafe {
            res.CreateSharedHandle(
                None,
                DXGI_SHARED_RESOURCE_READ.0 | DXGI_SHARED_RESOURCE_WRITE.0,
                windows::core::PCWSTR::null(),
            )
        }
        .map_err(|e| format!("CreateSharedHandle: {e}"))?;
        Ok((tex, Shared(handle)))
    }

    /// Opens a texture another device made with `shared_texture`.
    pub fn open_shared(&self, shared: &Shared) -> Result<ID3D11Texture2D, String> {
        let d1: ID3D11Device1 = self.device.cast().map_err(|e| e.to_string())?;
        // SAFETY: a live NT handle to a shared texture.
        unsafe { d1.OpenSharedResource1::<ID3D11Texture2D>(shared.0) }
            .map_err(|e| format!("OpenSharedResource1 on {}: {e}", self.adapter.name))
    }

    /// A BGRA texture the CPU reads (`read`) or writes, for moving pictures between memory and the GPU.
    pub fn staging(&self, w: u32, h: u32, read: bool) -> Result<ID3D11Texture2D, String> {
        self.texture2d(
            w,
            h,
            DXGI_FORMAT_B8G8R8A8_UNORM,
            D3D11_BIND_FLAG(0),
            if read { Cpu::Read } else { Cpu::Write },
        )
    }

    fn texture2d(
        &self,
        w: u32,
        h: u32,
        format: DXGI_FORMAT,
        bind: D3D11_BIND_FLAG,
        cpu: Cpu,
    ) -> Result<ID3D11Texture2D, String> {
        let desc = D3D11_TEXTURE2D_DESC {
            Width: w,
            Height: h,
            MipLevels: 1,
            ArraySize: 1,
            Format: format,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: match cpu {
                Cpu::None => D3D11_USAGE_DEFAULT,
                _ => D3D11_USAGE_STAGING,
            },
            BindFlags: bind.0 as u32,
            CPUAccessFlags: match cpu {
                Cpu::None => 0,
                Cpu::Read => D3D11_CPU_ACCESS_READ.0 as u32,
                Cpu::Write => D3D11_CPU_ACCESS_WRITE.0 as u32,
            },
            MiscFlags: 0,
        };
        let mut tex = None;
        // SAFETY: a description and an out-pointer.
        unsafe { self.device.CreateTexture2D(&desc, None, Some(&mut tex)) }
            .map_err(|e| format!("CreateTexture2D {w}x{h}: {e}"))?;
        tex.ok_or_else(|| "CreateTexture2D made no texture".into())
    }

    /// Copies rows [y0, y1) and columns [x0, x1) of `src` to the same place in `dst` (both on this device).
    pub fn copy_rect(
        &self,
        dst: &ID3D11Texture2D,
        src: &ID3D11Texture2D,
        (x0, y0, x1, y1): (u32, u32, u32, u32),
    ) {
        if x1 <= x0 || y1 <= y0 {
            return;
        }
        let b = D3D11_BOX {
            left: x0,
            top: y0,
            front: 0,
            right: x1,
            bottom: y1,
            back: 1,
        };
        // SAFETY: two textures of this device, a box inside both (the callers clamp to the picture).
        unsafe {
            self.ctx
                .CopySubresourceRegion(dst, 0, x0, y0, 0, src, 0, Some(&b))
        };
    }
}

/// The NT handle of a shared texture, closed when dropped (each device that opened it keeps its own reference).
pub struct Shared(HANDLE);

// SAFETY: an NT handle, usable from any thread.
unsafe impl Send for Shared {}

impl Shared {
    /// A handle this process owns (one another process duplicated into it), closed when dropped.
    pub fn from_raw(handle: u64) -> Shared {
        Shared(HANDLE(handle as isize as *mut core::ffi::c_void))
    }

    /// The handle, still owned by this `Shared`.
    pub fn raw(&self) -> HANDLE {
        self.0
    }
}

impl Drop for Shared {
    fn drop(&mut self) {
        // SAFETY: the handle CreateSharedHandle gave this struct.
        let _ = unsafe { CloseHandle(self.0) };
    }
}

/// Holds a shared texture's keyed mutex (key 0 both ways: whoever holds it copies, the other waits) until dropped.
pub struct Held(IDXGIKeyedMutex);

impl Held {
    pub fn take(tex: &ID3D11Texture2D) -> Result<Held, String> {
        let m: IDXGIKeyedMutex = tex.cast().map_err(|e| e.to_string())?;
        // SAFETY: a keyed mutex of a texture this process holds; released by Drop.
        unsafe { m.AcquireSync(0, 1000) }.map_err(|e| format!("AcquireSync: {e}"))?;
        Ok(Held(m))
    }
}

impl Drop for Held {
    fn drop(&mut self) {
        // SAFETY: the key AcquireSync took.
        let _ = unsafe { self.0.ReleaseSync(0) };
    }
}

/// How the CPU reaches a texture: not at all (video memory), or a staging copy it reads or writes.
#[derive(Clone, Copy)]
enum Cpu {
    None,
    Read,
    Write,
}

/// A frame in video memory: cast-core's `Frame::Native`, a BGRA texture on the encoder's device that the capture fills
/// on the GPU and the encoder reads in place.
pub struct GpuFrame {
    pub texture: ID3D11Texture2D,
    pub width: u32,
    pub height: u32,
    /// The LUID of the adapter it lives on: an encoder refuses a frame from another GPU rather than misread it.
    pub luid: i64,
}

// One thread uses a frame at a time: the capture thread fills it, then hands it to the encode thread.
unsafe impl Send for GpuFrame {}

impl cast_core::frame::NativeFrame for GpuFrame {
    fn width(&self) -> u32 {
        self.width
    }
    fn height(&self) -> u32 {
        self.height
    }
    fn as_any(&self) -> &dyn Any {
        self
    }
    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }
}
