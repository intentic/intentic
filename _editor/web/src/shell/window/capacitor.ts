/* The native shell's bridge, as this app sees it. The iOS app (_editor/ios-app) is a thin Capacitor shell
 * around the HOSTED web app, the same pattern as the desktop shell, and for the same reason: one product
 * codebase, thin wrappers. The shell loads app.intentic.dev remotely and injects its bridge into the page, so
 * this package takes NO Capacitor dependency: everything native arrives as `window.Capacitor`, and this file
 * is the one place that global is named and typed. Everything above it asks these functions, which all answer
 * "not a shell" in an ordinary browser, the app must degrade to plain web behaviour with no other file
 * knowing the difference. */

export interface PushPermission {
    receive: "prompt" | "prompt-with-rationale" | "granted" | "denied";
}

// A delivered notification's payload as the tap handler receives it. `data` carries whatever rode the APNs
// custom keys, for us, the daemon's `url` pointer back into the workspace.
export interface NotificationTap {
    notification: { data?: { url?: string } };
}

// The @capacitor/push-notifications plugin surface this app actually uses, typed by hand because the plugin
// arrives injected, not imported.
export interface PushNotificationsPlugin {
    checkPermissions(): Promise<PushPermission>;
    requestPermissions(): Promise<PushPermission>;
    register(): Promise<void>;
    addListener(event: "registration", handler: (token: { value: string }) => void): Promise<{ remove: () => Promise<void> }>;
    addListener(event: "registrationError", handler: (error: { error: string }) => void): Promise<{ remove: () => Promise<void> }>;
    addListener(event: "pushNotificationActionPerformed", handler: (tap: NotificationTap) => void): Promise<{ remove: () => Promise<void> }>;
}

interface CapacitorGlobal {
    isNativePlatform?: () => boolean;
    getPlatform?: () => string;
    Plugins?: { PushNotifications?: PushNotificationsPlugin };
}

// `typeof` guard because this is asked at module-evaluation time (the driver pick), including under test
// runners with no window at all.
const capacitor = (): CapacitorGlobal | undefined =>
    typeof window === `undefined` ? undefined : (window as Window & { Capacitor?: CapacitorGlobal }).Capacitor;

// True only inside the native iOS shell. The Android app is a TWA, real Chrome, no bridge, and lands on
// the plain web path by construction, which is exactly right: its push is ordinary web push.
export const inNativeShell = (): boolean => {
    const bridge = capacitor();
    return bridge?.isNativePlatform?.() === true && bridge.getPlatform?.() === "ios";
};

// The push plugin, or undefined outside the shell, the drivers and the tap wiring both start here.
export const pushPlugin = (): PushNotificationsPlugin | undefined => (inNativeShell() ? capacitor()?.Plugins?.PushNotifications : undefined);
