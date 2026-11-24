import { Lyrics } from '../lyrics/lyrics.js';
import { applySharedTheme } from '../lyrics/shared-theme.js';
import { installLyricMorph } from '../lyrics/lyric-morph.js';
import { createContentTransition } from './content-transition.js';
import { createRhythmAnimator } from './dynamic-rhythm.js';
import { createOverflowMarquee } from './overflow-marquee.js';
import { applyManagedFontFaces } from './managed-fonts.js';

const $ = id => document.getElementById(id);
const post = packet => window.chrome?.webview?.postMessage(packet);
const card = $('card');
const rail = $('timeline');
const heading = card.querySelector('.song-heading');
const artwork = card.querySelector('.art-frame');
const controls = $('playback-controls').content.cloneNode(true);
rail.append(controls.querySelector('#controls'));
$('track').append(controls.querySelector('#seek'));
rail.tabIndex = 0;
rail.setAttribute('role', 'group');
rail.setAttribute('aria-label', '播放和窗口控件');
card.hidden = false;
card.classList.add('is-visible');
const rhythm = createRhythmAnimator(rail.querySelector('.rhythm path'));
const marquee = createOverflowMarquee([$('title'), $('artist')]);
const seek = $('seek');
const volumeControl = $('volume-control');
const volumeTrigger = $('volume-trigger');
const volumePanel = $('volume-panel');
const volumeSlider = $('volume');
const bar = $('bar-root');
const lyricSlot = $('lyrics-slot');
const playerSurfaces = [artwork, heading, rail, $('track')];
const player = document.querySelector('#main-player .btnp');
const playButtons = [...document.querySelectorAll('[data-play]')];
const listeners = { PlayState: new Set(), PlayProgress: new Set() };
const emit = (type, ...args) => { for (const listener of listeners[type]) listener(...args); };
const emptyLyrics = { lyrics: [] };

let song, mounted = false, activeLyrics = '', lastCover = '', coverGeneration = 0;
let progress = { seconds: 0, at: Date.now(), playing: false, id: '0', seek: 0 };
let previousId, previousPlaying, previousSeek, previousOffset;
let options = {}, hovered = false, keyboardControls = false, scrubbing = false;
let scrubId, lastProgressAtSeek = 0;
let volumeHovered = false, volumeDragging = false, volumeTimer, pendingVolume;
let surfaceFrame, lastSurface = '';

window.__lyricBarObsViewer = true;
window.legacyNativeCmder = {
    appendRegisterCall(name, scope, callback) { listeners[name]?.add(callback); },
    removeRegisterCall(name, scope, callback) { listeners[name]?.delete(callback); }
};
window.channel = { call() {} };
const refreshLyricFonts = installLyricMorph();

const transition = createContentTransition({
    element: $('card'),
    visible: () => !!song && !document.hidden,
    apply: renderSnapshot,
    enterClass: 'track-entering'
});

function setText(id, value) {
    const node = $(id).querySelector('.marquee-text') || $(id);
    if (node.textContent !== value) node.textContent = value;
}

function formatTime(seconds) {
    const whole = Math.max(0, Math.floor(seconds));
    return String(Math.floor(whole / 60)).padStart(2, '0') + ':' + String(whole % 60).padStart(2, '0');
}

function setCover(value) {
    if (lastCover === value) return;
    lastCover = value;
    const generation = ++coverGeneration;
    const cover = $('cover');
    cover.hidden = true;
    cover.removeAttribute('src');
    $('placeholder').hidden = false;
    card.classList.remove('has-art');
    scheduleSurface();
    let url;
    try { url = new URL(value); } catch { return; }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return;
    url.protocol = 'https:';
    const image = new Image();
    image.onload = () => {
        if (coverGeneration !== generation) return;
        cover.src = image.src;
        cover.hidden = false;
        $('placeholder').hidden = true;
        card.classList.add('has-art');
        scheduleSurface();
    };
    image.src = url.href;
}

