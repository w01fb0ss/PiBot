import desktop from "../desktop/package.json" with { type: "json" };
import { withPibotAndroid } from "./modules/pibot-android/plugin.ts";
import { withDataOnlyWebRtc } from "./plugins/with-data-only-webrtc.ts";
import { withLanDiscovery } from "./plugins/with-lan-discovery.ts";
import { nativePermissions } from "./src/i18n/messages.ts";

// The phone app carries the desktop's version so both ends of a release read the same number.
// Reserve two digits per component so build numbers follow release order: 1.2.3 → 10203.
const version = desktop.version;
const parts = /^(0|[1-9]\d?)\.(0|[1-9]\d?)\.(0|[1-9]\d?)$/u.exec(version);
if (!parts) throw new Error(`invalid_version ${version}`);
const [, major, minor, patch] = parts;
const buildNumber = Number(major) * 10000 + Number(minor) * 100 + Number(patch);
// The public version restarted at 0.0.1 after Android build 2 had shipped.
// Keep that offset: 0.0.3 shipped as 5, and 0.1.0 and 0.2.0 map to 102 and 202.
const androidBuildNumber = buildNumber + 2;

// The Expo account and project name where push tokens belong. They come from the builder's
// environment so each build uses its own account; without a project id the app runs with
// push turned off (src/push/notifications.ts reports "unconfigured").
const expoOwner = process.env.EXPO_OWNER || undefined;
const projectId = process.env.EXPO_PUBLIC_EAS_PROJECT_ID || process.env.EAS_PROJECT_ID || undefined;
if (projectId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId))
  throw new Error("invalid_eas_project_id");
// Firebase's Android config stays outside the repository; only a build that sets the path gets FCM.
// A leading "~" is expanded here too, since .env files and EAS do not expand it like a shell.
// Expo resolves a relative path from apps/mobile; an absolute one is used as is.
const home = process.env.HOME || process.env.USERPROFILE;
const googleServicesPath = process.env.GOOGLE_SERVICES_JSON;
const googleServicesFile =
  googleServicesPath && home
    ? googleServicesPath.replace(/^~(?=$|[\\/])/, home)
    : googleServicesPath || undefined;
// The READ_SMS fallback is declared in sideloaded builds only; a Google Play build sets
// PIBOT_PLAY_BUILD=1 (Play allows SMS permissions only for default SMS apps). docs/ios-build.md.
const playBuild = process.env.PIBOT_PLAY_BUILD === "1";
// The iOS share extension needs an App Group, i.e. a paid Apple developer account. Off by
// default so a free-account build signs; the app works without it (share sheet on Android only).
const iosShareExtension = process.env.PIBOT_IOS_SHARE_EXTENSION === "1";
const iosAppGroup = process.env.EXPO_PUBLIC_IOS_APP_GROUP || "group.space.pibot.mobile";
// iPhone remote push needs the aps-environment entitlement, which a free Apple ID (Personal Team)
// cannot sign. Off by default; in-app notifications work either way.
const iosPush = process.env.PIBOT_IOS_PUSH === "1";

