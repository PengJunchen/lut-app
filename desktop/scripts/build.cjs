const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "../..");
const TARGETS = new Set(["darwin-arm64", "darwin-amd64", "windows-amd64"]);

function nativeTarget() {
  if (process.platform === "darwin" && process.arch === "arm64") return "darwin-arm64";
  if (process.platform === "darwin" && process.arch === "x64") return "darwin-amd64";
  if (process.platform === "win32" && process.arch === "x64") return "windows-amd64";
  throw new Error(`Unsupported native desktop target: ${process.platform}-${process.arch}`);
}

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: ROOT,
    env: process.env,
    stdio: "inherit",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function builderCLI() {
  const packageRoot = path.join(ROOT, "node_modules", "electron-builder");
  const packageData = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  const relativeCLI = typeof packageData.bin === "string"
    ? packageData.bin
    : packageData.bin["electron-builder"];
  if (!relativeCLI) throw new Error("electron-builder CLI entry was not found in its installed package");
  return path.join(packageRoot, relativeCLI);
}

function installNativeElectronRuntime() {
  const installer = path.join(ROOT, "node_modules", "electron", "install.js");
  run(process.execPath, [installer]);
}

function buildTarget(target, engineOnly) {
  const [goos, goarch] = target.split("-");
  const extension = goos === "windows" ? ".exe" : "";
  const generated = path.join(ROOT, "desktop", ".generated", target);
  const sidecar = path.join(generated, `engine${extension}`);
  fs.mkdirSync(generated, { recursive: true });

  run(process.env.PYTHON || "python3", ["desktop/scripts/prepare_assets.py", target]);
  run(process.env.GO || "go", [
    "build",
    "-tags", "bundled",
    "-trimpath",
    "-ldflags=-s -w",
    "-o", sidecar,
    "./cmd/lutapp",
  ], {
    env: { ...process.env, CGO_ENABLED: "0", GOOS: goos, GOARCH: goarch },
  });
  if (engineOnly) return;

  const electronArch = goarch === "amd64" ? "x64" : "arm64";
  const outputRelative = path.join(".work", "electron", target);
  const stagedOutput = path.join(ROOT, outputRelative);
  const artifact = {
    "darwin-arm64": "DJI-LUT-macOS-AppleSilicon.zip",
    "darwin-amd64": "DJI-LUT-macOS-Intel.zip",
    "windows-amd64": "DJI-LUT-Windows-x64.zip",
  }[target];
  fs.rmSync(stagedOutput, { recursive: true, force: true });
  const builderArgs = [
    builderCLI(),
    "--config", "desktop/electron-builder.config.cjs",
    "--publish", "never",
    ...(goos === "windows" ? ["--win", "zip", "--x64"] : ["--mac", "zip", `--${electronArch}`]),
  ];
  run(process.execPath, builderArgs, {
    env: { ...process.env, DJI_LUT_TARGET: target, DJI_LUT_OUTPUT: outputRelative },
  });

  const builtArchive = path.join(stagedOutput, artifact);
  if (!fs.existsSync(builtArchive)) {
    throw new Error(`electron-builder completed without producing ${path.relative(ROOT, builtArchive)}`);
  }
  const releaseOutput = path.join(ROOT, "dist", "electron");
  fs.mkdirSync(releaseOutput, { recursive: true });
  fs.copyFileSync(builtArchive, path.join(releaseOutput, artifact));
  fs.rmSync(stagedOutput, { recursive: true, force: true });
}

function main() {
  const args = process.argv.slice(2);
  const engineOnly = args.includes("--engine-only");
  const targets = args.filter((arg) => arg !== "--engine-only");
  if (targets.length === 0) targets.push(nativeTarget());

  for (const target of targets) {
    if (!TARGETS.has(target)) {
      throw new Error(`Unsupported target ${target}; choose darwin-arm64, darwin-amd64, or windows-amd64`);
    }
  }
  if (new Set(targets).size !== targets.length) {
    throw new Error("Target list contains a duplicate target");
  }
  if (!engineOnly) installNativeElectronRuntime();
  for (const target of targets) buildTarget(target, engineOnly);
}

try {
  main();
} catch (error) {
  const prefix = os.platform() === "win32" ? "Build error" : "Error";
  console.error(`${prefix}: ${error.message}`);
  process.exit(1);
}
