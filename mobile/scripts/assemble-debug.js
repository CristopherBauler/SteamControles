const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const mobileRoot = path.resolve(__dirname, "..");
const androidDir = path.join(mobileRoot, "android");
const wrapper = path.join(androidDir, "gradlew.bat");
const jdk21 = "C:\\Program Files\\Java\\jdk-21";
const sdkCandidates = [
  process.env.ANDROID_HOME,
  process.env.ANDROID_SDK_ROOT,
  path.join(mobileRoot, ".android-sdk"),
  path.join(process.env.LOCALAPPDATA || "", "Android", "Sdk"),
  path.join(process.env.USERPROFILE || "", "AppData", "Local", "Android", "Sdk"),
].filter(Boolean);

function findSdk() {
  for (const candidate of sdkCandidates) {
    if (candidate && fs.existsSync(path.join(candidate, "platform-tools"))) return candidate;
    if (candidate && fs.existsSync(path.join(candidate, "cmdline-tools"))) return candidate;
  }
  return "";
}

if (!fs.existsSync(wrapper)) {
  console.error("android/gradlew.bat não existe. Rode: npx cap add android");
  process.exit(1);
}

const sdk = findSdk();
if (!sdk) {
  console.error("Android SDK não encontrado. Instale o Android Studio ou o command-line tools.");
  console.error("Depois:");
  console.error("  set ANDROID_HOME=C:\\Android\\Sdk");
  console.error("  cd mobile");
  console.error("  npx cap sync android");
  console.error("  node scripts/patch-android.js");
  console.error("  node scripts/copy-icon.js");
  console.error("  cd android && gradlew.bat assembleDebug");
  process.exit(2);
}

const env = {
  ...process.env,
  JAVA_HOME: fs.existsSync(jdk21) ? jdk21 : process.env.JAVA_HOME,
  ANDROID_HOME: sdk,
  ANDROID_SDK_ROOT: sdk,
};
env.PATH = `${path.join(env.JAVA_HOME || "", "bin")};${path.join(sdk, "platform-tools")};${env.PATH}`;

const localProps = path.join(androidDir, "local.properties");
fs.writeFileSync(localProps, `sdk.dir=${sdk.replace(/\\/g, "/")}\n`);

console.log("SDK:", sdk);
console.log("JAVA_HOME:", env.JAVA_HOME);

const result = spawnSync("gradlew.bat", ["assembleDebug", "--no-daemon"], {
  cwd: androidDir,
  env,
  stdio: "inherit",
  shell: true,
});
if (result.status === 0) {
  const apk = path.join(androidDir, "app", "build", "outputs", "apk", "debug", "app-debug.apk");
  const copy = path.join(mobileRoot, "MinhaLojaDosDesejos-debug.apk");
  if (fs.existsSync(apk)) {
    fs.copyFileSync(apk, copy);
    console.log("APK:", apk);
    console.log("Cópia:", copy);
  }
}
process.exit(result.status == null ? 1 : result.status);
