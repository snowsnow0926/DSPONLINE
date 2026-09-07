"use strict";

const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { promisify } = require("node:util");
const execFileAsync = promisify(execFile);
const {
  PERFORMANCE_EDITION_IDENTITY,
  STABLE_IDENTITY,
  selectCompleteDesktopReleaseOutput,
} = require("./performance-edition-identity.cjs");
const {
  createDesktopUpdateFeedArguments,
  finalizePackagedOutput,
  identityBuilderArgs,
} = require("./pack.cjs");
const { selectDesktopReleaseOutputFromEnvironment } = require("./select-desktop-release-output.cjs");
const { writeFixture, context } = require("../tests/fixtures/desktop-release.cjs");

const repositoryRoot = path.resolve(__dirname, "..");
const HTTPS_BASE = "https://updates.example.test/desktop";
const CHANNELS = Object.freeze(["stable", "beta", "nightly"]);

function feedArguments(sourceDirectory, channel) {
  return [
    path.join(repositoryRoot, "scripts", "create-native-update-manifests.mjs"),
    "--channel",
    channel,
    "--base-url",
    HTTPS_BASE,
    "--desktop-source",
    sourceDirectory,
    "--output",
    path.join(sourceDirectory, "update-feed"),
  ];
}

function editionCases() {
  return [
    {
      label: "stable",
      identity: STABLE_IDENTITY,
      allowed: [
        path.join(repositoryRoot, STABLE_IDENTITY.outputDirectoryName),
        path.resolve(path.join(repositoryRoot, `${STABLE_IDENTITY.outputDirectoryName}-fallback`)),
      ],
      rejected: [
        path.join(repositoryRoot, PERFORMANCE_EDITION_IDENTITY.outputDirectoryName),
        path.resolve(path.join(repositoryRoot, `${PERFORMANCE_EDITION_IDENTITY.outputDirectoryName}-fallback`)),
      ],
    },
    {
      label: "performance",
      identity: PERFORMANCE_EDITION_IDENTITY,
      allowed: [
        path.join(repositoryRoot, PERFORMANCE_EDITION_IDENTITY.outputDirectoryName),
        path.resolve(path.join(repositoryRoot, `${PERFORMANCE_EDITION_IDENTITY.outputDirectoryName}-fallback`)),
      ],
      rejected: [
        path.join(repositoryRoot, STABLE_IDENTITY.outputDirectoryName),
        path.resolve(path.join(repositoryRoot, `${STABLE_IDENTITY.outputDirectoryName}-fallback`)),
      ],
    },
  ];
}

test("production feed-argument builder uses the packer's selected stable edition directories", () => {
  const standard = path.join(repositoryRoot, STABLE_IDENTITY.outputDirectoryName);
  const fallback = path.resolve(`${standard}-fallback`);
  assert.deepEqual(
    createDesktopUpdateFeedArguments(standard, {
      updateBaseUrl: HTTPS_BASE,
      releaseChannel: "stable",
    }),
    feedArguments(standard, "stable"),
  );
  assert.deepEqual(
    createDesktopUpdateFeedArguments(fallback, {
      updateBaseUrl: HTTPS_BASE,
      releaseChannel: "stable",
    }),
    feedArguments(fallback, "stable"),
  );
  assert.throws(
    () => createDesktopUpdateFeedArguments(
      path.join(repositoryRoot, PERFORMANCE_EDITION_IDENTITY.outputDirectoryName),
      { updateBaseUrl: HTTPS_BASE, releaseChannel: "stable" },
    ),
    /输出目录无效/,
  );
});

test("feed arguments keep edition identity while channels vary", () => {
  for (const edition of editionCases()) {
    for (const channel of CHANNELS) {
      for (const source of edition.allowed) {
        assert.deepEqual(
          createDesktopUpdateFeedArguments(source, {
            identity: edition.identity,
            releaseChannel: channel,
            updateBaseUrl: HTTPS_BASE,
          }),
          feedArguments(source, channel),
        );
      }
      for (const source of edition.rejected) {
        assert.throws(
          () => createDesktopUpdateFeedArguments(source, {
            identity: edition.identity,
            releaseChannel: channel,
            updateBaseUrl: HTTPS_BASE,
          }),
          /输出目录无效/,
        );
      }
    }
  }
});

