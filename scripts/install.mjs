#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const CURRENT_PLATFORM = process.platform;

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function detectPlatformName(platform = CURRENT_PLATFORM) {
  if (platform === "darwin") return "macos";
  if (platform === "linux") return "linux";
  fail(`unsupported platform: ${platform}`);
}

function defaultOptions() {
  const platform = detectPlatformName();
  return {
    platform,
    stateDir: path.join(os.homedir(), ".openclaw"),
    gatewayPlist: path.join(os.homedir(), "Library/LaunchAgents/ai.openclaw.gateway.plist"),
    gatewayUnit: "openclaw-gateway.service",
    systemdUserDir: path.join(os.homedir(), ".config", "systemd", "user"),
    facadeLabel: "ai.openclaw.openai-compatible-facade",
    proxyPort: "19876",
    noReload: false,
    maps: []
  };
}

function parseArgs(argv) {
  const options = defaultOptions();
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
    if (arg === "--platform") {
      options.platform = argv[++i] || "";
      continue;
    }
    if (arg === "--gateway-plist") {
      options.gatewayPlist = path.resolve(argv[++i] || "");
      continue;
    }
    if (arg === "--gateway-unit") {
      options.gatewayUnit = argv[++i] || "";
      continue;
    }
    if (arg === "--systemd-user-dir") {
      options.systemdUserDir = path.resolve(argv[++i] || "");
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

  if (options.platform !== "macos" && options.platform !== "linux") fail(`unsupported --platform value: ${options.platform}`);
  if (options.maps.length === 0) fail("at least one --map provider=https://upstream is required");
  return options;
}

function printHelp() {
  console.log(`Usage:
  node scripts/install.mjs --map custom-beehears=https://api.beehears.com [--map provider2=https://example.com]

Options:
  --map               Map an OpenClaw provider key to a third-party upstream origin
  --platform          Target platform: macos | linux (default: current OS)
  --state-dir         OpenClaw state dir (default: ~/.openclaw)
  --gateway-plist     Gateway LaunchAgent plist path (macOS)
  --gateway-unit      Gateway systemd user unit name (Linux, default: openclaw-gateway.service)
  --systemd-user-dir  systemd user unit directory (Linux, default: ~/.config/systemd/user)
  --proxy-port        Local facade proxy port (default: 19876)
  --no-reload         Write files only, do not reload services
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

function chmodIfExists(filePath, mode) {
  try {
    fs.chmodSync(filePath, mode);
  } catch {}
}

function ensureDir(dirPath, mode = 0o700) {
  fs.mkdirSync(dirPath, { recursive: true, mode });
  chmodIfExists(dirPath, mode);
}

function copyFile(src, dest, mode = 0o600) {
  fs.copyFileSync(src, dest);
  chmodIfExists(dest, mode);
}

function writeFile(dest, contents, mode = 0o600) {
  fs.writeFileSync(dest, contents, { encoding: "utf8", mode });
  chmodIfExists(dest, mode);
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function backupFile(filePath, backupDir) {
  if (!fs.existsSync(filePath)) return null;
  ensureDir(backupDir, 0o700);
  const backupPath = path.join(backupDir, `${path.basename(filePath)}.${timestamp()}.bak`);
  fs.copyFileSync(filePath, backupPath);
  chmodIfExists(backupPath, 0o600);
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

function removePlistKey(plistPath, keyPath) {
  plistBuddy(plistPath, `Delete ${keyPath}`, true);
}

function ensurePlistDict(plistPath, keyPath) {
  const printResult = plistBuddy(plistPath, `Print ${keyPath}`, true);
  if (printResult.status === 0) return;
  plistBuddy(plistPath, `Add ${keyPath} dict`);
}

function readMacGatewayEnv(plistPath) {
  const result = run("plutil", ["-convert", "json", "-o", "-", plistPath], {
    allowFailure: true,
    capture: true
  });
  if (result.status !== 0) return {};
  const parsed = JSON.parse(result.stdout || "{}");
  return parsed.EnvironmentVariables || {};
}

function quoteSystemdArg(value) {
  return `"${String(value).replace(/(["\\])/g, "\\$1")}"`;
}

