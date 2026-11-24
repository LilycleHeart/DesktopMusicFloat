import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import WebSocket from 'ws';

async function until(check, description, timeout = 9000) {
    const before = Date.now();
    let cause;
    while (Date.now() - before < timeout) {
        try {
            const result = await check();
            if (result) return result;
        } catch (error) { cause = error; }
        await delay(90);
    }
    throw new Error(description, { cause });
}

async function reservePort() {
    const server = net.createServer().listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address();
    await new Promise(resolve => server.close(resolve));
    return port;
}

async function openSocket(url) {
    const socket = new WebSocket(url);
    await once(socket, 'open');
    socket.on('error', () => {});
    return socket;
}

function devTools(socket) {
    let sequence = 0;
    const pending = new Map();
    socket.on('message', bytes => {
        const packet = JSON.parse(bytes);
        const callback = pending.get(packet.id);
        if (!callback) return;
        pending.delete(packet.id);
        callback(packet);
    });
    const call = async (method, params = {}) => {
        const id = ++sequence;
        const packet = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                pending.delete(id);
                reject(new Error('WebView2 timed out for ' + method));
            }, 5000);
            pending.set(id, response => { clearTimeout(timer); resolve(response); });
            socket.send(JSON.stringify({ id, method, params }));
        });
        if (packet.error) throw new Error(packet.error.message);
        return packet.result;
    };
    return {
        call,
        async value(expression, awaitPromise = false) {
            const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
            assert.equal(result.exceptionDetails, undefined, result.exceptionDetails?.text);
            return result.result.value;
        }
    };
}