function renderLyrics(value, offset) {
    const next = Array.isArray(value?.lyrics) ? value : emptyLyrics;
    const serialized = JSON.stringify(next);
    if (serialized !== activeLyrics) {
        activeLyrics = serialized;
        window.currentLyrics = next;
        if (mounted) document.dispatchEvent(new CustomEvent('lyrics-updated', { detail: next }));
    }
    if (previousOffset !== offset) {
        previousOffset = offset;
        localStorage.setItem('lyric-bar-lyric-offset', String(offset));
        document.dispatchEvent(new CustomEvent('rnp-global-offset', { detail: offset }));
    }
    document.body.classList.toggle('mq-playing', !song || next.lyrics.length < 2 || !!next.unsynced);
    if (!mounted) {
        const root = ReactDOM.createRoot($('bar-inner'));
        ReactDOM.flushSync(() => root.render(React.createElement(Lyrics)));
        mounted = true;
    }
    updateLyricLayout();
}

function updateLyricLayout() {
    const height = parseInt(bar.style.getPropertyValue('--obs-measured-height'), 10) || 0;
    lyricSlot.toggleAttribute('data-collapsed', !height || document.body.classList.contains('mq-playing') || bar.classList.contains('no-lyrics'));
    scheduleSurface();
}

function scheduleSurface() {
    if (surfaceFrame !== undefined) return;
    surfaceFrame = requestAnimationFrame(() => {
        surfaceFrame = undefined;
        const elements = [...playerSurfaces];
        if (!lyricSlot.hasAttribute('data-collapsed')) elements.push(bar);
        if (!volumePanel.hidden) elements.push(volumePanel);
        const rects = elements.map(element => {
            const { x, y, width, height } = element.getBoundingClientRect();
            const radius = parseFloat(getComputedStyle(element).borderTopLeftRadius) || 0;
            return [x, y, width, height, radius];
        });
        const packet = { type: 'surface', rects, glow: card.classList.contains('has-art')
            ? window.__obsMaterialTheme?.primary || [198, 191, 255] : null };
        const serialized = JSON.stringify(packet);
        if (serialized !== lastSurface) {
            lastSurface = serialized;
            post(packet);
        }
    });
}

new MutationObserver(updateLyricLayout).observe(bar, { attributes: true, attributeFilter: ['style', 'class'] });
const surfaceObserver = new ResizeObserver(scheduleSurface);
for (const element of [...playerSurfaces, bar]) surfaceObserver.observe(element);

function renderSnapshot(data) {
    song = data.song;
    const nextProgress = data.progress || progress;
    if (nextProgress.id !== progress.id) {
        scrubbing = false;
        lastProgressAtSeek = 0;
    }
    progress = nextProgress;
    if (data.theme) {
        const facesChanged = applyManagedFontFaces(data.theme.fontFaces);
        applySharedTheme(data.theme);
        if (facesChanged) refreshLyricFonts?.();
    }
    setText('title', song?.title || '等待网易云播放');
    setText('artist', song?.artist || (song ? '未知歌手' : '在网易云音乐中选择歌曲'));
    heading.title = [song?.title, song?.artist, '拖动悬浮窗'].filter(Boolean).join('\n');
    setCover(song?.cover || '');
    marquee.refresh();
    renderLyrics(song ? data.lyrics : emptyLyrics, Number(data.offset) || 0);
    renderProgress(true);
}

function updateRhythm() {
    const controls = !options.through && !document.hidden && (hovered || keyboardControls || volumeDragging);
    rail.classList.toggle('controls-visible', controls);
    const openVolume = controls && (volumeHovered || volumeDragging ||
        (keyboardControls && volumeControl.contains(document.activeElement)));
    if (volumePanel.hidden === openVolume) {
        volumePanel.hidden = !openVolume;
        volumeTrigger.setAttribute('aria-expanded', String(openVolume));
        scheduleSurface();
    }
    const playing = !!song && !!progress.playing && !document.hidden;
    rhythm.setRunning(playing && !controls);
    marquee.setRunning(playing && !transition.pending);
}

function showVolume(value) {
    const percent = Math.round(value * 100);
    volumeSlider.value = percent;
    volumeSlider.setAttribute('aria-valuetext', percent + '%');
    $('volume-percent').textContent = percent + '%';
}

