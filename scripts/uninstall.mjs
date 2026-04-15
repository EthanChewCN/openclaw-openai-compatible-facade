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

function removePlistKey(plistPath, keyPath) {
  plistBuddy(plistPath, `Delete ${keyPath}`);
}

function setPlistString(plistPath, keyPath, value) {
  const setResult = plistBuddy(plistPath, `Set ${keyPath} ${value}`);
  if (setResult.status === 0) return;
  run("/usr/libexec/PlistBuddy", ["-c", `Add ${keyPath} string ${value}`, plistPath]);
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
  fs.writeFileSync(filePath, `${JSON.stringify(json, null, 2)}\n`, "utf8");
  return true;
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
  const facadePlist = path.join(os.homedir(), "Library/LaunchAgents", `${options.facadeLabel}.plist`);
  const facadeUnitName = `${options.facadeLabel}.service`;
  const facadeUnitPath = path.join(options.systemdUserDir, facadeUnitName);
  const gatewayOverridePath = path.join(options.systemdUserDir, `${options.gatewayUnit}.d`, "openai-compatible-facade.conf");

  updateProviderConfigFile(configPath, options.maps);
  updateProviderConfigFile(modelsPath, options.maps);

  if (options.platform === "macos") {
    removePlistKey(options.gatewayPlist, ":EnvironmentVariables:HTTP_PROXY");
    removePlistKey(options.gatewayPlist, ":EnvironmentVariables:HTTPS_PROXY");
    removePlistKey(options.gatewayPlist, ":EnvironmentVariables:NO_PROXY");
    setPlistString(options.gatewayPlist, ":EnvironmentVariables:NODE_EXTRA_CA_CERTS", "/etc/ssl/cert.pem");
    if (!options.noReload) {
      const domain = `gui/${process.getuid()}`;
      run("launchctl", ["bootout", `${domain}/${options.facadeLabel}`], { allowFailure: true });
      reloadMacService("ai.openclaw.gateway", options.gatewayPlist);
    }
  } else {
    if (fs.existsSync(facadeUnitPath)) fs.unlinkSync(facadeUnitPath);
    if (fs.existsSync(gatewayOverridePath)) fs.unlinkSync(gatewayOverridePath);
    const gatewayOverrideDir = path.dirname(gatewayOverridePath);
    if (fs.existsSync(gatewayOverrideDir) && fs.readdirSync(gatewayOverrideDir).length === 0) fs.rmdirSync(gatewayOverrideDir);
    if (!options.noReload) {
      assertSystemctlUserAvailable();
      run("systemctl", ["--user", "disable", "--now", facadeUnitName], { allowFailure: true });
      reloadLinuxGateway(options.gatewayUnit);
    }
  }

  console.log("Uninstall completed.");
}

main();
