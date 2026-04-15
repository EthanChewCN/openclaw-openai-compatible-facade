#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const args = process.argv.slice(2);

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = {
    stateDir: path.join(os.homedir(), ".openclaw"),
    gatewayPlist: path.join(os.homedir(), "Library/LaunchAgents/ai.openclaw.gateway.plist"),
    facadeLabel: "ai.openclaw.openai-compatible-facade",
    proxyPort: "19876",
    noReload: false,
    maps: []
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--map") {
      const value = argv[++i];
      if (!value || !value.includes("=")) fail("--map requires provider=https://upstream.example.com");
      const [providerKey, upstream] = value.split("=", 2);
      options.maps.push({
        providerKey: providerKey.trim(),
        upstream: upstream.trim().replace(/\/+$/, "")
      });
      continue;
    }
    if (arg === "--state-dir") {
      options.stateDir = path.resolve(argv[++i] || "");
      continue;
    }
    if (arg === "--gateway-plist") {
      options.gatewayPlist = path.resolve(argv[++i] || "");
      continue;
    }
    if (arg === "--proxy-port") {
      options.proxyPort = String(argv[++i] || "");
      continue;
    }
    if (arg === "--no-reload") {
      options.noReload = true;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    }
    fail(`unknown argument: ${arg}`);
  }

  if (options.maps.length === 0) fail("at least one --map provider=https://upstream is required");
  return options;
}

function printHelp() {
  console.log(`Usage:
  node scripts/install.mjs --map custom-beehears=https://api.beehears.com [--map provider2=https://example.com]

Options:
  --map            Map an OpenClaw provider key to a third-party upstream origin
  --state-dir      OpenClaw state dir (default: ~/.openclaw)
  --gateway-plist  Gateway LaunchAgent plist path
  --proxy-port     Local facade proxy port (default: 19876)
  --no-reload      Write files only, do not reload launchd services
`);
}