function changeVolume(percent) {
    const bounded = Math.max(0, Math.min(100, percent));
    pendingVolume = bounded / 100;
    showVolume(pendingVolume);
    if (volumeTimer === undefined) volumeTimer = setTimeout(sendVolume, 60);
}

function sendVolume() {
    clearTimeout(volumeTimer);
    volumeTimer = undefined;
    if (pendingVolume === undefined) return;
    post({ type: 'playback', action: 'volume', level: pendingVolume });
    pendingVolume = undefined;
}

function renderProgress(force = false) {
    const playing = !!song && !!progress.playing;
    player.classList.toggle('btnp-pause', playing);
    if (force || previousPlaying !== playing || previousId !== progress.id) {
        emit('PlayState', progress.id, playing ? 'resume' : 'pause');
        previousPlaying = playing;
        previousId = progress.id;
        const toggle = $('play');
        toggle.title = playing ? '暂停' : '播放';
        toggle.setAttribute('aria-label', toggle.title);
        toggle.querySelector('path').setAttribute('d', playing ? 'M9 6v12M15 6v12' : 'M9 5l11 7-11 7z');
        for (const button of playButtons) button.disabled = !song;
    }
    if (previousSeek !== progress.seek) {
        previousSeek = progress.seek;
        window.channel.call('audioplayer.seek', () => {}, [progress.id, 'desktop', progress.seconds]);
    }
    emit('PlayProgress', progress.id, progress.seconds);
    seek.disabled = !song?.duration;
    updateRhythm();
    updateTime();
}

function updateTime() {
    if (document.hidden) return;
    const duration = Number(song?.duration) || 0;
    const elapsed = song ? Math.min(duration || Infinity, Math.max(0,
        progress.seconds + (progress.playing ? Math.max(0, Date.now() - progress.at) / 1000 : 0))) : 0;
    const ratio = duration ? elapsed / duration : 0;
    if (!scrubbing && Date.now() >= lastProgressAtSeek) seek.value = Math.round(ratio * Number(seek.max));
    const at = scrubbing && duration ? Number(seek.value) / Number(seek.max) * duration : elapsed;
    setText('elapsed', formatTime(at));
    setText('duration', formatTime(duration));
    const fill = 'scaleX(' + Number(seek.value) / Number(seek.max) + ')';
    if ($('fill').style.transform !== fill) $('fill').style.transform = fill;
    seek.setAttribute('aria-valuetext', formatTime(at) + ' / ' + formatTime(duration));
}

function updatePointerHover(target) {
    const node = target instanceof Node ? target : null;
    const overRail = rail.contains(node);
    const overVolume = volumeControl.contains(node);
    if (hovered === overRail && volumeHovered === overVolume) return;
    hovered = overRail;
    volumeHovered = overVolume;
    updateRhythm();
}