test('Windows overlay renders karaoke, switches hover controls, and sends player commands', { timeout: 50000 }, async () => {
    const folder = await mkdtemp(path.join(os.tmpdir(), 'desktop music float test-'));
    await writeFile(path.join(folder, 'window.json'), JSON.stringify({ ClickThrough: true, X: 0, Y: 350 }));
    const debugPort = await reservePort();
    const manifest = JSON.parse(await readFile('dist/package/manifest.json', 'utf8'));
    const exe = path.resolve('dist/package/desktop', manifest.slug + '-' + manifest.version + '.exe');
    const host = spawn(exe, [encodeURIComponent(folder)], { env: {
        ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + debugPort
    } });
    const exited = once(host, 'exit');
    let player, debuggerSocket, heartbeat;
    try {
        const config = await until(async () =>
            JSON.parse(await readFile(path.join(folder, 'session.json'), 'utf8')), 'Desktop host did not start');
        assert.equal(config.version, manifest.version);
        await until(async () => JSON.parse(await readFile(path.join(folder, 'window.json'), 'utf8')).ClickThrough === false,
            'The host did not clear click-through on launch');
        const endpoint = 'ws://127.0.0.1:' + config.port + '/player?token=';
        await assert.rejects(openSocket(endpoint + '0'.repeat(64)), /403/);
        player = await openSocket(endpoint + config.token);
        const commands = [];
        player.on('message', packet => commands.push(JSON.parse(packet)));
        const send = packet => player.send(JSON.stringify(packet));
        heartbeat = setInterval(() => send({ type: 'heartbeat' }), 1000);
        const target = await until(async () => {
            const request = await fetch('http://127.0.0.1:' + debugPort + '/json/list',
                { signal: AbortSignal.timeout(500) });
            return (await request.json()).find(page => page.url.endsWith('/index.html'));
        }, 'WebView2 did not load the floating window', 15000);
        debuggerSocket = await openSocket(target.webSocketDebuggerUrl);
        const { value, call } = devTools(debuggerSocket);
        const rendererIssues = [];
        debuggerSocket.on('message', bytes => {
            const packet = JSON.parse(bytes);
            if (packet.method === 'Runtime.exceptionThrown') rendererIssues.push(packet.params.exceptionDetails.exception?.description);
        });
        await call('Runtime.enable');
        await until(() => value('!!document.querySelector("#timeline") && !!window.__lyricBarObsViewer'),
            'The bundled renderer did not start');
        const layout = await value(`[...document.querySelectorAll(".art-frame, .song-heading, #timeline, #track")]
            .map(element => {const {x, y, width, height} = element.getBoundingClientRect();
                return [x, y, width, height].map(Math.round)})`);
        assert.deepEqual(layout, [[24, 176, 134, 134], [168, 176, 308, 77], [168, 262, 308, 48], [24, 320, 452, 8]]);
        const lyrics = { lyrics: [
            { time: 0, duration: 8500, originalLyric: '第一行逐字歌词', translatedLyric: 'First line',
                dynamicLyric: [{ time: 0, duration: 4000, word: '第一行' }, { time: 4000, duration: 4500, word: '逐字歌词' }] },
            { time: 8500, duration: 8500, originalLyric: '第二行逐字歌词', translatedLyric: 'Second line' }
        ] };
        const clock = (seconds, playing, seek = 0) => ({ id: 'fixture', seconds, playing, seek, at: Date.now() });
        const song = { id: 'fixture', title: '夜色航线', artist: '测试歌手', duration: 240, cover: '' };
        send({ type: 'snapshot', song, lyrics, progress: clock(3, true), theme: { dark: true }, offset: 0 });
        await until(() => value('document.querySelector("#title").textContent === "夜色航线"'), 'Song title did not render');
        await until(() => value(`!document.querySelector("#lyrics-slot").hasAttribute("data-collapsed") &&
            document.querySelectorAll("#bar-inner [offset='0'] .rnp-karaoke-word").length === 2 &&
            document.querySelector("#bar-inner [offset='0']").textContent.includes("First line") &&
            innerHeight === 352`), 'Karaoke or translation did not render').catch(async error => {
            const state = await value(`JSON.stringify({ body: document.body.className, height: innerHeight,
                markup: document.querySelector("#lyrics-slot").outerHTML.slice(0, 1600) })`);
            throw new Error(error.message + ': ' + state + ' ' + JSON.stringify(rendererIssues));
        });
        const lyricsOnLeft = () => value(`(() => {
            const lyrics = document.querySelector("#bar-root").getBoundingClientRect();
            const cover = document.querySelector(".art-frame").getBoundingClientRect();
            const row = document.querySelector("#bar-inner [offset='0']").getBoundingClientRect();
            return lyrics.width > 0 && Math.abs(lyrics.left - cover.left) < 1 && Math.abs(row.left - lyrics.left) < 1;
        })()`);
        await until(lyricsOnLeft, 'Automatic lyrics alignment did not follow the card on the left');
        assert.deepEqual(await value(`["#title", "#artist", "#bar-inner [offset='0'] .rnp-karaoke-word",
            "#bar-inner [offset='0'] .rnp-lyrics-line-translated"].map(selector =>
                getComputedStyle(document.querySelector(selector)).fontWeight)`), ['700', '700', '700', '700']);
        const fontAlias = 'NCMFM-Test';
        const fontSnapshot = localName => send({
            type: 'snapshot', song, lyrics, progress: clock(3, true), offset: 0,
            theme: {
                dark: true, font: fontAlias + ', sans-serif',
                fontFaces: [{ family: fontAlias, source: 'local("' + localName + '")',
                    weight: '400', style: 'normal', unicodeRange: 'U+20-7E', display: 'swap' }]
            }
        });
        fontSnapshot('Consolas');
        await until(() => value(`["#title", "#artist", "#bar-inner .rnp-lyrics-line-translated"].every(selector =>
            getComputedStyle(document.querySelector(selector)).fontFamily.includes("${fontAlias}"))`),
        'The font manager did not reach all song and lyric text');
        const fontWidth = () => value(`(async () => {
            const rule = '24px "${fontAlias}"';
            const faces = await document.fonts.load(rule, 'iiiiiiii');
            if (faces.length !== 1 || faces[0].status !== 'loaded' || faces[0].unicodeRange.toUpperCase() !== 'U+20-7E')
                return null;
            const context = document.createElement('canvas').getContext('2d');
            context.font = rule;
            return context.measureText('iiiiiiii').width;
        })()`, true);
        const monoWidth = await until(fontWidth, 'The local font and its Unicode range did not load');
        fontSnapshot('Arial');
        await until(async () => {
            const width = await fontWidth();
            return width !== null && Math.abs(width - monoWidth) > 10;
        }, 'Changing the source of an existing font alias did not refresh the rendered font');
        send({ type: 'snapshot', song, lyrics, progress: clock(3, true), theme: { dark: true }, offset: 0 });
        await until(() => value(`![...document.fonts].some(face => face.family === "${fontAlias}") &&
            !getComputedStyle(document.querySelector('#title')).fontFamily.includes("${fontAlias}")`),
        'Disabling Font Manager did not restore the theme font');

        const getRhythm = () => value('document.querySelector(".rhythm path").getAttribute("d")');
        const start = await getRhythm();
        await until(async () => await getRhythm() !== start, 'Waveform did not animate');
        if (process.env.DESKTOP_FLOAT_PREVIEW) {
            await value('document.documentElement.style.background = "#121b1e"');
            const previewSong = { ...song, title: 'エレクトリック・ミラージュ・感情',
                artist: 'テクノポップ・有機・シンセサイザーちゃん',
                cover: 'https://p2.music.126.net/B4cCyes4GUKbtfFtCkPg_A==/109951172180838695.jpg',
                duration: 303 };
            const colors = { '--md-accent-color-rgb': '64, 209, 233',
                '--md-accent-color-bg-rgb': '45, 48, 49', '--md-accent-color-secondary-rgb': '64, 209, 233' };
            send({ type: 'snapshot', song: previewSong, lyrics, progress: clock(3, true),
                theme: { dark: true, colors }, offset: 0 });
            await until(() => value('!document.querySelector("#cover").hidden'), 'Preview album cover did not load');
            await delay(350);
            const image = await call('Page.captureScreenshot', { format: 'png' });
            await writeFile(process.env.DESKTOP_FLOAT_PREVIEW, Buffer.from(image.data, 'base64'));
        }
        const rail = await value(`(() => {const r = document.querySelector("#timeline").getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };})()`);
        await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rail.x - 125, y: rail.y });
        await until(() => value('getComputedStyle(document.querySelector("#controls")).visibility === "visible"'),
            'Hover did not reveal the controls');
        send({ type: 'volume', level: 0.32 });
        await until(() => value(`document.querySelector("#volume").value === "32" &&
            !document.querySelector("#volume").disabled`), 'The client volume did not reach the hover control');
        assert.equal(await value('document.querySelector("#volume-panel").hidden'), true);
        const center = selector => value(`(() => {const box = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
            return { x: box.x + box.width / 2, y: box.y + box.height / 2 };})()`);
        const speaker = await center('#volume-trigger');
        await call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...speaker });
        await until(() => value(`(() => {
            const panel = document.querySelector("#volume-panel");
            const slider = document.querySelector("#volume").getBoundingClientRect();
            return !panel.hidden && slider.height > slider.width &&
                panel.getBoundingClientRect().bottom <= document.querySelector("#volume-trigger").getBoundingClientRect().top;
        })()`), 'The vertical volume popover did not open above the speaker');
        assert.deepEqual(await value(`(() => {
            const style = getComputedStyle(document.querySelector("#volume-panel"));
            return [style.backgroundColor, style.borderTopWidth, style.boxShadow,
                document.querySelector("#volume-percent").textContent];
        })()`), ['rgba(0, 0, 0, 0)', '0px', 'none', '32%']);
        await call('Input.dispatchMouseEvent', { type: 'mouseWheel', ...speaker, deltaX: 0, deltaY: -120 });
        await until(() => commands.some(command => command.action === 'volume' && command.ratio === 0.37),
            'Wheel up over the speaker did not raise the volume');
        const slider = await center('#volume');
        await call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...slider });
        assert.equal(await value('document.querySelector("#volume-panel").hidden'), false);
        await call('Input.dispatchMouseEvent', { type: 'mouseWheel', ...slider, deltaX: 0, deltaY: 120 });
        await until(() => commands.some(command => command.action === 'volume' && command.ratio === 0.32),
            'Wheel down over the slider did not lower the volume');
        await value(`(() => {const slider = document.querySelector("#volume"); slider.value = 68;
            slider.dispatchEvent(new Event("input")); slider.dispatchEvent(new Event("change"));})()`);
        await until(() => commands.some(command => command.action === 'volume' && command.ratio === 0.68),
            'The hover volume slider did not send the native command');
        if (process.env.DESKTOP_FLOAT_PREVIEW) {
            await delay(220);
            const image = await call('Page.captureScreenshot', { format: 'png' });
            const preview = path.parse(process.env.DESKTOP_FLOAT_PREVIEW);
            await writeFile(path.join(preview.dir, preview.name + '-controls.png'), Buffer.from(image.data, 'base64'));
        }
        for (const action of ['previous', 'toggle', 'next']) {
            await value('document.querySelector(' + JSON.stringify('[data-play="' + action + '"]') + ').click()');
            await until(() => commands.some(command => command.action === action), 'Control was not forwarded: ' + action);
        }
        await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 50, y: rail.y - 85 });
        await until(() => value('getComputedStyle(document.querySelector("#controls")).visibility === "hidden"'),
            'Leaving hover did not restore the waveform');
        assert.equal(await value('document.querySelector("#volume-panel").hidden'), true);
        await value(`(() => {
            window.suppressRailEnter = new AbortController();
            document.querySelector("#timeline").addEventListener("pointerenter", event => event.stopImmediatePropagation(),
                { capture: true, signal: window.suppressRailEnter.signal });
        })()`);
        for (let pass = 0; pass < 3; pass++) {
            await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rail.x - 125, y: rail.y });
            await until(() => value('document.querySelector("#timeline").classList.contains("controls-visible")'),
                'Re-entering the rail without pointerenter did not restore the controls');
            await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 50, y: rail.y - 85 });
            await until(() => value('!document.querySelector("#timeline").classList.contains("controls-visible")'),
                'Moving away did not restore the waveform');
        }
        await value('window.suppressRailEnter.abort()');
        await value(`(() => {const slider = document.querySelector("#seek"); slider.value = 500;
            slider.dispatchEvent(new Event("input")); slider.dispatchEvent(new Event("change"));})()`);
        const seek = await until(() => commands.find(command => command.action === 'seek'), 'Seek was not forwarded');
        assert.deepEqual({ id: seek.id, ratio: seek.ratio }, { id: 'fixture', ratio: 0.5 });
        send({ type: 'progress', progress: clock(10, false, 1) });
        await until(() => value(`document.querySelector("#play").title === "播放" &&
            document.querySelector("#bar-inner [offset='0']")?.textContent.includes("Second line")`),
        'Pausing or seeking did not update the lyrics');
        await value(`(() => {window.cardPositions = []; const sample = () => {
            const card = document.querySelector(".art-frame").getBoundingClientRect();
            const title = getComputedStyle(document.querySelector("#title")).transform;
            window.cardPositions.push([screenX, screenY, innerHeight, card.x, card.y, title]);
            window.sampleCard = requestAnimationFrame(sample);
        }; sample();})()`);
        const next = { ...song, id: 'second', title: '第二首测试曲目' };
        const nextProgress = { ...clock(1, true, 2), id: next.id };
        send({ type: 'snapshot', song: next, lyrics: { lyrics: [] }, progress: nextProgress, theme: { dark: true } });
        await until(() => value(`document.querySelector("#title").textContent === "第二首测试曲目" &&
            document.querySelector("#lyrics-slot").hasAttribute("data-collapsed")`),
        'Switching tracks did not clear the old lyrics');
        const nextLyrics = { lyrics: [
            { time: 0, duration: 8000, originalLyric: '新歌歌词已经同步' },
            { time: 8000, duration: 8000, originalLyric: '后续歌词' }
        ] };
        send({ type: 'snapshot', song: next, lyrics: nextLyrics, progress: nextProgress, theme: { dark: true } });
        await until(() => value(`!document.querySelector("#lyrics-slot").hasAttribute("data-collapsed") &&
            document.querySelector("#bar-inner [offset='0']")?.textContent.includes("新歌歌词已经同步")`),
        'Delayed lyrics did not return after switching tracks');
        assert.equal(await lyricsOnLeft(), true, 'Changing lyric width moved the left edge');
        assert.equal(await value(`getComputedStyle(document.querySelector(
            "#bar-inner [offset='0'] .rnp-lyrics-line-original")).fontWeight`), '700');
        const positions = await value(`(() => {cancelAnimationFrame(window.sampleCard);return window.cardPositions})()`);
        const initial = positions[0].slice(0, 5);
        assert.ok(positions.length > 3 && positions.every(position => position.slice(0, 5)
            .every((coordinate, index) => coordinate === initial[index])), 'Switching tracks moved or resized the card');
        assert.ok(positions.every(position => position[5] === 'none' || position[5] === 'matrix(1, 0, 0, 1, 0, 0)'),
            'The title shifted vertically during the transition');
        for (const [action, key, expected] of [['top', 'AlwaysOnTop', false], ['through', 'ClickThrough', true],
            ['dock', 'AutoHide', true]]) {
            await value('document.querySelector(' + JSON.stringify('[data-option="' + action + '"]') + ').click()');
            await until(async () => JSON.parse(await readFile(path.join(folder, 'window.json'), 'utf8'))[key] === expected,
                'Native setting did not persist: ' + key);
        }
        assert.notEqual(JSON.parse(await readFile(path.join(folder, 'window.json'), 'utf8')).Edge, 0);
        send({ type: 'restore-interaction' });
        await until(async () => JSON.parse(await readFile(path.join(folder, 'window.json'), 'utf8')).ClickThrough === false,
            'The BetterNCM recovery command did not restore mouse interaction');
        await until(() => value('document.querySelector("[data-option=through]").getAttribute("aria-pressed") === "false"'),
            'The restored state did not reach the hover controls');
        send({ type: 'quit' });
        assert.deepEqual(await exited, [0, null]);
        await assert.rejects(readFile(path.join(folder, 'session.json')), { code: 'ENOENT' });
    } finally {
        clearInterval(heartbeat);
        debuggerSocket?.terminate();
        player?.terminate();
        if (host.exitCode === null && host.signalCode === null) host.kill();
        await exited.catch(() => {});
        await rm(folder, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
});