export default {
  name: "Pi Bot",
  slug: "pi-bot-mobile",
  ...(expoOwner ? { owner: expoOwner } : {}),
  version,
  scheme: "pibot-mobile",
  // Generated from the desktop logo source: apps/desktop/scripts/icons/gen-mobile-icons.ts.
  icon: "./assets/icon.png",
  userInterfaceStyle: "automatic",
  platforms: ["ios", "android"],
  plugins: [
    // Expo runs mods in reverse registration order; permission cleanup must run last.
    withDataOnlyWebRtc,
    withLanDiscovery,
    "expo-router",
    ["@config-plugins/react-native-webrtc", { cameraPermission: nativePermissions.camera }],
    // libwebrtc references optional native decoders (e.g. org.webrtc.Dav1dDecoder$Natives) that the
    // prebuilt AAR does not ship; without these rules R8 aborts the release build.
    [
      "expo-build-properties",
      {
        android: {
          extraProguardRules: "-keep class org.webrtc.** { *; }\n-dontwarn org.webrtc.**",
        },
      },
    ],
    ["expo-camera", { cameraPermission: nativePermissions.camera, recordAudioAndroid: false }],
    "expo-secure-store",
    ["expo-local-authentication", { faceIDPermission: nativePermissions.unlock }],
    "expo-localization",
    [
      "expo-notifications",
      { enableRemoteNotifications: iosPush, enableBackgroundRemoteNotifications: iosPush },
    ],
    "expo-sqlite",
    // Saving an image needs add-only access; reading is asked only when the owner turns
    // on "Photos and videos" for a computer. No media-location permission: Bots never get GPS.
    [
      "expo-media-library",
      {
        photosPermission: nativePermissions.photos,
        savePhotosPermission: nativePermissions.photosAdd,
        isAccessMediaLocationEnabled: false,
        granularPermissions: ["photo", "video"],
      },
    ],
    // Attach in the composer: the system photo picker (no library access needed on iOS 14+ /
    // Android 13+), the camera (same text as pairing) and never the microphone (no video).
    // expo-document-picker needs no plugin: no iCloud container entitlement (free Apple ID).
    [
      "expo-image-picker",
      {
        photosPermission: nativePermissions.photos,
        cameraPermission: nativePermissions.camera,
        microphonePermission: false,
      },
    ],
    // Share to Pi Bot: images, files, links and text; unsupported types are refused in-app.
    [
      "expo-share-intent",
      {
        iosActivationRules: {
          NSExtensionActivationSupportsText: true,
          NSExtensionActivationSupportsWebURLWithMaxCount: 1,
          NSExtensionActivationSupportsWebPageWithMaxCount: 1,
          NSExtensionActivationSupportsImageWithMaxCount: 5,
          NSExtensionActivationSupportsFileWithMaxCount: 5,
        },
        iosAppGroupIdentifier: iosAppGroup,
        disableIOS: !iosShareExtension,
        androidIntentFilters: ["text/*", "image/*", "application/*"],
        androidMultiIntentFilters: ["image/*", "application/*"],
      },
    ],
    [withPibotAndroid, { readSms: !playBuild }],
  ],
  // Reverse of the official domain pibot.space.
  ios: {
    infoPlist: { NSLocalNetworkUsageDescription: nativePermissions.localNetwork },
    supportsTablet: true,
    bundleIdentifier: "space.pibot.mobile",
    buildNumber: String(buildNumber),
  },
  android: {
    // expo-network is autolinked (it has no config plugin); record its state-only permissions.
    permissions: [
      "android.permission.ACCESS_NETWORK_STATE",
      "android.permission.ACCESS_WIFI_STATE",
      "android.permission.CHANGE_WIFI_MULTICAST_STATE",
      "android.permission.ACCESS_LOCAL_NETWORK",
    ],
    versionCode: androidBuildNumber,
    // Android 13+ back through OnBackInvokedCallback (targetSdk 36 makes it the default anyway).
    // React Native 0.88 takes back from the activity's OnBackPressedDispatcher and each Modal
    // from its dialog's, so BackHandler, sheets and the stack keep working; without the flag Expo
    // writes an explicit opt-out into the manifest.
    predictiveBackGestureEnabled: true,
    package: "space.pibot.mobile",
    allowBackup: false,
    adaptiveIcon: { foregroundImage: "./assets/adaptive-icon.png", backgroundColor: "#9159FE" },
    ...(googleServicesFile ? { googleServicesFile } : {}),
  },
  updates: { enabled: false },
  // fcm: whether this Android build carries Firebase config; without it no push token exists.
  // apns: whether this iOS build may ask for a push token (PIBOT_IOS_PUSH, paid account).
  extra: { ...(projectId ? { eas: { projectId } } : {}), fcm: !!googleServicesFile, apns: iosPush },
};