test("feed arguments reject invalid identity, out-of-bounds paths, and missing HTTPS", () => {
  const standard = path.join(repositoryRoot, STABLE_IDENTITY.outputDirectoryName);
  assert.throws(
    () => createDesktopUpdateFeedArguments(standard, {
      identity: { ...STABLE_IDENTITY, editionId: "forged-v1" },
      updateBaseUrl: HTTPS_BASE,
    }),
    /输出身份无效/,
  );
  assert.throws(
    () => createDesktopUpdateFeedArguments(path.join(os.tmpdir(), "release"), {
      identity: STABLE_IDENTITY,
      updateBaseUrl: HTTPS_BASE,
    }),
    /输出目录无效/,
  );
  assert.throws(
    () => createDesktopUpdateFeedArguments(path.join(repositoryRoot, "release", "nested"), {
      identity: STABLE_IDENTITY,
      updateBaseUrl: HTTPS_BASE,
    }),
    /输出目录无效/,
  );
  assert.throws(
    () => createDesktopUpdateFeedArguments(standard, {
      identity: STABLE_IDENTITY,
      updateBaseUrl: "",
    }),
    /缺少 HTTPS 基址/,
  );
});

test("pack finalize does not create a release feed", async () => {
  let called = 0;
  const code = await finalizePackagedOutput(path.join(repositoryRoot, "release"), {
    verify() {},
    recordEvidence() {},
    releaseMode: false,
    createUpdateFeed: async () => {
      called += 1;
      return 0;
    },
  });
  assert.equal(code, 0);
  assert.equal(called, 0);
});

test("release finalize calls the production feed-argument builder and propagates failures", async () => {
  const standard = path.join(repositoryRoot, "release");
  let received;
  const success = await finalizePackagedOutput(standard, {
    verify() {},
    recordEvidence() {},
    releaseMode: true,
    createUpdateFeed: async (directory) => {
      received = createDesktopUpdateFeedArguments(directory, {
        updateBaseUrl: HTTPS_BASE,
        releaseChannel: "beta",
      });
      return 0;
    },
  });
  assert.equal(success, 0);
  assert.deepEqual(received, feedArguments(standard, "beta"));

  const failed = await finalizePackagedOutput(standard, {
    verify() {},
    recordEvidence() {},
    releaseMode: true,
    createUpdateFeed: async () => 9,
  });
  assert.equal(failed, 9);
});

test("desktop-release workflow collects the identity-module output instead of a hardcoded performance directory", () => {
  const workflow = fs.readFileSync(path.join(repositoryRoot, ".github/workflows/desktop-release.yml"), "utf8");
  const scripts = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8")).scripts;
  assert.match(workflow, /desktop:release/);
  assert.match(workflow, /desktop\/select-desktop-release-output\.cjs/);
  assert.equal(workflow.includes("release-performance-edition"), false);
  assert.match(scripts["desktop:release"], /desktop\/pack\.cjs release/);
  assert.equal(scripts["desktop:release"].includes("DSP_DESKTOP_EDITION"), false);
  assert.match(scripts["desktop:pack"], /desktop\/pack\.cjs pack/);
  assert.equal(scripts["desktop:pack"].includes("DSP_DESKTOP_EDITION"), false);
  assert.match(scripts["desktop:performance:pack"], /DSP_DESKTOP_EDITION=performance/);
});

