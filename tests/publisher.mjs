import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

test('BetterNCM publisher keeps lyrics with the correct song across out-of-order events', async () => {
    const track = id => ({ id, name: 'Track ' + id, duration: 220000 });
    const lyrics = (id, name) => ({
        hash: id + '-test-hash',
        lyrics: [{ time: 0, originalLyric: name }, { time: 10000, originalLyric: name + ' 2' }]
    });
    let playing = track('101');
    let playingClass = false;
    let loadPlugin, socket;
    const callbacks = new Map();
    const documentEvents = new Map();
    const packets = [];
    const nativeCalls = [];
    let tick;
    let nextTimer = 0;
    const timers = new Map();
    const player = { querySelector: () => null };
    const gain = { master: 0.4 };
    const managedFamily = '"NCMFM-zh", Arial, sans-serif';
    const fontRule = source => ({
        family: 'NCMFM-zh', source, weight: '400', style: 'normal', unicodeRange: 'U+4E00-9FFF', display: 'swap'
    });
    const makeManagedStyle = name => {
        const source = 'local("' + name + '")';
        const properties = {
            'font-family': 'NCMFM-zh', src: source, 'font-weight': '400', 'font-style': 'normal',
            'unicode-range': 'U+4E00-9FFF', 'font-display': 'swap'
        };
        return {
            textContent: source,
            sheet: { cssRules: [
                { type: 5, style: { getPropertyValue: name => properties[name] || '' } },
                { type: 1, selectorText: 'body', style: { fontFamily: managedFamily } }
            ] }
        };
    };
    let managerStyle = makeManagedStyle('Microsoft YaHei UI');
    const browser = {
        currentLyrics: lyrics('101', 'first'),
        __neteaseSongGain: { controller: gain },
        channel: { call(name, callback, args) { nativeCalls.push([name, args[2]]); gain.master = args[2]; } },
        addEventListener() {}
    };
    const { version } = JSON.parse(await readFile('dist/package/manifest.json', 'utf8'));
    class MockSocket {
        static OPEN = 1;
        constructor() { socket = this; }
        send(packet) { packets.push(JSON.parse(packet)); }
    }
    const context = {
        plugin: { pluginPath: './plugins_runtime/DesktopMusicFloat',
            onLoad(callback) { loadPlugin = callback; }, onConfig() {} },
        betterncm: {
            app: { getDataPath: async () => 'C:\\betterncm' },
            fs: { readFileText: async () => JSON.stringify({ port: 4567, token: 'a'.repeat(64), version }) },
            utils: { waitForElement: async () => player },
            ncm: { getPlaying: () => playing }
        },
        legacyNativeCmder: { appendRegisterCall(name, scope, callback) { callbacks.set(name, callback); } },
        document: {
            body: { classList: { contains: () => false } },
            querySelector: selector => selector === '.m-player:not(.f-dn) .btnp'
                ? { classList: { contains: name => name === 'btnp-pause' && playingClass } } : player,
            querySelectorAll: () => [],
            getElementById: id => id === 'ncm-font-manager-fontfaces' ? managerStyle : null,
            addEventListener(name, callback) { documentEvents.set(name, callback); }
        },
        window: browser,
        WebSocket: MockSocket,
        CSSRule: { FONT_FACE_RULE: 5 },
        getComputedStyle: () => ({ fontFamily: 'Arial, sans-serif', getPropertyValue: () => '' }),
        localStorage: { getItem: () => null },
        setInterval(callback) { tick = callback; },
        setTimeout(callback, delay) { timers.set(++nextTimer, { callback, delay }); return nextTimer; },
        clearTimeout(id) { timers.delete(id); }
    };
    vm.runInNewContext(await readFile('dist/package/main.js', 'utf8'), context);
    await loadPlugin();
    await Promise.resolve();
    socket.readyState = MockSocket.OPEN;
    socket.bufferedAmount = 0;
    socket.onopen();
    assert.equal(packets.find(packet => packet.type === 'volume')?.level, 0.4);
    const adjustVolume = ratio => socket.onmessage({ data: JSON.stringify({ type: 'command', action: 'volume', ratio }) });
    adjustVolume(0.62);
    adjustVolume(1.3);
    assert.deepEqual(nativeCalls, [['audioplayer.setVolume', 0.62]]);
    gain.master = 0.35;
    tick();
    assert.equal(packets.filter(packet => packet.type === 'volume').at(-1).level, 0.35);
    callbacks.get('PlayProgress')('101', 15);
    const snapshots = () => packets.filter(packet => packet.type === 'snapshot');
    const settleMetadata = () => {
        for (const [id, timer] of [...timers]) {
            if (timer.delay !== 100) continue;
            timers.delete(id);
            timer.callback();
        }
    };
    const updateLyrics = value => {
        browser.currentLyrics = value;
        documentEvents.get('lyrics-updated')({ detail: value });
    };
    assert.equal(snapshots().at(-1).lyrics.lyrics[0].originalLyric, 'first');
    assert.equal(snapshots().at(-1).theme.font, managedFamily);
    assert.deepEqual(snapshots().at(-1).theme.fontFaces, [fontRule('local("Microsoft YaHei UI")')]);
    managerStyle = makeManagedStyle('SimSun');
    tick();
    assert.equal(snapshots().at(-1).theme.font, managedFamily);
    assert.deepEqual(snapshots().at(-1).theme.fontFaces, [fontRule('local("SimSun")')]);
    managerStyle = null;
    tick();
    assert.equal(snapshots().at(-1).theme.font, 'Arial, sans-serif');
    assert.equal(snapshots().at(-1).theme.fontFaces, undefined);

    updateLyrics(lyrics('202', 'early'));
    callbacks.get('Load')('202', { duration: 220 });
    assert.equal(snapshots().at(-1).song.id, '101', 'Old metadata should stay on screen until the new song is ready');
    playing = track('202');
    settleMetadata();
    assert.equal(snapshots().at(-1).song.id, '202');
    assert.equal(snapshots().at(-1).lyrics.lyrics[0].originalLyric, 'early');

    playingClass = true;
    callbacks.get('PlayState')();
    assert.equal(packets.at(-1).progress.playing, true);
    callbacks.get('PlayProgress')('audio-engine-202', 19);
    assert.equal(packets.at(-1).progress.seconds, 19);
    assert.equal(packets.at(-1).progress.id, '202', 'Native progress must follow the song reported by metadata');
    callbacks.get('PlayState')();
    playingClass = false;
    settleMetadata();
    assert.equal(packets.at(-1).progress.playing, false, 'The delayed native button update must be observed');

    callbacks.get('Load')('303', { duration: 220 });
    playing = track('303');
    settleMetadata();
    assert.equal(snapshots().at(-1).song.id, '303');
    assert.deepEqual(snapshots().at(-1).lyrics.lyrics, []);
    const count = snapshots().length;
    updateLyrics(lyrics('202', 'stale'));
    assert.equal(snapshots().length, count, 'The preceding song cannot replace the current lyrics');
    updateLyrics(lyrics('303', 'late'));
    assert.equal(snapshots().at(-1).lyrics.lyrics[0].originalLyric, 'late');
    assert.ok(snapshots().every(packet => packet.song?.id === packet.progress.id));
});
