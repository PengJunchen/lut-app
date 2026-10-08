const { spawnSync } = require("node:child_process");
const path = require("node:path");

const TARGETS = {
  "darwin-arm64": { platform: "mac", arch: "arm64", binary: "engine", artifact: "DJI-LUT-macOS-AppleSilicon.zip" },
  "darwin-amd64": { platform: "mac", arch: "x64", binary: "engine", artifact: "DJI-LUT-macOS-Intel.zip" },
  "windows-amd64": { platform: "win", arch: "x64", binary: "engine.exe", artifact: "DJI-LUT-Windows-x64.zip" },
};

const target = process.env.DJI_LUT_TARGET;
const spec = TARGETS[target];
if (!spec) {
  throw new Error("DJI_LUT_TARGET must be darwin-arm64, darwin-amd64, or windows-amd64");
}

function hasWine() {
  if (process.platform === "win32") return true;
  for (const executable of ["wine", "wine64"]) {
    const result = spawnSync(executable, ["--version"], { stdio: "ignore" });
    if (!result.error && result.status === 0) return true;
  }
  return false;
}

const generated = path.join("desktop", ".generated", target);

module.exports = {
  appId: "local.dji-lut.desktop",
  productName: "DJI LUT",
  directories: {
    output: process.env.DJI_LUT_OUTPUT || "dist/electron",
    buildResources: "desktop",
  },
  files: [
    "desktop/main.cjs",
    "desktop/preload.cjs",
    "desktop/lib/**/*",
    "package.json",
  ],
  extraResources: [
    { from: path.join(generated, spec.binary), to: path.posix.join("engine", spec.binary) },
    { from: path.join(generated, "licenses"), to: "licenses" },
    { from: "LICENSE", to: "LICENSE" },
    { from: "THIRD_PARTY.md", to: "THIRD_PARTY.md" },
    { from: "docs/ELECTRON.zh-CN.md", to: "USAGE.zh-CN.md" },
    { from: "assets/SOURCES.md", to: "assets/SOURCES.md" },
    { from: "assets/catalog.json", to: "assets/catalog.json" },
    { from: "assets/library.json", to: "assets/library.json" },
    { from: "packaging/runtime-lock.json", to: "packaging/runtime-lock.json" },
    { from: "packaging/license-lock.json", to: "packaging/license-lock.json" },
  ],
  artifactName: spec.artifact,
  mac: spec.platform === "mac" ? {
    target: [{ target: "zip", arch: [spec.arch] }],
    minimumSystemVersion: "13.0",
    identity: "-",
    binaries: ["Contents/Resources/engine/engine"],
  } : undefined,
  win: spec.platform === "win" ? {
    target: [{ target: "zip", arch: [spec.arch] }],
    signAndEditExecutable: hasWine(),
  } : undefined,
};
