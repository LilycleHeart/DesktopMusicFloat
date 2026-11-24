import { normalizeSong } from './metadata.js';

const enabledKey = 'desktop-music-float-enabled';
const enabled = () => localStorage.getItem(enabledKey) !== 'false';
const join = (base, path) => base.replace(/[\\/]+$/, '') + '/' + path;
const windowsPath = value => value.replaceAll('/', '\\');
const playbackButtons = new Map([['previous', '.btnc-prv'], ['toggle', '.btnp'], ['next', '.btnc-nxt']]);

let folder, executable, player;
let socket, retry, launchTime = 0, currentHost = false, pendingWindowAction;
const emptyLyrics = { lyrics: [] };
const lyricsBySong = new Map();
let song = null, lastSeenLyrics, offset = 0;
let clock = { seconds: 0, at: Date.now(), playing: false, id: '0', seek: 0 };
let nativeDuration = 0, nativeId = '', signature = '', lyricRevision = 0;
let lastMetaRead = 0, metadataTimer;
let lastVolume = null;
let managerStyleText, managedFonts;
let status = '等待插件初始化';
const statusViews = new Set();

function setStatus(value) {
    status = value;
    for (const update of statusViews) update(value);
}

function activePlayer() {
    return document.querySelector('.m-player:not(.f-dn)') || player;
}

function isPlaying() {
    return !!document.querySelector('.m-player:not(.f-dn) .btnp')?.classList.contains('btnp-pause');
}

function currentSong() {
    let playing;
    try {
        playing = betterncm.ncm.getPlayingSong?.() || betterncm.ncm.getPlaying?.();
    } catch {}
    const info = document.querySelector('.g-single-track .inf');
    return normalizeSong(playing, {
        title: document.querySelector('#main-player .j-title .name')?.textContent || info?.querySelector('.title .name')?.textContent,
        artist: document.querySelector('#main-player .j-title .by')?.textContent,
        cover: document.querySelector('#main-player .j-cover, .g-single-track img.front.j-cover')?.src
    });
}

// Capture the same metadata and playback events as OBSStreamSuite's song-publisher.js.
function readSong() {
    const next = currentSong();
    if (next && next.id !== song?.id) {
        nativeDuration = 0;
        clock = { seconds: 0, at: Date.now(), playing: isPlaying(), id: next.id, seek: clock.seek + 1 };
    }
    if (next && !next.duration) next.duration = nativeDuration;
    song = next;
    lastMetaRead = Date.now();
}

function readManagedFonts() {
    const stylesheet = document.getElementById('ncm-font-manager-fontfaces');
    if (!stylesheet?.sheet) return null;
    const css = stylesheet.textContent;
    if (css === managerStyleText) return managedFonts;

    // The applied stylesheet includes the current preview as well as saved settings.
    const rules = Array.from(stylesheet.sheet.cssRules);
    const font = rules.find(rule => rule.selectorText === 'body')?.style.fontFamily;
    const fontFaces = rules.filter(rule => rule.type === CSSRule.FONT_FACE_RULE).map(({ style }) => ({
        family: style.getPropertyValue('font-family'),
        source: style.getPropertyValue('src'),
        weight: style.getPropertyValue('font-weight') || 'normal',
        style: style.getPropertyValue('font-style') || 'normal',
        unicodeRange: style.getPropertyValue('unicode-range') || 'U+0-10FFFF',
        display: style.getPropertyValue('font-display') || 'auto'
    }));
    managerStyleText = css;
    managedFonts = { font, fontFaces };
    return managedFonts;
}