// A move can arrive without a new enter when the pointer quickly crosses the window edge.
document.addEventListener('pointermove', event => updatePointerHover(event.target));
rail.addEventListener('pointerenter', event => updatePointerHover(event.target));
rail.addEventListener('pointerleave', () => updatePointerHover(null));
rail.addEventListener('focusin', event => {
    keyboardControls = event.target.matches(':focus-visible');
    updateRhythm();
});
rail.addEventListener('focusout', event => {
    if (rail.contains(event.relatedTarget)) return;
    keyboardControls = false;
    updateRhythm();
});
for (const button of playButtons) button.onclick = () => post({ type: 'playback', action: button.dataset.play });
for (const button of document.querySelectorAll('[data-option]')) {
    button.onclick = () => post({ type: 'option', action: button.dataset.option });
}
for (const drag of [artwork, heading]) {
    drag.addEventListener('pointerdown', event => { if (event.button === 0) post({ type: 'drag' }); });
}
seek.addEventListener('pointerdown', () => { scrubbing = true; scrubId = progress.id; });
seek.addEventListener('input', () => {
    if (!scrubbing) scrubId = progress.id;
    scrubbing = true;
    updateTime();
});
seek.addEventListener('change', () => {
    const id = scrubbing ? scrubId : progress.id;
    scrubbing = false;
    if (id !== progress.id) return updateTime();
    lastProgressAtSeek = Date.now() + 550;
    post({ type: 'playback', action: 'seek', id, ratio: Number(seek.value) / Number(seek.max) });
});
volumeControl.addEventListener('pointerenter', event => updatePointerHover(event.target));
volumeControl.addEventListener('pointerleave', event => updatePointerHover(event.relatedTarget));
volumeControl.addEventListener('wheel', event => {
    if (volumeSlider.disabled || !event.deltaY) return;
    event.preventDefault();
    changeVolume(Number(volumeSlider.value) - Math.sign(event.deltaY) * 5);
}, { passive: false });
volumeTrigger.addEventListener('click', () => volumeSlider.focus());
volumeSlider.addEventListener('pointerdown', () => { volumeDragging = true; });
volumeSlider.addEventListener('input', () => changeVolume(Number(volumeSlider.value)));
volumeSlider.addEventListener('change', sendVolume);
function finishVolumeDrag() {
    if (!volumeDragging) return;
    volumeDragging = false;
    sendVolume();
    updateRhythm();
}
window.addEventListener('pointercancel', () => { scrubbing = false; finishVolumeDrag(); });
window.addEventListener('pointerup', () => {
    finishVolumeDrag();
    setTimeout(() => { scrubbing = false; }, 0);
});

window.chrome?.webview?.addEventListener('message', event => {
    const data = event.data;
    switch (data.type) {
        case 'options':
            options = data;
            document.body.classList.toggle('lyrics-below', !!data.lyricsBelow);
            document.body.classList.toggle('lyrics-left', !!data.lyricsLeft);
            scheduleSurface();
            if (options.through) {
                hovered = keyboardControls = volumeHovered = volumeDragging = false;
                document.activeElement?.blur();
            }
            for (const button of document.querySelectorAll('[data-option]')) {
                button.setAttribute('aria-pressed', String(!!options[button.dataset.option]));
                if (button.dataset.option === 'through') {
                    button.title = options.restoreShortcut
                        ? '点击穿透 · 按 ' + options.restoreShortcut + ' 恢复'
                        : '点击穿透 · 可在网易云插件设置中恢复';
                    button.setAttribute('aria-label', button.title);
                }
            }
            updateRhythm();
            break;
        case 'pointer-exit':
            hovered = volumeHovered = keyboardControls = scrubbing = false;
            if (volumeDragging) finishVolumeDrag();
            else updateRhythm();
            break;
        case 'pointer-return':
            updatePointerHover(document.elementFromPoint(data.x, data.y));
            break;
        case 'snapshot':
            transition.swap(data.song?.id || '', data);
            break;
        case 'progress':
            if (!data.progress) break;
            transition.updatePending(value => value.progress?.id === data.progress.id
                ? { ...value, progress: data.progress } : value);
            if (!transition.pending && data.progress.id === progress.id) {
                progress = data.progress;
                renderProgress();
            }
            break;
        case 'volume':
            if (Number.isFinite(data.level) && data.level >= 0 && data.level <= 1) {
                volumeSlider.disabled = false;
                if (!volumeDragging && pendingVolume === undefined) showVolume(data.level);
            }
            break;
        case 'disconnected':
            volumeSlider.disabled = true;
            clearTimeout(volumeTimer);
            volumeTimer = pendingVolume = undefined;
            volumeDragging = false;
            $('volume-percent').textContent = '–';
            transition.swap('', { song: null, lyrics: emptyLyrics,
                progress: { seconds: 0, at: Date.now(), playing: false, id: '0', seek: 0 } });
            transition.flush();
            break;
    }
});

document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        transition.flush();
        hovered = keyboardControls = volumeHovered = volumeDragging = false;
    } else {
        renderProgress(true);
    }
    updateRhythm();
});
setInterval(updateTime, 250);
for (const button of playButtons) button.disabled = true;
setText('title', '等待网易云播放');
setText('artist', '在网易云音乐中选择歌曲');
marquee.refresh();
post({ type: 'ready' });