function writeFacadeLaunchAgent(plistPath, runtimeDir, logDir, port, label, routeMapJson) {
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
      <string>${process.execPath}</string>
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
      <string>${process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin"}</string>
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
      <key>ROUTE_MAP_JSON</key>
      <string>${routeMapJson}</string>
      <key>CERT_PATH</key>
      <string>${path.join(runtimeDir, "api.openai.com.crt")}</string>
      <key>KEY_PATH</key>
      <string>${path.join(runtimeDir, "api.openai.com.key")}</string>
    </dict>
  </dict>
</plist>
`;
  writeFile(plistPath, contents, 0o644);
}

function writeFacadeSystemdUnit(unitPath, runtimeDir, logDir, port, routeMapJson) {
  const contents = `[Unit]
Description=OpenClaw OpenAI-Compatible Facade
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${quoteSystemdArg(process.execPath)} ${quoteSystemdArg(path.join(runtimeDir, "server.mjs"))}
Restart=always
RestartSec=1
Environment=HOME=${quoteSystemdArg(os.homedir())}
Environment=PATH=${quoteSystemdArg(process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin")}
Environment=LISTEN_HOST=127.0.0.1
Environment=LISTEN_PORT=${port}
Environment=TARGET_HOST=api.openai.com
Environment=TARGET_PORT=443
Environment=DEFAULT_UPSTREAM_ORIGIN=https://api.openai.com
Environment=ROUTE_MAP_JSON=${quoteSystemdArg(routeMapJson)}
Environment=CERT_PATH=${quoteSystemdArg(path.join(runtimeDir, "api.openai.com.crt"))}
Environment=KEY_PATH=${quoteSystemdArg(path.join(runtimeDir, "api.openai.com.key"))}
StandardOutput=append:${path.join(logDir, "openai-compatible-facade.log")}
StandardError=append:${path.join(logDir, "openai-compatible-facade.err.log")}

[Install]
WantedBy=default.target
`;
  writeFile(unitPath, contents, 0o644);
}

function writeGatewaySystemdOverride(dropInPath, caPath, proxyPort) {
  const contents = `[Service]
Environment=NODE_EXTRA_CA_CERTS=${quoteSystemdArg(caPath)}
Environment=HTTP_PROXY=http://127.0.0.1:${proxyPort}
Environment=HTTPS_PROXY=http://127.0.0.1:${proxyPort}
Environment=NO_PROXY=127.0.0.1,localhost
`;
  writeFile(dropInPath, contents, 0o644);
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

  chmodIfExists(caKey, 0o600);
  chmodIfExists(caCrt, 0o600);
  chmodIfExists(leafKey, 0o600);
  chmodIfExists(leafCsr, 0o600);
  chmodIfExists(leafCrt, 0o600);
  chmodIfExists(extPath, 0o600);

  return { caCrt };
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
      for (const model of provider.models) model.api = "openai-responses";
    }
    changed = true;
  }

  if (!changed) return false;
  writeFile(filePath, `${JSON.stringify(json, null, 2)}\n`, 0o600);
  return true;
}

function isMacServiceLoaded(label) {
  const domain = `gui/${process.getuid()}`;
  const result = run("launchctl", ["print", `${domain}/${label}`], {
    allowFailure: true,
    capture: true
  });
  return result.status === 0;
}

function reloadMacService(label, plistPath) {
  const domain = `gui/${process.getuid()}`;
  if (isMacServiceLoaded(label)) {
    run("launchctl", ["bootout", `${domain}/${label}`], { allowFailure: true });
  }
  const bootstrapResult = run("launchctl", ["bootstrap", domain, plistPath], {
    allowFailure: true,
    capture: true
  });
  if (bootstrapResult.status === 0) return;
  if (isMacServiceLoaded(label)) return;
  throw new Error(`launchctl bootstrap failed for ${label}${bootstrapResult.stderr ? `: ${bootstrapResult.stderr.trim()}` : ""}`);
}

function assertSystemctlUserAvailable() {
  const result = run("systemctl", ["--user", "--version"], {
    allowFailure: true,
    capture: true
  });
  if (result.status === 0) return;
  fail("systemctl --user is not available. On Debian/Ubuntu, make sure you have a systemd user session and can run `systemctl --user status`.");
}

function reloadLinuxServices(facadeUnitName, gatewayUnitName) {
  assertSystemctlUserAvailable();
  run("systemctl", ["--user", "daemon-reload"]);
  run("systemctl", ["--user", "enable", "--now", facadeUnitName]);
  run("systemctl", ["--user", "restart", gatewayUnitName]);
}

function buildInstallState(options, caCrt, routeMapJson, gatewaySnapshot) {
  return {
    version: 1,
    platform: options.platform,
    generatedAt: new Date().toISOString(),
    maps: options.maps,
    proxyPort: options.proxyPort,
    facadeLabel: options.facadeLabel,
    gatewayPlist: options.gatewayPlist,
    gatewayUnit: options.gatewayUnit,
    systemdUserDir: options.systemdUserDir,
    caPath: caCrt,
    routeMapJson,
    gatewaySnapshot
  };
}

function readGatewaySnapshot(options, gatewayOverridePath) {
  if (options.platform === "macos") {
    const env = readMacGatewayEnv(options.gatewayPlist);
    return {
      environment: {
        NODE_EXTRA_CA_CERTS: env.NODE_EXTRA_CA_CERTS ?? null,
        HTTP_PROXY: env.HTTP_PROXY ?? null,
        HTTPS_PROXY: env.HTTPS_PROXY ?? null,
        NO_PROXY: env.NO_PROXY ?? null
      }
    };
  }
  return {
    gatewayOverrideContent: fs.existsSync(gatewayOverridePath) ? fs.readFileSync(gatewayOverridePath, "utf8") : null
  };
}

function main() {
  const options = parseArgs(args);
  const runtimeDir = path.join(options.stateDir, "local-proxies", "openai-compatible-facade");
  const logDir = path.join(options.stateDir, "logs");
  const backupDir = path.join(runtimeDir, "backups");
  const installStatePath = path.join(runtimeDir, "install-state.json");
  const configPath = path.join(options.stateDir, "openclaw.json");
  const modelsPath = path.join(options.stateDir, "agents", "main", "agent", "models.json");
  const facadePlist = path.join(os.homedir(), "Library/LaunchAgents", `${options.facadeLabel}.plist`);
  const facadeUnitName = `${options.facadeLabel}.service`;
  const facadeUnitPath = path.join(options.systemdUserDir, facadeUnitName);
  const gatewayOverrideDir = path.join(options.systemdUserDir, `${options.gatewayUnit}.d`);
  const gatewayOverridePath = path.join(gatewayOverrideDir, "openai-compatible-facade.conf");

  ensureDir(runtimeDir, 0o700);
  ensureDir(logDir, 0o700);
  ensureDir(backupDir, 0o700);

  copyFile(path.join(repoRoot, "assets", "server.mjs"), path.join(runtimeDir, "server.mjs"), 0o600);
  copyFile(path.join(repoRoot, "assets", "api.openai.com.ext"), path.join(runtimeDir, "api.openai.com.ext"), 0o600);

  const { caCrt } = generateCerts(runtimeDir);
  const routeMap = Object.fromEntries(options.maps.map((map) => [map.providerKey, map.upstream]));
  const routeMapJson = JSON.stringify(routeMap).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  if (options.platform === "macos") {
    writeFacadeLaunchAgent(facadePlist, runtimeDir, logDir, options.proxyPort, options.facadeLabel, routeMapJson);
  } else {
    ensureDir(options.systemdUserDir, 0o700);
    writeFacadeSystemdUnit(facadeUnitPath, runtimeDir, logDir, options.proxyPort, routeMapJson);
  }

  const configBackup = backupFile(configPath, backupDir);
  const gatewayBackup = options.platform === "macos"
    ? backupFile(options.gatewayPlist, backupDir)
    : backupFile(gatewayOverridePath, backupDir);
  const modelsBackup = backupFile(modelsPath, backupDir);
  const gatewaySnapshot = readGatewaySnapshot(options, gatewayOverridePath);

  const configChanged = updateProviderConfigFile(configPath, options.maps);
  if (!configChanged) fail(`no matching provider keys found in ${configPath}`);
  updateProviderConfigFile(modelsPath, options.maps);

  if (options.platform === "macos") {
    if (!fs.existsSync(options.gatewayPlist)) fail(`gateway plist not found: ${options.gatewayPlist}`);
    ensurePlistDict(options.gatewayPlist, ":EnvironmentVariables");
    setPlistString(options.gatewayPlist, ":EnvironmentVariables:NODE_EXTRA_CA_CERTS", caCrt);
    setPlistString(options.gatewayPlist, ":EnvironmentVariables:HTTP_PROXY", `http://127.0.0.1:${options.proxyPort}`);
    setPlistString(options.gatewayPlist, ":EnvironmentVariables:HTTPS_PROXY", `http://127.0.0.1:${options.proxyPort}`);
    setPlistString(options.gatewayPlist, ":EnvironmentVariables:NO_PROXY", "127.0.0.1,localhost");
    chmodIfExists(options.gatewayPlist, 0o600);
    if (!options.noReload) {
      reloadMacService(options.facadeLabel, facadePlist);
      reloadMacService("ai.openclaw.gateway", options.gatewayPlist);
    }
  } else {
    ensureDir(gatewayOverrideDir, 0o700);
    writeGatewaySystemdOverride(gatewayOverridePath, caCrt, options.proxyPort);
    if (!options.noReload) reloadLinuxServices(facadeUnitName, options.gatewayUnit);
  }

  const installState = buildInstallState(options, caCrt, JSON.stringify(routeMap), gatewaySnapshot);
  writeFile(installStatePath, `${JSON.stringify(installState, null, 2)}\n`, 0o600);

  console.log("");
  console.log("Install completed.");
  if (configBackup) console.log(`Config backup : ${configBackup}`);
  if (gatewayBackup) console.log(`Gateway backup: ${gatewayBackup}`);
  if (modelsBackup) console.log(`Models backup : ${modelsBackup}`);
  console.log(`Facade CA     : ${caCrt}`);
  if (options.platform === "macos") console.log(`Facade plist  : ${facadePlist}`);
  else {
    console.log(`Facade unit   : ${facadeUnitPath}`);
    console.log(`Gateway drop-in: ${gatewayOverridePath}`);
  }
  console.log("");
  console.log("Applied maps:");
  for (const map of options.maps) console.log(`- ${map.providerKey} -> ${map.upstream}`);
  console.log("");
  console.log("Next checks:");
  console.log("- openclaw status");
  console.log("- openclaw agent --agent main --message \"reply with exactly ok\" --json --timeout 60");
}

main();