function readTheme() {
    const style = getComputedStyle(player);
    const dark = document.body.classList.contains('md-dark') ||
        document.body.classList.contains('md-dynamic-theme-dark');
    const colors = {};
    for (const key of ['--md-accent-color-rgb', '--md-accent-color', '--md-accent-color-secondary-rgb',
        '--md-accent-color-secondary', '--md-accent-color-bg-rgb', '--md-accent-color-bg',
        '--md-accent-color-bg-darken', '--md-accent-color-grey-base-rgb']) {
        colors[key] = style.getPropertyValue(key).trim();
    }
    const managed = readManagedFonts();
    return {
        dark: colors['--md-accent-color'] || colors['--md-accent-color-rgb'] ? dark : true,
        colors,
        font: managed?.font || style.fontFamily,
        fontFaces: managed?.fontFaces
    };
}

function send(packet) {
    if (socket?.readyState === WebSocket.OPEN && socket.bufferedAmount < 2 * 1024 * 1024) {
        socket.send(JSON.stringify(packet));
        return true;
    }
    return false;
}

const validVolume = value => Number.isFinite(value) && value >= 0 && value <= 1;
const volumeBars = '.prg-spk.j-vol .has';

function readVolume() {
    const gainMaster = window.__neteaseSongGain?.controller?.master;
    if (validVolume(gainMaster)) return gainMaster;
    const height = (activePlayer()?.querySelector(volumeBars) || document.querySelector(volumeBars))?.style.height;
    const visibleLevel = typeof height === 'string' && height.endsWith('%') ? parseFloat(height) / 100 : NaN;
    if (validVolume(visibleLevel)) return visibleLevel;
    try {
        const saved = JSON.parse(localStorage.getItem('NM_SETTING_PLAYER') || '{}').volume;
        if (validVolume(saved)) return saved;
    } catch {}
    return null;
}

function publishVolume(force = false) {
    const level = readVolume();
    if (validVolume(level) && (force || level !== lastVolume) && send({ type: 'volume', level })) lastVolume = level;
}

function setVolume(level) {
    if (!validVolume(level) || typeof window.channel?.call !== 'function') return;
    window.channel.call('audioplayer.setVolume', () => {}, ['', '', level]);
    for (const bar of document.querySelectorAll(volumeBars)) bar.style.height = (level * 100) + '%';
    activePlayer()?.querySelector('.spk')?.classList.toggle('z-silence', level === 0);
    if (send({ type: 'volume', level })) lastVolume = level;
}

function snapshot(force = false) {
    if (socket?.readyState !== WebSocket.OPEN) return;
    readSong();
    const entry = song && lyricsBySong.get(song.id);
    const theme = readTheme();
    const key = JSON.stringify([song, theme, entry?.revision, offset]);
    if ((force || key !== signature) &&
        send({ type: 'snapshot', song, theme, lyrics: entry?.value || emptyLyrics, offset, progress: clock })) signature = key;
}

function onState() {
    if (!enabled()) return;
    const now = Date.now();
    const seconds = clock.seconds + (clock.playing ? (now - clock.at) / 1000 : 0);
    clock = { ...clock, seconds, at: now, playing: isPlaying() };
    snapshot();
    send({ type: 'progress', progress: clock });
    setTimeout(() => { if (clock.playing !== isPlaying()) onState(); }, 100);
}

function onLoad(id, info) {
    if (!enabled()) return;
    readSong();
    nativeId = String(id);
    nativeDuration = Math.max(0, Number(info?.duration) || 0);
    clock = { seconds: 0, at: Date.now(), playing: isPlaying(), id: song?.id || nativeId, seek: clock.seek + 1 };
    snapshot(true);
    clearTimeout(metadataTimer);
    metadataTimer = setTimeout(() => snapshot(), 100);
    setTimeout(() => snapshot(), 750);
}

function onProgress(id, value) {
    if (!enabled()) return;
    nativeId = String(id);
    const now = Date.now();
    if (now - lastMetaRead > 1000) snapshot();
    const trackId = song?.id || nativeId;
    const seconds = Math.max(0, Number(value) || 0);
    const expected = clock.seconds + (clock.playing ? (now - clock.at) / 1000 : 0);
    // As in the OBS lyric bridge, forward each native progress event for karaoke timing.
    const seek = clock.id !== trackId || Math.abs(seconds - expected) > 0.6;
    clock = { seconds, at: now, playing: isPlaying(), id: trackId, seek: clock.seek + Number(seek) };
    send({ type: 'progress', progress: clock });
}

