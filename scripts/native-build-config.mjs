export function nativeBuildConfig(platform, env = process.env, defaultChannel = "stable") {
  if (!["android", "desktop"].includes(platform)) throw new Error("Unsupported native platform");
  const channel = env.DSP_RELEASE_CHANNEL?.trim().toLowerCase() || defaultChannel;
  if (!["stable", "beta", "nightly"].includes(channel)) throw new Error("Invalid release channel");
  const officialAndroid = platform === "android" && env.DSP_ANDROID_BUILD_PROFILE === "official";
  function https(name, originOnly = false) {
    const value = env[name]?.trim();
    if (!value) {
      if (officialAndroid) throw new Error(`Official Android build requires ${name}`);
      return "";
    }
    let url;
    try { url = new URL(value); } catch { throw new Error(`${name} must be a valid HTTPS URL`); }
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
      || (originOnly && url.pathname !== "/")) throw new Error(`${name} must be a clean HTTPS ${originOnly ? "origin" : "URL"}`);
    return url.toString().replace(/\/$/, "");
  }
  const api = https(platform === "android" ? "DSP_ANDROID_API_BASE_URL" : "DSP_DESKTOP_API_BASE_URL");
  const update = platform === "android" ? https("DSP_ANDROID_UPDATE_BASE_URL") : "";
  const origin = platform === "android" ? https("DSP_ANDROID_PUBLIC_ORIGIN", true) : "";
  return {
    VITE_APP_PLATFORM: platform,
    VITE_API_BASE_URL: api,
    VITE_ANDROID_UPDATE_MANIFEST_URL: update ? `${update}/${channel}.json` : "",
    VITE_PUBLIC_APP_ORIGIN: origin,
    VITE_RELEASE_CHANNEL: channel,
  };
}
