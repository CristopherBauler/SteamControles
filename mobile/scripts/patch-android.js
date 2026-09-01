const fs = require("fs");
const path = require("path");

const androidApp = path.join(__dirname, "..", "android", "app");
const manifestPath = path.join(androidApp, "src", "main", "AndroidManifest.xml");
const stringsPath = path.join(androidApp, "src", "main", "res", "values", "strings.xml");
const networkPath = path.join(androidApp, "src", "main", "res", "xml", "network_security_config.xml");

if (!fs.existsSync(manifestPath)) {
  console.error("AndroidManifest.xml não encontrado. Rode npx cap add android primeiro.");
  process.exit(1);
}

let manifest = fs.readFileSync(manifestPath, "utf8");

if (!manifest.includes("android.permission.INTERNET")) {
  manifest = manifest.replace(
    "<manifest",
    `<manifest`
  );
  manifest = manifest.replace(
    /<application/,
    `    <uses-permission android:name="android.permission.INTERNET" />\n    <application`
  );
}

if (!manifest.includes("usesCleartextTraffic")) {
  manifest = manifest.replace(
    /<application([\s\S]*?)>/,
    (full, attrs) => {
      if (attrs.includes("usesCleartextTraffic")) return full;
      return `<application${attrs} android:usesCleartextTraffic="true" android:networkSecurityConfig="@xml/network_security_config">`;
    }
  );
} else if (!manifest.includes("networkSecurityConfig")) {
  manifest = manifest.replace(
    "android:usesCleartextTraffic=\"true\"",
    "android:usesCleartextTraffic=\"true\" android:networkSecurityConfig=\"@xml/network_security_config\""
  );
}

const queriesBlock = `    <queries>
        <intent>
            <action android:name="android.intent.action.VIEW" />
            <data android:scheme="https" android:host="store.steampowered.com" />
        </intent>
        <intent>
            <action android:name="android.intent.action.VIEW" />
            <data android:scheme="https" android:host="steamcommunity.com" />
        </intent>
        <intent>
            <action android:name="android.intent.action.VIEW" />
            <data android:scheme="https" android:host="gg.deals" />
        </intent>
        <intent>
            <action android:name="android.intent.action.VIEW" />
            <data android:scheme="https" android:host="www.gg.deals" />
        </intent>
        <intent>
            <action android:name="android.intent.action.VIEW" />
            <data android:scheme="steam" />
        </intent>
    </queries>
`;

if (!manifest.includes("pathPrefix=\"/steam-callback\"")) {
  manifest = manifest.replace(
    /(<intent-filter>\s*<action android:name="android.intent.action.MAIN" \/>\s*<category android:name="android.intent.category.LAUNCHER" \/>\s*<\/intent-filter>)/,
    `$1

            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="http" android:host="localhost" android:pathPrefix="/steam-callback" />
            </intent-filter>`
  );
}

if (!manifest.includes("store.steampowered.com")) {
  if (manifest.includes("</manifest>")) {
    manifest = manifest.replace("</manifest>", `${queriesBlock}</manifest>`);
  }
}

fs.writeFileSync(manifestPath, manifest);

const xmlDir = path.dirname(networkPath);
fs.mkdirSync(xmlDir, { recursive: true });
fs.writeFileSync(
  networkPath,
  `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <base-config cleartextTrafficPermitted="true">
        <trust-anchors>
            <certificates src="system" />
        </trust-anchors>
    </base-config>
</network-security-config>
`
);

if (fs.existsSync(stringsPath)) {
  let strings = fs.readFileSync(stringsPath, "utf8");
  strings = strings.replace(
    /<string name="app_name">[^<]*<\/string>/,
    `<string name="app_name">Minha Loja dos Desejos</string>`
  );
  strings = strings.replace(
    /<string name="title_activity_main">[^<]*<\/string>/,
    `<string name="title_activity_main">Minha Loja dos Desejos</string>`
  );
  fs.writeFileSync(stringsPath, strings);
}

const gradlePath = path.join(androidApp, "build.gradle");
if (fs.existsSync(gradlePath)) {
  let gradle = fs.readFileSync(gradlePath, "utf8");
  gradle = gradle.replace(/applicationId\s+"[^"]+"/, 'applicationId "dev.steamcontroles.app"');
  gradle = gradle.replace(/namespace\s+"[^"]+"/, 'namespace "dev.steamcontroles.app"');
  fs.writeFileSync(gradlePath, gradle);
}

console.log("AndroidManifest, rede e applicationId ajustados.");