function run(cmd, cmdArgs, options = {}) {
  const result = spawnSync(cmd, cmdArgs, {
    stdio: options.capture ? "pipe" : "inherit",
    encoding: "utf8"
  });
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${cmd} ${cmdArgs.join(" ")} failed${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
  }
  return result;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function copyFile(src, dest) {
  fs.copyFileSync(src, dest);
}

function writeFile(dest, contents) {
  fs.writeFileSync(dest, contents, "utf8");
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function backupFile(filePath, backupDir) {
  ensureDir(backupDir);
  const backupPath = path.join(backupDir, `${path.basename(filePath)}.${timestamp()}.bak`);
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

function plistBuddy(plistPath, command, allowFailure = false) {
  return run("/usr/libexec/PlistBuddy", ["-c", command, plistPath], {
    capture: allowFailure,
    allowFailure
  });
}

function setPlistString(plistPath, keyPath, value) {
  const setResult = plistBuddy(plistPath, `Set ${keyPath} ${value}`, true);
  if (setResult.status === 0) return;
  plistBuddy(plistPath, `Add ${keyPath} string ${value}`);
}

function ensurePlistDict(plistPath, keyPath) {
  const printResult = plistBuddy(plistPath, `Print ${keyPath}`, true);
  if (printResult.status === 0) return;
  plistBuddy(plistPath, `Add ${keyPath} dict`);
}

function removePlistKey(plistPath, keyPath) {
  plistBuddy(plistPath, `Delete ${keyPath}`, true);
}

function writeFacadeLaunchAgent(plistPath, runtimeDir, logDir, port, label) {
  const contents = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${label}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>1</integer>
    <key>ProgramArguments</key>
    <array>
      <string>/opt/homebrew/opt/node/bin/node</string>
      <string>${path.join(runtimeDir, "server.mjs")}</string>
    </array>
    <key>StandardOutPath</key>
    <string>${path.join(logDir, "openai-compatible-facade.log")}</string>
    <key>StandardErrorPath</key>
    <string>${path.join(logDir, "openai-compatible-facade.err.log")}</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>HOME</key>
      <string>${os.homedir()}</string>
      <key>PATH</key>
      <string>/opt/homebrew/opt/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
      <key>LISTEN_HOST</key>
      <string>127.0.0.1</string>
      <key>LISTEN_PORT</key>
      <string>${port}</string>
      <key>TARGET_HOST</key>
      <string>api.openai.com</string>
      <key>TARGET_PORT</key>
      <string>443</string>
      <key>DEFAULT_UPSTREAM_ORIGIN</key>
      <string>https://api.openai.com</string>
      <key>CERT_PATH</key>
      <string>${path.join(runtimeDir, "api.openai.com.crt")}</string>
      <key>KEY_PATH</key>
      <string>${path.join(runtimeDir, "api.openai.com.key")}</string>
    </dict>
  </dict>
</plist>
`;
  writeFile(plistPath, contents);
}

function generateCerts(runtimeDir) {
  const caKey = path.join(runtimeDir, "openai-compatible-facade-ca.key");
  const caCrt = path.join(runtimeDir, "openai-compatible-facade-ca.crt");
  const leafKey = path.join(runtimeDir, "api.openai.com.key");
  const leafCsr = path.join(runtimeDir, "api.openai.com.csr");
  const leafCrt = path.join(runtimeDir, "api.openai.com.crt");
  const extPath = path.join(runtimeDir, "api.openai.com.ext");

  if (!fs.existsSync(caKey) || !fs.existsSync(caCrt)) {
    run("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", caKey,
      "-out", caCrt,
      "-days", "3650",
      "-subj", "/CN=OpenClaw OpenAI Compatible Facade CA"
    ]);
  }

  if (!fs.existsSync(leafKey) || !fs.existsSync(leafCrt)) {
    run("openssl", [
      "req", "-new", "-newkey", "rsa:2048", "-nodes",
      "-keyout", leafKey,
      "-out", leafCsr,
      "-subj", "/CN=api.openai.com"
    ]);
    run("openssl", [
      "x509", "-req",
      "-in", leafCsr,
      "-CA", caCrt,
      "-CAkey", caKey,
      "-CAcreateserial",
      "-out", leafCrt,
      "-days", "825",
      "-sha256",
      "-extfile", extPath
    ]);
  }

  return { caCrt };
}

function updateGatewayPlist(gatewayPlist, caPath, proxyPort) {
  if (!fs.existsSync(gatewayPlist)) fail(`gateway plist not found: ${gatewayPlist}`);
  ensurePlistDict(gatewayPlist, ":EnvironmentVariables");
  setPlistString(gatewayPlist, ":EnvironmentVariables:NODE_EXTRA_CA_CERTS", caPath);
  setPlistString(gatewayPlist, ":EnvironmentVariables:HTTP_PROXY", `http://127.0.0.1:${proxyPort}`);
  setPlistString(gatewayPlist, ":EnvironmentVariables:HTTPS_PROXY", `http://127.0.0.1:${proxyPort}`);
  setPlistString(gatewayPlist, ":EnvironmentVariables:NO_PROXY", "127.0.0.1,localhost");
}

function updateProviderConfigFile(filePath, maps) {
  if (!fs.existsSync(filePath)) return false;
  const raw = fs.readFileSync(filePath, "utf8");
  const json = JSON.parse(raw);
  let changed = false;

  for (const map of maps) {
    const provider = json?.models?.providers?.[map.providerKey] ?? json?.providers?.[map.providerKey];
    if (!provider) continue;
    provider.baseUrl = "https://api.openai.com/v1";
    provider.api = "openai-responses";
    provider.request = {
      ...provider.request ?? {},
      proxy: { mode: "env-proxy" },
      allowPrivateNetwork: true
    };
    provider.headers = {
      ...provider.headers ?? {},
      "X-OpenClaw-Facade-Upstream": map.upstream,
      "X-OpenClaw-Facade-Provider": map.providerKey
    };
    if (Array.isArray(provider.models)) {
      for (const model of provider.models) {
        model.api = "openai-responses";
      }
    }
    changed = true;
  }

  if (!changed) return false;
  fs.writeFileSync(filePath, `${JSON.stringify(json, null, 2)}\n`, "utf8");
  return true;
}

function isServiceLoaded(label) {
  const domain = `gui/${process.getuid()}`;
  const result = run("launchctl", ["print", `${domain}/${label}`], {
    allowFailure: true,
    capture: true
  });
  return result.status === 0;
}

function reloadService(label, plistPath) {
  const domain = `gui/${process.getuid()}`;
  if (isServiceLoaded(label)) {
    run("launchctl", ["bootout", `${domain}/${label}`], { allowFailure: true });
  }
  const bootstrapResult = run("launchctl", ["bootstrap", domain, plistPath], {
    allowFailure: true,
    capture: true
  });
  if (bootstrapResult.status === 0) return;
  if (isServiceLoaded(label)) return;
  throw new Error(`launchctl bootstrap failed for ${label}${bootstrapResult.stderr ? `: ${bootstrapResult.stderr.trim()}` : ""}`);
}

function main() {
  const options = parseArgs(args);
  const runtimeDir = path.join(options.stateDir, "local-proxies", "openai-compatible-facade");
  const logDir = path.join(options.stateDir, "logs");
  const backupDir = path.join(runtimeDir, "backups");
  const facadePlist = path.join(os.homedir(), "Library/LaunchAgents", `${options.facadeLabel}.plist`);
  const configPath = path.join(options.stateDir, "openclaw.json");
  const modelsPath = path.join(options.stateDir, "agents", "main", "agent", "models.json");

  ensureDir(runtimeDir);
  ensureDir(logDir);
  ensureDir(backupDir);

  copyFile(path.join(repoRoot, "assets", "server.mjs"), path.join(runtimeDir, "server.mjs"));
  copyFile(path.join(repoRoot, "assets", "api.openai.com.ext"), path.join(runtimeDir, "api.openai.com.ext"));

  const { caCrt } = generateCerts(runtimeDir);
  writeFacadeLaunchAgent(facadePlist, runtimeDir, logDir, options.proxyPort, options.facadeLabel);

  const configBackup = backupFile(configPath, backupDir);
  const gatewayBackup = backupFile(options.gatewayPlist, backupDir);
  const modelsBackup = fs.existsSync(modelsPath) ? backupFile(modelsPath, backupDir) : null;

  const configChanged = updateProviderConfigFile(configPath, options.maps);
  if (!configChanged) fail(`no matching provider keys found in ${configPath}`);
  updateProviderConfigFile(modelsPath, options.maps);
  updateGatewayPlist(options.gatewayPlist, caCrt, options.proxyPort);

  if (!options.noReload) {
    reloadService(options.facadeLabel, facadePlist);
    reloadService("ai.openclaw.gateway", options.gatewayPlist);
  }

  console.log("");
  console.log("Install completed.");
  console.log(`Config backup : ${configBackup}`);
  console.log(`Gateway backup: ${gatewayBackup}`);
  if (modelsBackup) console.log(`Models backup : ${modelsBackup}`);
  console.log(`Facade plist  : ${facadePlist}`);
  console.log(`Facade CA     : ${caCrt}`);
  console.log("");
  console.log("Applied maps:");
  for (const map of options.maps) {
    console.log(`- ${map.providerKey} -> ${map.upstream}`);
  }
  console.log("");
  console.log("Next checks:");
  console.log("- openclaw status");
  console.log("- openclaw agent --agent main --message \"reply with exactly ok\" --json --timeout 60");
}

main();
