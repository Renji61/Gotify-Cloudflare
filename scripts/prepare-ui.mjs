// Builds the official Gotify web UI and copies it into ./public, which
// wrangler.jsonc serves as static assets.
//
//   npm run prepare-ui
//
// What it does:
//   1. Clones https://github.com/gotify/server.git at the tag pinned in
//      package.json ("gotify": { "tag": ... }) into ./.ui-src (git-ignored),
//      unless that folder already holds the right tag.
//   2. Runs `yarn install --frozen-lockfile` and `yarn build` in .ui-src/ui
//      (falls back to `npx yarn@1.22.22` when yarn is missing or is not version 1).
//   3. Replaces ./public with the build output (.ui-src/ui/build).
//
// To skip all of that and use a UI build you already have:
//   GOTIFY_UI_BUILD=/path/to/ui/build npm run prepare-ui
//
// Pass --force to rebuild even when ./public is already built for the pinned tag and commit.

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = join(root, 'public');
const srcDir = join(root, '.ui-src');
const uiDir = join(srcDir, 'ui');
const stampFile = join(srcDir, '.built-tag');

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const TAG = pkg.gotify?.tag;
const REPO = pkg.gotify?.repo ?? 'https://github.com/gotify/server.git';
if (!TAG) fail('package.json is missing "gotify": { "tag": "..." }');

// Node 22.13 or newer is needed (the UI's tooling needs 22.12+, this project's tests use node:sqlite).
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 13)) {
  fail(`Node.js 22.13 or newer is required (this is ${process.versions.node}). Install a newer Node.js and run again.`);
}

const force = process.argv.includes('--force');
const isWindows = process.platform === 'win32';

function fail(message) {
  console.error(`prepare-ui: ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  console.log(`> ${command} ${args.join(' ')}`);
  // On Windows yarn/npx are .cmd shims, which need a shell.
  const result = spawnSync(command, args, { stdio: 'inherit', shell: isWindows, ...options });
  return result.status === 0;
}

function capture(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', shell: isWindows, ...options });
  return result.status === 0 ? result.stdout.trim() : null;
}

function installPublic(buildDir) {
  if (!existsSync(join(buildDir, 'index.html'))) fail(`no UI build found at ${buildDir} (index.html is missing)`);
  if (!readFileSync(join(buildDir, 'index.html'), 'utf8').includes('%CONFIG%')) {
    console.warn('prepare-ui: warning: index.html does not contain the %CONFIG% placeholder; is this the Gotify UI build?');
  }
  rmSync(publicDir, { recursive: true, force: true });
  cpSync(buildDir, publicDir, { recursive: true });
  console.log(`prepare-ui: UI copied to ${publicDir}`);
}

// 1. A UI build that already exists.
if (process.env.GOTIFY_UI_BUILD) {
  installPublic(resolve(process.env.GOTIFY_UI_BUILD));
  process.exit(0);
}

// The commit this port was reviewed against: a tag can be moved, so it is checked with the tag.
const expected = /commit:\s*'([0-9a-f]{40})'/.exec(readFileSync(join(root, 'src', 'version.ts'), 'utf8'))?.[1];
if (!expected) fail('could not read the commit from src/version.ts');
const stamp = `${TAG} ${expected}`;

// Already built for this tag and commit.
if (!force && existsSync(join(publicDir, 'index.html')) && existsSync(stampFile) && readFileSync(stampFile, 'utf8').trim() === stamp) {
  console.log(`prepare-ui: ./public is already built for Gotify ${TAG} (${expected.slice(0, 7)}) (use --force to rebuild)`);
  process.exit(0);
}

// 2. Source checkout at the pinned tag.
if (existsSync(join(srcDir, '.git'))) {
  const current = capture('git', ['describe', '--tags', '--exact-match'], { cwd: srcDir });
  if (current !== TAG) {
    console.log(`prepare-ui: .ui-src is at ${current ?? 'an unknown revision'}, not ${TAG}; fetching it again`);
    rmSync(srcDir, { recursive: true, force: true });
  }
}
if (!existsSync(join(srcDir, '.git'))) {
  rmSync(srcDir, { recursive: true, force: true });
  if (!run('git', ['clone', '--depth', '1', '--branch', TAG, REPO, srcDir])) fail('git clone failed');
}
// The checked-out commit must be the one this port was reviewed against.
const head = capture('git', ['rev-parse', 'HEAD'], { cwd: srcDir });
if (head !== expected) {
  fail(`${TAG} in .ui-src is commit ${head ?? 'unknown'}, but src/version.ts pins ${expected}; the tag has moved or the pin is stale. Not building.`);
}
if (!existsSync(join(uiDir, 'package.json'))) fail(`${uiDir} has no package.json`);

// 3. Build. The UI's yarn.lock is a yarn 1 lockfile. Probe yarn inside the UI folder, because
// corepack may pick a version from a "packageManager" field there (and pin it, which we do not want).
const buildEnv = {
  ...process.env,
  PUPPETEER_SKIP_DOWNLOAD: '1', // browser downloads are not needed to build
  COREPACK_ENABLE_AUTO_PIN: '0', // do not let corepack edit package.json
};
let yarn = ['yarn'];
const yarnVersion = capture('yarn', ['--version'], { cwd: uiDir, env: buildEnv });
const yarnMajor = yarnVersion ? Number(yarnVersion.split('.')[0]) : NaN;
if (yarnMajor !== 1) {
  console.log(`prepare-ui: ${yarnVersion ? `yarn ${yarnVersion} is not yarn 1` : 'yarn was not found'}, using \`npx yarn@1.22.22\``);
  yarn = ['npx', '--yes', 'yarn@1.22.22'];
}
const yarnRun = (...args) => run(yarn[0], [...yarn.slice(1), ...args], { cwd: uiDir, env: buildEnv });
if (!yarnRun('install', '--frozen-lockfile')) fail('yarn install failed');
if (!yarnRun('build')) fail('yarn build failed');

installPublic(join(uiDir, 'build'));
writeFileSync(stampFile, stamp + '\n');
