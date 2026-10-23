import { createReadStream, createWriteStream } from 'node:fs';
import { access, copyFile, cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { ZipArchive } from 'archiver';
import puppeteer from 'puppeteer';

if (process.platform !== 'win32' || process.arch !== 'x64') throw Error('Build gatherzap.exe on 64-bit Windows with Node.js 24+ and the .NET 10 SDK.');
const root = fileURLToPath(new URL('..', import.meta.url));
const buildRoot = path.join(root, '.build');
await mkdir(buildRoot, { recursive: true });
const reuse = process.argv[2] === '--reuse-payload';
const work = reuse ? path.resolve(process.argv[3] ?? '') : await mkdtemp(path.join(buildRoot, 'windows-'));
if (!work.startsWith(buildRoot + path.sep)) throw Error('Reusable payload must be inside .build.');
const stage = path.join(work, 'app');
if (!reuse) await mkdir(stage);
const env = { ...process.env, PUPPETEER_SKIP_DOWNLOAD: 'true',
  DOTNET_CLI_HOME: path.join(buildRoot, 'dotnet-home'), NUGET_PACKAGES: path.join(buildRoot, 'nuget'),
  DOTNET_NOLOGO: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1', NUGET_XMLDOC_MODE: 'skip' };

async function run(executable, args, cwd = root) {
  const child = spawn(executable, args, { cwd, env, stdio: 'inherit', windowsHide: true });
  const [code] = await once(child, 'exit');
  if (code !== 0) throw Error(`Build command failed (${path.basename(executable)}, exit ${code}).`);
}

const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const payload = path.join(work, 'payload.zip');
const manifest = path.join(work, 'manifest.json');
let id;
if (!reuse) {
const chrome = puppeteer.executablePath();
await access(chrome);
console.log('Preparing the application, Node.js, and its matching Chrome browser…');
await Promise.all([
  cp(path.join(root, 'src'), path.join(stage, 'src'), { recursive: true }),
  cp(path.join(root, 'ui'), path.join(stage, 'ui'), { recursive: true }),
  cp(path.dirname(chrome), path.join(stage, 'browser'), { recursive: true }),
  copyFile(process.execPath, path.join(stage, 'node.exe')),
  copyFile(path.join(root, 'package.json'), path.join(stage, 'package.json')),
  copyFile(path.join(root, 'package-lock.json'), path.join(stage, 'package-lock.json')),
]);
await mkdir(path.join(stage, 'desktop'));
for (const name of ['paths.js', 'server.js']) await copyFile(path.join(root, 'desktop', name), path.join(stage, 'desktop', name));
// An allowlist above prevents sessions, local settings, secrets, tests, and build
// artifacts from entering the distributable.
const npm = process.env.npm_execpath ?? path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
await run(process.execPath, [npm, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', path.join(buildRoot, 'npm-cache')], stage);

console.log('Adding Node.js redistribution notices…');
const licenseFile = path.join(buildRoot, `node-${process.version}-LICENSE.txt`);
let license;
try { license = await readFile(licenseFile, 'utf8'); }
catch {
  const response = await fetch(`https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`);
  if (!response.ok) throw Error('Could not download the bundled Node.js license.');
  license = await response.text();
  await writeFile(licenseFile, license);
}
await writeFile(path.join(stage, 'NODE-LICENSE.txt'), license);

console.log('Compressing the portable payload…');
const archive = new ZipArchive({ zlib: { level: 6 } });
const output = createWriteStream(payload);
const archived = new Promise((resolve, reject) => { output.once('close', resolve); output.once('error', reject); archive.once('error', reject); });
archive.pipe(output); archive.directory(stage, false); await archive.finalize(); await archived;
const hash = createHash('sha256');
for await (const chunk of createReadStream(payload)) hash.update(chunk);
id = hash.digest('hex');
await writeFile(manifest, JSON.stringify({ id, version: metadata.version, node: process.version }));
} else {
  await access(payload);
  id = JSON.parse(await readFile(manifest, 'utf8')).id;
}

console.log('Publishing the hidden-console, self-contained Windows launcher…');
const destination = path.join(root, 'dist');
const publishArgs = ['publish', path.join(root, 'desktop', 'windows', 'gatherzap.csproj'), '-c', 'Release', '-r', 'win-x64',
  '--self-contained', 'true', '-o', destination, `-p:PayloadPath=${payload}`, `-p:ManifestPath=${manifest}`, `-p:Version=${metadata.version}`];
const feed = path.join(buildRoot, 'nuget-feed');
let hasFeed = false; try { await access(feed); hasFeed = true; } catch {}
try { await run('dotnet', hasFeed ? [...publishArgs, '--source', feed] : publishArgs); }
catch (error) {
  const assets = JSON.parse(await readFile(path.join(root, 'desktop', 'windows', 'obj', 'project.assets.json'), 'utf8'));
  if (!assets.logs?.some(log => ['NU1301', 'NU1101'].includes(log.code))) throw error;
  // Some managed Windows environments cannot use .NET's TLS provider. Fetch the
  // SDK-declared runtime packs from the official NuGet endpoint using Node's TLS
  // provider, then restore from that local feed. TLS verification stays enabled.
  await mkdir(feed, { recursive: true });
  const packs = Object.values(assets.project.frameworks).flatMap(framework => [
    ...(framework.downloadDependencies ?? []),
    ...Object.entries(framework.dependencies ?? {}).filter(([, dependency]) => dependency.autoReferenced)
      .map(([name, dependency]) => ({ name, version: dependency.version })),
  ]);
  if (!packs.length) throw error;
  for (const pack of packs) {
    const name = pack.name.toLowerCase();
    const version = pack.version.match(/\[([0-9.]+),/)?.[1];
    if (!/^[a-z0-9.-]+$/.test(name) || !version) throw error;
    const filename = `${name}.${version}.nupkg`;
    try { await access(path.join(feed, filename)); continue; } catch {}
    console.log(`Downloading official runtime pack ${name} ${version}…`);
    const response = await fetch(`https://api.nuget.org/v3-flatcontainer/${name}/${version}/${filename}`);
    if (!response.ok) throw Error(`Runtime pack download failed (${response.status}).`);
    await writeFile(path.join(feed, filename), Buffer.from(await response.arrayBuffer()));
  }
  await run('dotnet', [...publishArgs, '--source', feed]);
}
await writeFile(path.join(buildRoot, 'latest-windows-build.json'), JSON.stringify({ id, work, payload, executable: path.join(destination, 'gatherzap.exe') }, null, 2));
console.log(`Built ${path.join(destination, 'gatherzap.exe')}`);
