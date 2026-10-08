const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  checkSourceVersions,
  checkTag,
  parseTag,
  readSourceVersions,
  setSourceVersion,
} = require("../scripts/release-version.cjs");

function fixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dji-lut-release-version-"));
  fs.mkdirSync(path.join(root, "internal/engine"), { recursive: true });
  fs.mkdirSync(path.join(root, "packaging"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "test", version: "2.3.0" }, null, 2) + "\n");
  fs.writeFileSync(path.join(root, "package-lock.json"), JSON.stringify({
    name: "test",
    version: "2.3.0",
    lockfileVersion: 3,
    packages: { "": { name: "test", version: "2.3.0" } },
  }, null, 2) + "\n");
  fs.writeFileSync(path.join(root, "internal/engine/run.go"), 'package engine\n\nconst engineVersion = "2.3.0"\n');
  fs.writeFileSync(path.join(root, "packaging/build.py"), 'info = {"CFBundleShortVersionString": "2.1.0", "CFBundleVersion": "3"}\n');
  return root;
}

test("maps the initial rc alias to semver prerelease zero", () => {
  assert.deepEqual(parseTag("rc0.0.1"), {
    tag: "rc0.0.1",
    version: "0.0.1-rc.0",
    prerelease: true,
  });
});

test("maps future rc aliases and standard version tags", () => {
  assert.equal(parseTag("rc0.0.2").version, "0.0.2-rc.0");
  assert.deepEqual(parseTag("v1.2.3"), { tag: "v1.2.3", version: "1.2.3", prerelease: false });
  assert.deepEqual(parseTag("v1.2.3-rc.4"), {
    tag: "v1.2.3-rc.4",
    version: "1.2.3-rc.4",
    prerelease: true,
  });
});

test("rejects tags outside the supported naming forms", () => {
  for (const tag of ["rc01.0.1", "rc0.0.1-rc.0", "v1.2", "v1.2.3-beta.1", "V1.2.3", "v1.2.3-rc.01"]) {
    assert.throws(() => parseTag(tag), /unsupported release tag/);
  }
});

test("checks every shipped version field against the tag", () => {
  const root = fixtureRoot();
  try {
    setSourceVersion("0.0.1-rc.0", root);
    assert.deepEqual(readSourceVersions(root), {
      package: "0.0.1-rc.0",
      lockTopLevel: "0.0.1-rc.0",
      lockRoot: "0.0.1-rc.0",
      engine: "0.0.1-rc.0",
      goBundle: "0.0.1",
      goBundleBuild: "0.0.1",
    });
    assert.deepEqual(checkSourceVersions(root), { version: "0.0.1-rc.0", prerelease: true });
    assert.deepEqual(checkTag("rc0.0.1", root), {
      tag: "rc0.0.1",
      version: "0.0.1-rc.0",
      prerelease: true,
    });
    assert.throws(() => checkTag("rc0.0.2", root), /source versions are/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("reports a mismatch instead of changing source during tag validation", () => {
  const root = fixtureRoot();
  try {
    assert.throws(() => checkTag("rc0.0.1", root), /run node desktop\/scripts\/release-version\.cjs set/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version, "2.3.0");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
