// The native shell's bridge, as this app sees it: the iOS app is a thin Capacitor wrapper loading the hosted web
// app remotely, so this package takes no Capacitor dependency — everything native arrives as `window.Capacitor`,
// named and typed only here. Every function below degrades to "not a shell" in an ordinary browser.

export interface PushPermission {
    receive: "prompt" | "prompt-with-rationale" | "granted" | "denied";
}

// A delivered notification's payload, as the tap handler receives it; `data.url` is the daemon's pointer back
// into the workspace.
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

// typeof guard because this is asked at module-evaluation time (the driver pick), including under test runners
// with no window at all.
const capacitor = (): CapacitorGlobal | undefined =>
    typeof window === `undefined` ? undefined : (window as Window & { Capacitor?: CapacitorGlobal }).Capacitor;

// True only inside the native iOS shell; the Android app is a TWA (real Chrome, no bridge) and uses ordinary web
// push instead.
export const inNativeShell = (): boolean => {
    const bridge = capacitor();
    return bridge?.isNativePlatform?.() === true && bridge.getPlatform?.() === "ios";
};

// The push plugin, or undefined outside the shell; the drivers and the tap wiring both start here.
export const pushPlugin = (): PushNotificationsPlugin | undefined => (inNativeShell() ? capacitor()?.Plugins?.PushNotifications : undefined);
