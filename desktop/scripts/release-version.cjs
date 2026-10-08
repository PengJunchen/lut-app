#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "../..");
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-rc\.(0|[1-9]\d*))?$/;

function parseTag(tag) {
  if (typeof tag !== "string") throw new Error("tag must be a string");
  const rcAlias = /^rc((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.exec(tag);
  const standard = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-rc\.(?:0|[1-9]\d*))?)$/.exec(tag);
  if (rcAlias) {
    return { tag, version: `${rcAlias[1]}-rc.0`, prerelease: true };
  }
  if (standard && SEMVER.test(standard[1])) {
    return {
      tag,
      version: standard[1],
      prerelease: standard[1].includes("-rc."),
    };
  }
  throw new Error(
    `unsupported release tag ${JSON.stringify(tag)}; use rcX.Y.Z or vX.Y.Z[-rc.N]`
  );
}

function readSourceVersions(root = ROOT) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const packageLock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  const goSource = fs.readFileSync(path.join(root, "internal/engine/run.go"), "utf8");
  const buildSource = fs.readFileSync(path.join(root, "packaging/build.py"), "utf8");

  const engineVersions = [...goSource.matchAll(/\b(?:const|var)\s+engineVersion\s*=\s*"([^"]+)"/g)];
  const bundleVersions = [...buildSource.matchAll(/"CFBundleShortVersionString"\s*:\s*"([^"]+)"/g)];
  const bundleBuildVersions = [...buildSource.matchAll(/"CFBundleVersion"\s*:\s*"([^"]+)"/g)];
  if (engineVersions.length !== 1) {
    throw new Error("expected exactly one Go engineVersion string in internal/engine/run.go");
  }
  if (bundleVersions.length !== 1) {
    throw new Error("expected exactly one CFBundleShortVersionString in packaging/build.py");
  }
  if (bundleBuildVersions.length !== 1) {
    throw new Error("expected exactly one CFBundleVersion in packaging/build.py");
  }
  const lockRootVersion = packageLock.packages && packageLock.packages[""]
    ? packageLock.packages[""].version
    : undefined;
  return {
    package: packageJson.version,
    lockTopLevel: packageLock.version,
    lockRoot: lockRootVersion,
    engine: engineVersions[0][1],
    goBundle: bundleVersions[0][1],
    goBundleBuild: bundleBuildVersions[0][1],
  };
}

function checkSourceVersions(root = ROOT) {
  const versions = readSourceVersions(root);
  const canonical = [versions.package, versions.lockTopLevel, versions.lockRoot, versions.engine];
  const version = canonical[0];
  const numericBundleVersion = version && version.split("-")[0];
  if (!SEMVER.test(version || "") || canonical.some((candidate) => candidate !== version)
      || versions.goBundle !== numericBundleVersion || versions.goBundleBuild !== numericBundleVersion) {
    const rendered = Object.entries(versions).map(([name, version]) => `${name}=${version}`).join(", ");
    throw new Error(
      `release version fields are inconsistent: package, lock, and engine must use SemVer while ` +
      `CFBundleShortVersionString and CFBundleVersion must use its numeric X.Y.Z core: ${rendered}`
    );
  }
  return { version, prerelease: version.includes("-rc.") };
}

function checkTag(tag, root = ROOT) {
  const parsed = parseTag(tag);
  let source;
  try {
    source = checkSourceVersions(root);
  } catch (error) {
    throw new Error(
      `tag ${tag} resolves to ${parsed.version}, but ${error.message}; ` +
      `run node desktop/scripts/release-version.cjs set ${parsed.version}, review and commit the changes, then create the tag`
    );
  }
  if (source.version !== parsed.version) {
    const versions = readSourceVersions(root);
    const rendered = Object.entries(versions).map(([name, version]) => `${name}=${version}`).join(", ");
    throw new Error(
      `tag ${tag} resolves to ${parsed.version}, but source versions are ${rendered}; ` +
      `run node desktop/scripts/release-version.cjs set ${parsed.version}, review and commit the changes, then create the tag`
    );
  }
  return parsed;
}

function replaceExactlyOnce(source, expression, replacement, label) {
  const matches = [...source.matchAll(expression)];
  if (matches.length !== 1) throw new Error(`expected exactly one ${label} to update; found ${matches.length}`);
  return source.replace(expression, replacement);
}

function setSourceVersion(version, root = ROOT) {
  if (typeof version !== "string" || !SEMVER.test(version)) {
    throw new Error("version must be X.Y.Z or X.Y.Z-rc.N without leading zeroes");
  }

  const packagePath = path.join(root, "package.json");
  const lockPath = path.join(root, "package-lock.json");
  const enginePath = path.join(root, "internal/engine/run.go");
  const buildPath = path.join(root, "packaging/build.py");
  const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  const packageLock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  if (!packageLock.packages || !packageLock.packages[""]) {
    throw new Error("package-lock.json has no root package entry");
  }
  packageJson.version = version;
  packageLock.version = version;
  packageLock.packages[""].version = version;

  const goSource = replaceExactlyOnce(
    fs.readFileSync(enginePath, "utf8"),
    /\b((?:const|var)\s+engineVersion\s*=\s*)"[^"]+"/g,
    `$1"${version}"`,
    "engineVersion string"
  );
  const buildSource = replaceExactlyOnce(
    fs.readFileSync(buildPath, "utf8"),
    /("CFBundleShortVersionString"\s*:\s*)"[^"]+"/g,
    `$1"${version.split("-")[0]}"`,
    "CFBundleShortVersionString"
  );
  const numericBuildSource = replaceExactlyOnce(
    buildSource,
    /("CFBundleVersion"\s*:\s*)"[^"]+"/g,
    `$1"${version.split("-")[0]}"`,
    "CFBundleVersion"
  );

  const updates = [
    [packagePath, `${JSON.stringify(packageJson, null, 2)}\n`],
    [lockPath, `${JSON.stringify(packageLock, null, 2)}\n`],
    [enginePath, goSource],
    [buildPath, numericBuildSource],
  ];
  for (const [filePath, content] of updates) fs.writeFileSync(filePath, content, "utf8");
  return { version, files: updates.map(([filePath]) => path.relative(root, filePath)) };
}

function writeOutputs(result, outputPath) {
  if (!outputPath) return;
  const lines = [`version=${result.version}`, `prerelease=${result.prerelease}`];
  fs.appendFileSync(outputPath, `${lines.join("\n")}\n`, "utf8");
}

function usage() {
  console.error(
    "Usage:\n" +
    "  node desktop/scripts/release-version.cjs check-source [--github-output FILE]\n" +
    "  node desktop/scripts/release-version.cjs check-tag TAG [--github-output FILE]\n" +
    "  node desktop/scripts/release-version.cjs set VERSION"
  );
}

function main(argv) {
  const [command, value, outputFlag, outputPath] = argv;
  let result;
  if (command === "check-source" && (value === undefined || value === "--github-output")) {
    result = checkSourceVersions();
    writeOutputs(result, value === "--github-output" ? outputFlag : undefined);
  } else if (command === "check-tag" && value) {
    result = checkTag(value);
    if (outputFlag !== undefined && outputFlag !== "--github-output") throw new Error("unexpected argument after tag");
    writeOutputs(result, outputFlag === "--github-output" ? outputPath : undefined);
  } else if (command === "set" && value && outputFlag === undefined) {
    result = setSourceVersion(value);
  } else {
    usage();
    return 2;
  }
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`Release version error: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { checkSourceVersions, checkTag, parseTag, readSourceVersions, setSourceVersion };
