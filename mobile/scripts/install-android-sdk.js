const fs = require("fs");
const path = require("path");
const https = require("https");
const { spawnSync } = require("child_process");

const SDK_ROOT = path.resolve(__dirname, "..", ".android-sdk");
const ZIP_NAME = "commandlinetools-win.zip";
const ZIP_URL =
  "https://dl.google.com/android/repository/commandlinetools-win-13114758_latest.zip";
const JDK21 = "C:\\Program Files\\Java\\jdk-21";

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const get = (target) => {
      https
        .get(target, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            get(res.headers.location);
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`Download HTTP ${res.statusCode}`));
            return;
          }
          res.pipe(file);
          file.on("finish", () => file.close(resolve));
        })
        .on("error", reject);
    };
    get(url);
  });
}

function unzip(zipPath, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const result = spawnSync(
    "powershell",
    ["-NoProfile", "-Command", `Expand-Archive -Force -Path '${zipPath}' -DestinationPath '${dest}'`],
    { stdio: "inherit" }
  );
  if (result.status !== 0) throw new Error("Falha ao extrair o commandlinetools.");
}

async function main() {
  fs.mkdirSync(SDK_ROOT, { recursive: true });
  const zipPath = path.join(SDK_ROOT, ZIP_NAME);
  const latestDir = path.join(SDK_ROOT, "cmdline-tools", "latest");
  const sdkmanager = path.join(latestDir, "bin", "sdkmanager.bat");

  if (!fs.existsSync(sdkmanager)) {
    console.log("Baixando Android commandline tools…");
    await download(ZIP_URL, zipPath);
    const extractTo = path.join(SDK_ROOT, "_tmp_cmdline");
    unzip(zipPath, extractTo);
    fs.mkdirSync(path.join(SDK_ROOT, "cmdline-tools"), { recursive: true });
    const unpacked = fs.existsSync(path.join(extractTo, "cmdline-tools"))
      ? path.join(extractTo, "cmdline-tools")
      : extractTo;
    if (fs.existsSync(latestDir)) fs.rmSync(latestDir, { recursive: true, force: true });
    fs.renameSync(unpacked, latestDir);
    fs.rmSync(extractTo, { recursive: true, force: true });
  }

  const env = {
    ...process.env,
    JAVA_HOME: fs.existsSync(JDK21) ? JDK21 : process.env.JAVA_HOME,
    ANDROID_SDK_ROOT: SDK_ROOT,
    ANDROID_HOME: SDK_ROOT,
  };
  env.PATH = `${path.join(env.JAVA_HOME || "", "bin")};${path.join(latestDir, "bin")};${env.PATH}`;

  function runSdk(args, input) {
    return spawnSync("sdkmanager.bat", args, {
      env,
      cwd: path.join(latestDir, "bin"),
      shell: true,
      stdio: input ? ["pipe", "inherit", "inherit"] : "inherit",
      input,
    });
  }

  console.log("Instalando plataformas Android 35…");
  const licenses = runSdk(["--licenses"], "y\ny\ny\ny\ny\ny\ny\ny\ny\n");
  if (licenses.status !== 0) {
    console.warn("Aceite de licenças retornou", licenses.status, licenses.error);
  }
  const install = runSdk(["platform-tools", "platforms;android-35", "build-tools;35.0.0"], "y\n");
  if (install.status !== 0) {
    console.error(install.error);
    process.exit(install.status || 1);
  }
  console.log("SDK em", SDK_ROOT);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