function onLyrics(value) {
    if (!Array.isArray(value?.lyrics) || value === lastSeenLyrics) return;
    // RefinedNowPlaying prefixes its lyric hash with the song ID.
    const tagged = typeof value.hash === 'string' && value.hash.match(/^(\d+)-/)?.[1];
    const id = tagged || currentSong()?.id || nativeId;
    if (!id) return;
    lastSeenLyrics = value;
    if (lyricsBySong.get(id)?.source === value) return;
    lyricsBySong.delete(id);
    lyricsBySong.set(id, {
        source: value,
        value: { lyrics: value.lyrics, unsynced: !!value.unsynced, amend: !!value.amend },
        revision: ++lyricRevision
    });
    if (lyricsBySong.size > 4) lyricsBySong.delete(lyricsBySong.keys().next().value);
    snapshot();
}

function playbackCommand(message) {
    if (message.action === 'sync') {
        snapshot(true);
        publishVolume(true);
        return;
    }
    if (message.action === 'volume') return setVolume(message.ratio);
    const current = activePlayer();
    const selector = playbackButtons.get(message.action);
    if (selector) current?.querySelector(selector)?.click();
    if (message.action !== 'seek' || !nativeId || !song?.duration || message.id !== clock.id ||
        !Number.isFinite(message.ratio) || message.ratio < 0 || message.ratio > 1) return;
    const seconds = Math.max(0.01, Math.min(song.duration - 0.01, song.duration * message.ratio));
    channel.call('audioplayer.seek', () => {}, [nativeId, nativeId + '|seek|' + Date.now(), seconds]);
}

async function openHost() {
    launchTime = Date.now();
    // BetterNCM parses the executable and joins the remaining arguments before launching it.
    const dataArgument = encodeURIComponent(windowsPath(folder));
    await betterncm.app.exec('"' + windowsPath(executable) + '" ' + dataArgument, false, true);
}

function schedule(delay = 1000) {
    clearTimeout(retry);
    if (enabled()) retry = setTimeout(connect, delay);
}

function requestWindow(action) {
    if (pendingWindowAction !== 'restore-interaction') pendingWindowAction = action;
    if (currentHost && send({ type: pendingWindowAction })) pendingWindowAction = null;
    else schedule(0);
}

async function connect() {
    if (!enabled() || socket || !folder || !player) return;
    let endpoint;
    try {
        endpoint = JSON.parse(await betterncm.fs.readFileText(join(folder, 'session.json')));
    } catch {}
    if (!enabled() || socket) return;
    if (!Number.isInteger(endpoint?.port) || endpoint.port < 1024 || endpoint.port > 65535 ||
        !/^[a-f\d]{64}$/i.test(endpoint.token)) {
        if (Date.now() - launchTime > 8000) {
            setStatus('正在启动桌面悬浮窗');
            openHost().catch(error => setStatus(String(error.message || error)));
        }
        return schedule();
    }
    const candidate = new WebSocket('ws://127.0.0.1:' + endpoint.port + '/player?token=' + endpoint.token);
    socket = candidate;
    let retiringHost = false;
    const connectionTimeout = setTimeout(() => candidate.close(), 2500);
    candidate.onopen = () => {
        clearTimeout(connectionTimeout);
        if (!enabled()) return candidate.close();
        if (endpoint.version !== __DESKTOP_FLOAT_VERSION__) {
            retiringHost = true;
            setStatus('正在更新桌面悬浮窗');
            send({ type: 'quit' });
            return;
        }
        currentHost = true;
        setStatus('桌面悬浮窗已连接');
        clock.playing = isPlaying();
        snapshot(true);
        publishVolume(true);
        if (pendingWindowAction) requestWindow(pendingWindowAction);
    };
    candidate.onmessage = event => {
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        if (!retiringHost && enabled() && message?.type === 'command') playbackCommand(message);
    };
    candidate.onerror = () => {};
    candidate.onclose = () => {
        clearTimeout(connectionTimeout);
        if (socket !== candidate) return;
        socket = null;
        currentHost = false;
        if (retiringHost) return schedule(600);
        if (!enabled()) return;
        setStatus('正在连接桌面悬浮窗');
        if (Date.now() - launchTime > 8000) {
            openHost().catch(error => setStatus(String(error.message || error)));
        }
        schedule();
    };
}