test("builder identity arguments keep appId, EXE and uninstall policy isolated across channels", () => {
  const stableDirectory = path.join(repositoryRoot, STABLE_IDENTITY.outputDirectoryName);
  const performanceDirectory = path.join(repositoryRoot, PERFORMANCE_EDITION_IDENTITY.outputDirectoryName);
  const stable = identityBuilderArgs(STABLE_IDENTITY, stableDirectory);
  const performance = identityBuilderArgs(PERFORMANCE_EDITION_IDENTITY, performanceDirectory);
  assert.ok(stable.includes(`--config.appId=${STABLE_IDENTITY.appId}`));
  assert.ok(performance.includes(`--config.appId=${PERFORMANCE_EDITION_IDENTITY.appId}`));
  assert.ok(stable.includes(`--config.win.executableName=${STABLE_IDENTITY.executableName}`));
  assert.ok(performance.includes(`--config.win.executableName=${PERFORMANCE_EDITION_IDENTITY.executableName}`));
  assert.ok(stable.includes("--config.nsis.allowToChangeInstallationDirectory=true"));
  assert.ok(performance.includes("--config.nsis.allowToChangeInstallationDirectory=false"));
  assert.ok(stable.includes("--config.nsis.deleteAppDataOnUninstall=false"));
  assert.ok(performance.includes("--config.nsis.deleteAppDataOnUninstall=false"));
  assert.equal(stable.includes(`--config.appId=${PERFORMANCE_EDITION_IDENTITY.appId}`), false);
  assert.equal(performance.includes(`--config.appId=${STABLE_IDENTITY.appId}`), false);
  assert.equal(stable.includes(`--config.win.executableName=${PERFORMANCE_EDITION_IDENTITY.executableName}`), false);
  assert.equal(performance.includes(`--config.win.executableName=${STABLE_IDENTITY.executableName}`), false);
});

test("workflow selector defaults to the official stable edition and ignores a complete performance tree", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsp-desktop-release-cli-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const performanceFeed = path.join(root, "release-performance-edition", "update-feed", "desktop", "stable");
  fs.mkdirSync(performanceFeed, { recursive: true });
  fs.writeFileSync(path.join(root, "release-performance-edition", "latest.yml"), "version: 1.2.7\n");
  fs.writeFileSync(path.join(performanceFeed, "release.json"), "{}\n");
  assert.throws(
    () => selectDesktopReleaseOutputFromEnvironment({
      repositoryRoot: root,
      environment: { DSP_RELEASE_CHANNEL: "stable" },
      expected: context(),
    }),
    /found 0/,
  );

  await writeFixture(root, "release", "beta");
  const selected = selectDesktopReleaseOutputFromEnvironment({
    repositoryRoot: root,
    environment: { DSP_RELEASE_CHANNEL: "beta" },
    expected: context(STABLE_IDENTITY, "beta"),
  });
  assert.equal(selected.relativeOutputDirectory, "release");
  assert.equal(selected.identity.editionId, STABLE_IDENTITY.editionId);
});

test("real feed generator and identity selector agree on a synthetic stable release directory", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsp-desktop-feed-integration-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "release");
  await writeFixture(root, "release", "beta");
  const args = createDesktopUpdateFeedArguments(source, {
    repositoryRoot: root,
    identity: STABLE_IDENTITY,
    releaseChannel: "beta",
    updateBaseUrl: "https://updates.example.invalid/desktop/",
  });
  assert.equal(args[2], "beta");
  assert.equal(args[4], "https://updates.example.invalid/desktop/");
  assert.equal(args[6], source);
  await execFileAsync(process.execPath, args, { cwd: repositoryRoot });
  require("./desktop-artifact-evidence.cjs").writeDesktopBuildEvidence(source, { expected: context(STABLE_IDENTITY, "beta"), identity: STABLE_IDENTITY, release: true });
  const selected = selectCompleteDesktopReleaseOutput({
    repositoryRoot: root,
    identity: STABLE_IDENTITY,
    channel: "beta",
    expected: context(STABLE_IDENTITY, "beta"),
  });
  assert.equal(selected.relativeOutputDirectory, "release");
  const feed = JSON.parse(fs.readFileSync(path.join(source, "update-feed", "desktop", "beta", "release.json"), "utf8"));
  assert.equal(feed.channel, "beta");
  assert.equal(feed.files[1].name, "dsp-idle-1.2.7-x64-setup.exe");
  assert.throws(
    () => selectCompleteDesktopReleaseOutput({
      repositoryRoot: root,
      identity: PERFORMANCE_EDITION_IDENTITY,
      channel: "beta",
    }),
    /found 0/,
  );
});
