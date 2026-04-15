#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

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
  return {
    platform: detectPlatformName(),
    stateDir: path.join(os.homedir(), ".openclaw"),
    gatewayPlist: path.join(os.homedir(), "Library/LaunchAgents/ai.openclaw.gateway.plist"),
    gatewayUnit: "openclaw-gateway.service",
    systemdUserDir: path.join(os.homedir(), ".config", "systemd", "user"),
    facadeLabel: "ai.openclaw.openai-compatible-facade",
    maps: [],
    noReload: false
  };
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

function parseArgs(argv) {
  const options = defaultOptions();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--map") {
      const value = argv[++i];
      if (!value || !value.includes("=")) fail("--map requires provider=https://original-upstream.example.com");
      const [providerKey, upstream] = value.split("=", 2);
      options.maps.push({
        providerKey: providerKey.trim(),
        upstream: upstream.trim().replace(/\/+$/, "")
      });
      continue;
    }
    if (arg === "--platform") {
      options.platform = argv[++i] || "";
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
    if (arg === "--gateway-unit") {
      options.gatewayUnit = argv[++i] || "";
      continue;
    }
    if (arg === "--systemd-user-dir") {
      options.systemdUserDir = path.resolve(argv[++i] || "");
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
  if (options.maps.length === 0) fail("at least one --map is required");
  return options;
}

function printHelp() {
  console.log(`Usage:
  node scripts/uninstall.mjs --map custom-beehears=https://api.beehears.com

Options:
  --map               Map an OpenClaw provider key back to its original upstream origin
  --platform          Target platform: macos | linux (default: current OS)
  --state-dir         OpenClaw state dir (default: ~/.openclaw)
  --gateway-plist     Gateway LaunchAgent plist path (macOS)
  --gateway-unit      Gateway systemd user unit name (Linux, default: openclaw-gateway.service)
  --systemd-user-dir  systemd user unit directory (Linux, default: ~/.config/systemd/user)
  --no-reload         Write files only, do not reload services
`);
}

function plistBuddy(plistPath, command) {
  return run("/usr/libexec/PlistBuddy", ["-c", command, plistPath], {
    allowFailure: true,
    capture: true
  });
}

function setPlistString(plistPath, keyPath, value) {
  const setResult = plistBuddy(plistPath, `Set ${keyPath} ${value}`);
  if (setResult.status === 0) return;
  run("/usr/libexec/PlistBuddy", ["-c", `Add ${keyPath} string ${value}`, plistPath]);
}

function removePlistKey(plistPath, keyPath) {
  plistBuddy(plistPath, `Delete ${keyPath}`);
}

function updateProviderConfigFile(filePath, maps) {
  if (!fs.existsSync(filePath)) return false;
  const raw = fs.readFileSync(filePath, "utf8");
  const json = JSON.parse(raw);
  let changed = false;
  for (const map of maps) {
    const provider = json?.models?.providers?.[map.providerKey] ?? json?.providers?.[map.providerKey];
    if (!provider) continue;
    provider.baseUrl = map.upstream;
    if (provider.request?.proxy?.mode === "env-proxy") delete provider.request.proxy;
    delete provider.request?.allowPrivateNetwork;
    if (provider.request && Object.keys(provider.request).length === 0) delete provider.request;
    delete provider.headers?.["X-OpenClaw-Facade-Upstream"];
    delete provider.headers?.["X-OpenClaw-Facade-Provider"];
    if (provider.headers && Object.keys(provider.headers).length === 0) delete provider.headers;
    changed = true;
  }
  if (!changed) return false;
  fs.writeFileSync(filePath, `${JSON.stringify(json, null, 2)}\n`, { mode: 0o600 });
  return true;
}

function readInstallState(installStatePath) {
  if (!fs.existsSync(installStatePath)) fail(`install state not found: ${installStatePath}`);
  return JSON.parse(fs.readFileSync(installStatePath, "utf8"));
}

function restoreMacGatewayEnv(plistPath, snapshot) {
  const env = snapshot?.environment;
  if (!env) fail("missing macOS gateway environment snapshot in install-state.json");
  const entries = ["NODE_EXTRA_CA_CERTS", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"];
  for (const key of entries) {
    const value = env[key];
    const keyPath = `:EnvironmentVariables:${key}`;
    if (value === null || value === undefined || value === "") removePlistKey(plistPath, keyPath);
    else setPlistString(plistPath, keyPath, value);
  }
  try {
    fs.chmodSync(plistPath, 0o600);
  } catch {}
}

function restoreLinuxGatewayOverride(gatewayOverridePath, snapshot) {
  if (!snapshot || !Object.prototype.hasOwnProperty.call(snapshot, "gatewayOverrideContent")) {
    fail("missing Linux gateway override snapshot in install-state.json");
  }
  const previous = snapshot.gatewayOverrideContent;
  if (previous === null) {
    if (fs.existsSync(gatewayOverridePath)) fs.unlinkSync(gatewayOverridePath);
    const dir = path.dirname(gatewayOverridePath);
    if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    return;
  }
  const dir = path.dirname(gatewayOverridePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(gatewayOverridePath, previous, { mode: 0o644 });
}

function reloadMacService(label, plistPath) {
  const domain = `gui/${process.getuid()}`;
  run("launchctl", ["bootout", `${domain}/${label}`], { allowFailure: true });
  if (fs.existsSync(plistPath)) run("launchctl", ["bootstrap", domain, plistPath], { allowFailure: true });
}

function assertSystemctlUserAvailable() {
  const result = run("systemctl", ["--user", "--version"], {
    allowFailure: true,
    capture: true
  });
  if (result.status === 0) return;
  fail("systemctl --user is not available. On Debian/Ubuntu, make sure you have a systemd user session and can run `systemctl --user status`.");
}

function reloadLinuxGateway(gatewayUnit) {
  assertSystemctlUserAvailable();
  run("systemctl", ["--user", "daemon-reload"]);
  run("systemctl", ["--user", "restart", gatewayUnit], { allowFailure: true });
}

function main() {
  const options = parseArgs(args);
  const configPath = path.join(options.stateDir, "openclaw.json");
  const modelsPath = path.join(options.stateDir, "agents", "main", "agent", "models.json");
  const runtimeDir = path.join(options.stateDir, "local-proxies", "openai-compatible-facade");
  const installStatePath = path.join(runtimeDir, "install-state.json");
  const facadePlist = path.join(os.homedir(), "Library/LaunchAgents", `${options.facadeLabel}.plist`);
  const facadeUnitName = `${options.facadeLabel}.service`;
  const facadeUnitPath = path.join(options.systemdUserDir, facadeUnitName);
  const gatewayOverridePath = path.join(options.systemdUserDir, `${options.gatewayUnit}.d`, "openai-compatible-facade.conf");
  const installState = readInstallState(installStatePath);

  updateProviderConfigFile(configPath, options.maps);
  updateProviderConfigFile(modelsPath, options.maps);

  if (options.platform === "macos") {
    restoreMacGatewayEnv(options.gatewayPlist, installState.gatewaySnapshot);
    if (!options.noReload) {
      const domain = `gui/${process.getuid()}`;
      run("launchctl", ["bootout", `${domain}/${options.facadeLabel}`], { allowFailure: true });
      reloadMacService("ai.openclaw.gateway", options.gatewayPlist);
    }
    if (fs.existsSync(facadePlist)) fs.unlinkSync(facadePlist);
  } else {
    if (fs.existsSync(facadeUnitPath)) fs.unlinkSync(facadeUnitPath);
    restoreLinuxGatewayOverride(gatewayOverridePath, installState.gatewaySnapshot);
    if (!options.noReload) {
      assertSystemctlUserAvailable();
      run("systemctl", ["--user", "disable", "--now", facadeUnitName], { allowFailure: true });
      reloadLinuxGateway(options.gatewayUnit);
    }
  }

  console.log("Uninstall completed.");
}

main();