function setEnabled(value) {
    localStorage.setItem(enabledKey, String(value));
    if (value) {
        requestWindow('show');
        return;
    }
    pendingWindowAction = null;
    clearTimeout(retry);
    send({ type: 'quit' });
    socket?.close();
    setStatus('悬浮窗已关闭');
}

plugin.onLoad(async () => {
    try {
        const root = await betterncm.app.getDataPath();
        const raw = plugin.mainPlugin?.pluginPath || plugin.pluginPath;
        const source = /^(?:[a-z]:[\\/]|\\\\)/i.test(raw) ? raw : join(root, raw);
        folder = join(root, 'desktop-music-float');
        executable = join(source, 'desktop/' + __DESKTOP_HOST_FILE__);
        await betterncm.utils.waitForElement('#main-player');
        player = document.querySelector('#main-player');
        legacyNativeCmder.appendRegisterCall('Load', 'audioplayer', onLoad);
        legacyNativeCmder.appendRegisterCall('PlayProgress', 'audioplayer', onProgress);
        legacyNativeCmder.appendRegisterCall('PlayState', 'audioplayer', onState);
        document.addEventListener('lyrics-updated', event => onLyrics(event.detail));
        document.addEventListener('rnp-global-offset', event => {
            offset = Number(event.detail) || 0;
            snapshot();
        });
        onLyrics(window.currentLyrics);
        setInterval(() => {
            if (!enabled()) return;
            onLyrics(window.currentLyrics);
            if (clock.playing !== isPlaying()) onState();
            snapshot();
            publishVolume();
            send({ type: 'heartbeat' });
        }, 1200);
        window.addEventListener('pagehide', () => {
            clearTimeout(retry);
            clearTimeout(metadataTimer);
            if (socket) {
                socket.onclose = null;
                send({ type: 'quit' });
                socket.close();
            }
        });
        if (enabled()) connect();
        else setStatus('悬浮窗已关闭');
    } catch (error) {
        setStatus(String(error.message || error));
    }
});

plugin.onConfig(() => {
    for (const listener of statusViews) if (!listener.node.isConnected) statusViews.delete(listener);
    const root = document.createElement('section');
    const label = document.createElement('label');
    const check = document.createElement('input');
    const show = document.createElement('button');
    const restore = document.createElement('button');
    const output = document.createElement('p');
    const hint = document.createElement('p');
    check.type = 'checkbox';
    check.checked = enabled();
    check.onchange = () => { setEnabled(check.checked); show.disabled = restore.disabled = !check.checked; };
    label.append(check, ' 启用桌面悬浮窗　');
    show.textContent = '显示悬浮窗';
    restore.textContent = '恢复鼠标操作';
    show.disabled = restore.disabled = !check.checked;
    show.onclick = () => requestWindow('show');
    restore.onclick = () => requestWindow('restore-interaction');
    const listener = value => { output.textContent = value; };
    listener.node = root;
    statusViews.add(listener);
    listener(status);
    hint.textContent = '开启穿透后，可按 Ctrl+Alt+Shift+P、点击上方「恢复鼠标操作」，或在 Windows 托盘关闭穿透。';
    root.append(label, show, ' ', restore, output, hint);
    return root;
});
