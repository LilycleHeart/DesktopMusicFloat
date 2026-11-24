import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import esbuild from 'esbuild';
import * as sass from 'sass';

const stage = 'dist/package';
const web = stage + '/desktop/web';
const manifest = JSON.parse(await fs.readFile('manifest.json', 'utf8'));
const hostName = manifest.slug + '-' + manifest.version;
await fs.rm(stage, { recursive: true, force: true });
await fs.mkdir(web, { recursive: true });

const bundle = { bundle: true, format: 'iife', minify: true, loader: { '.js': 'jsx' } };
await esbuild.build({
    ...bundle, target: 'chrome91', entryPoints: ['src/native/plugin.js'], outfile: stage + '/main.js',
    define: { __DESKTOP_HOST_FILE__: JSON.stringify(hostName + '.exe'),
        __DESKTOP_FLOAT_VERSION__: JSON.stringify(manifest.version) }
});
await esbuild.build({
    ...bundle, target: 'chrome109', entryPoints: ['src/renderer/desktop.js'], outfile: web + '/desktop.js'
});

const styles = ['src/styles/rnp-lyrics.scss', 'vendor/lyric-bar/src/styles.scss']
    .map(file => sass.compile(file, { logger: sass.Logger.silent }).css);
for (const file of ['src/renderer/nowplaying.css', 'src/styles/lyric-theme.css',
    'src/styles/lyric-wrap.css', 'src/renderer/desktop.css']) {
    styles.push(await fs.readFile(file, 'utf8'));
}
await fs.writeFile(web + '/desktop.css', styles.join('\n'));
const playerPage = await fs.readFile('src/renderer/nowplaying.html', 'utf8');
const article = playerPage.match(/<article\b[\s\S]*?<\/article>/)?.[0];
if (!article) throw new Error('The upstream song card is missing from nowplaying.html');
const desktopPage = await fs.readFile('src/renderer/index.html', 'utf8');
await fs.writeFile(web + '/index.html', desktopPage.replace('<!-- nowplaying article -->', article));
await fs.cp('licenses', stage + '/licenses', { recursive: true });
for (const library of ['react', 'react-dom']) {
    const root = 'node_modules/' + library;
    await fs.copyFile(root + '/umd/' + library + '.production.min.js', web + '/' + library + '.js');
    await fs.copyFile(root + '/LICENSE', stage + '/licenses/' + library + '-MIT.txt');
}
for (const file of ['manifest.json', 'LICENSE', 'README.md']) {
    await fs.copyFile(file, stage + '/' + file);
}

execFileSync('dotnet', [
    'publish', 'host/DesktopMusicFloat.csproj', '-c', 'Release', '-r', 'win-x64',
    '--self-contained', 'true', '-p:PublishSingleFile=true',
    '-p:IncludeNativeLibrariesForSelfExtract=true', '-p:EnableCompressionInSingleFile=true',
    '-p:DebugType=None', '-p:AllowedReferenceRelatedFileExtensions=.pdb', '-p:AssemblyName=' + hostName,
    '-o', stage + '/desktop'
], { stdio: 'inherit' });

const assets = JSON.parse(await fs.readFile('host/obj/project.assets.json', 'utf8'));
const [framework] = assets.project.restore.originalTargetFrameworks;
const depsPath = path.join('host', 'bin', 'Release', framework, 'win-x64', hostName + '.deps.json');
const deps = JSON.parse(await fs.readFile(depsPath, 'utf8'));
const shipped = Object.keys(deps.libraries)
    .filter(key => key.startsWith('runtimepack.') || key.startsWith('Microsoft.Web.WebView2/'))
    .map(key => key.replace(/^runtimepack\./, ''));
const netRuntime = shipped.find(key => key.startsWith('Microsoft.NETCore.App.Runtime.win-x64/'));
function packageDirectory(library) {
    const directory = Object.keys(assets.packageFolders)
        .map(folder => path.join(folder, library.toLowerCase()))
        .find(existsSync);
    if (!directory) throw new Error('Could not find redistributable package ' + library);
    return directory;
}
for (const library of shipped) {
    const [name] = library.split('/');
    const directory = packageDirectory(library);
    const destination = path.join(stage, 'licenses', name);
    await fs.mkdir(destination, { recursive: true });
    const notices = (await fs.readdir(directory)).filter(file => /^(license|third-party-notices|notice)(\.txt)?$/i.test(file));
    for (const file of notices) {
        await fs.copyFile(path.join(directory, file), path.join(destination, file));
    }
    if (notices.some(file => /^license/i.test(file))) continue;
    if (name === 'Microsoft.AspNetCore.App.Runtime.win-x64' && netRuntime) {
        // Both runtime packs use the .NET Foundation MIT text; ASP.NET's pack only contains the notices.
        const netLicense = path.join(packageDirectory(netRuntime), 'LICENSE.TXT');
        await fs.copyFile(netLicense, path.join(destination, 'LICENSE.TXT'));
    } else if (name === 'Microsoft.Windows.SDK.NET.Ref') {
        await fs.writeFile(path.join(destination, 'LICENSE-REFERENCE.txt'),
            library + '\nCopyright (c) Microsoft Corporation. All rights reserved.\nhttps://aka.ms/WinSDKLicenseURL\n');
    } else {
        throw new Error('Missing license for ' + library);
    }
}

execFileSync('powershell.exe', [
    '-NoProfile', '-File', 'package.ps1',
    '-Source', stage,
    '-Output', 'dist/' + manifest.slug + '-' + manifest.version + '.plugin'
], { stdio: 'inherit' });
