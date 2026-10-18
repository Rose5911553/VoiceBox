// 语音盒 VoiceBox
// 独立生成一次 TTS 语音，与剧情无关。语音存在浏览器本地（IndexedDB），可反复播放、收藏、导出、删除。
// 走酒馆内置的 MiniMax TTS（同一个后端接口），所以你改过的后端规则同样生效。

import { getRequestHeaders, saveSettingsDebounced } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';

const NAME = 'VoiceBox';
const DB_NAME = 'VoiceBoxDB';
const STORE = 'clips';
const MANUAL = '__manual__';

/* ---------------- 设置 ---------------- */

function vbSettings() {
    if (!extension_settings[NAME]) extension_settings[NAME] = { lastVoice: '' };
    return extension_settings[NAME];
}

/* ---------------- 本地存储（IndexedDB） ---------------- */

let dbPromise = null;
function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE)) {
                db.createObjectStore(STORE, { keyPath: 'id' });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
    return dbPromise;
}
function reqP(r) {
    return new Promise((res, rej) => {
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
    });
}
async function os(mode) {
    const db = await openDb();
    return db.transaction(STORE, mode).objectStore(STORE);
}
const dbAll = async () => reqP((await os('readonly')).getAll());
const dbGet = async (id) => reqP((await os('readonly')).get(id));
const dbPut = async (rec) => reqP((await os('readwrite')).put(rec));
const dbDel = async (id) => reqP((await os('readwrite')).delete(id));

/* ---------------- MiniMax TTS ---------------- */

function miniMaxSettings() {
    const tts = extension_settings.tts || {};
    const key = Object.keys(tts).find(k => k.toLowerCase() === 'minimax');
    return key ? tts[key] : {};
}

let provider = null;
let providerTried = false;
async function getProvider() {
    if (providerTried) return provider;
    providerTried = true;
    try {
        const mod = await import('../../tts/minimax.js');
        provider = new mod.MiniMaxTtsProvider();
    } catch (e) {
        console.warn('[VoiceBox] 无法加载内置 MiniMax 模块，改用直连后端接口', e);
        provider = null;
    }
    return provider;
}

function flatDefaults(p) {
    return Object.fromEntries(
        Object.entries(p.defaultSettings || {}).map(([k, v]) =>
            (v && typeof v === 'object' && !Array.isArray(v) && 'default' in v) ? [k, v.default] : [k, v]),
    );
}

// 备用：直接请求酒馆后端（和内置 MiniMax 用同一个接口）
async function directFetch(text, voiceId) {
    const s = miniMaxSettings();
    const body = {
        text,
        voiceId,
        apiHost: s.apiHost || 'https://api.minimax.io',
        model: s.model || 'speech-02-hd',
        speed: Number(s.speed) || 1,
        volume: Number(s.volume) || 1,
        pitch: Math.round(Number(s.pitch)) || 0,
        audioSampleRate: Number(s.audioSampleRate) || 32000,
        bitrate: Number(s.bitrate) || 128000,
        format: s.format || 'mp3',
        language: null,
    };
    return fetch('/api/minimax/generate-voice', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(body),
    });
}

async function synthesize(text, voiceId) {
    const p = await getProvider();
    let response;
    if (p) {
        // 只借用它的生成逻辑，不绑定任何界面，不改动 TTS 面板
        p.settings = { ...flatDefaults(p), ...miniMaxSettings() };
        if (!Array.isArray(p.settings.customVoices)) p.settings.customVoices = [];
        if (!Array.isArray(p.settings.customModels)) p.settings.customModels = [];
        p.availableVoices = [];
        response = await p.generateTts(text, voiceId);
    } else {
        response = await directFetch(text, voiceId);
    }
    if (!response || !response.ok) {
        let msg = response ? `HTTP ${response.status}` : '无响应';
        try { msg = (await response.text()) || msg; } catch { /* ignore */ }
        throw new Error(msg);
    }
    const buf = await response.arrayBuffer();
    let mime = (response.headers.get('content-type') || '').split(';')[0].trim();
    if (mime.includes('json') || mime.startsWith('text')) {
        throw new Error(new TextDecoder().decode(buf).slice(0, 200));
    }
    if (!mime.startsWith('audio')) mime = mimeFor(miniMaxSettings().format || 'mp3');
    if (!buf.byteLength) throw new Error('返回的音频是空的');
    return { buf, mime };
}

function mimeFor(fmt) {
    return { mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', aac: 'audio/aac' }[fmt] || 'audio/mpeg';
}
function extFor(mime) {
    if (mime.includes('wav')) return 'wav';
    if (mime.includes('flac')) return 'flac';
    if (mime.includes('aac')) return 'aac';
    return 'mp3';
}

async function getVoices() {
    const s = miniMaxSettings();
    const list = [];
    const add = (name, id) => {
        if (!id || list.some(v => v.id === id)) return;
        list.push({ name: name || id, id });
    };
    (s.customVoices || []).forEach(v => add(v.name, v.voice_id));
    const p = await getProvider();
    (p?.constructor?.defaultVoices || []).forEach(v => add(v.name, v.voice_id));
    if (s.customVoiceId) add(`自定义：${s.customVoiceId}`, s.customVoiceId.trim());
    return list;
}

/* ---------------- 播放 ---------------- */

const audio = new Audio();
let playingId = null;
let currentUrl = null;

function stopAudio() {
    audio.pause();
    if (currentUrl) URL.revokeObjectURL(currentUrl);
    currentUrl = null;
    playingId = null;
    refreshPlayIcons();
}
audio.addEventListener('ended', stopAudio);

async function togglePlay(id) {
    if (playingId === id && !audio.paused) {
        stopAudio();
        return;
    }
    const rec = await dbGet(id);
    if (!rec) return;
    stopAudio();
    currentUrl = URL.createObjectURL(new Blob([rec.audio], { type: rec.mime }));
    audio.src = currentUrl;
    playingId = id;
    refreshPlayIcons();
    try {
        await audio.play();
    } catch (e) {
        toastr.error(`播放失败：${e.message}`);
        stopAudio();
    }
}

function refreshPlayIcons() {
    $('#vb_list .vb-item').each(function () {
        const on = $(this).data('id') === playingId;
        $(this).toggleClass('vb-playing', on);
        $(this).find('.vb-play')
            .toggleClass('fa-play', !on)
            .toggleClass('fa-pause', on);
    });
}

function getDuration(blob) {
    return new Promise((resolve) => {
        const a = new Audio();
        const url = URL.createObjectURL(blob);
        const done = (d) => { URL.revokeObjectURL(url); resolve(d); };
        const t = setTimeout(() => done(0), 4000);
        a.addEventListener('loadedmetadata', () => {
            clearTimeout(t);
            done(Number.isFinite(a.duration) ? a.duration : 0);
        });
        a.addEventListener('error', () => { clearTimeout(t); done(0); });
        a.preload = 'metadata';
        a.src = url;
    });
}

/* ---------------- 导出 ---------------- */

function pad(n) { return String(n).padStart(2, '0'); }
function stamp(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
function safeName(s) {
    return String(s).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 16);
}

async function exportClip(id) {
    const rec = await dbGet(id);
    if (!rec) return;
    const blob = new Blob([rec.audio], { type: rec.mime });
    const name = `语音盒_${safeName(rec.voiceName)}_${stamp(rec.createdAt)}_${safeName(rec.text)}.${extFor(rec.mime)}`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
}

/* ---------------- 界面 ---------------- */

let currentTab = 'all';

function esc(s) {
    const d = document.createElement('div');
    d.textContent = s ?? '';
    return d.innerHTML;
}
function fmtTime(ts) {
    const d = new Date(ts);
    return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fmtDur(sec) {
    if (!sec) return '';
    const s = Math.round(sec);
    return `${Math.floor(s / 60)}:${pad(s % 60)}`;
}

function panelHtml() {
    return `
<div id="vb_overlay" class="vb-hidden">
  <div id="vb_panel">
    <div class="vb-head">
      <span class="vb-title"><i class="fa-solid fa-microphone-lines"></i> 语音盒</span>
      <div id="vb_close" class="vb-icon-btn fa-solid fa-xmark" title="关闭"></div>
    </div>
    <div class="vb-compose">
      <textarea id="vb_text" class="text_pole" rows="3" placeholder="输入想听的话…"></textarea>
      <div class="vb-row">
        <select id="vb_voice" class="text_pole"></select>
        <div id="vb_gen" class="menu_button vb-gen">生成</div>
      </div>
      <input id="vb_voice_manual" class="text_pole vb-hidden" placeholder="输入 MiniMax Voice ID">
      <div class="vb-hint">语速、音量、音调、模型沿用 TTS 面板里的 MiniMax 设置</div>
    </div>
    <div class="vb-tabs">
      <div class="vb-tab active" data-tab="all">全部</div>
      <div class="vb-tab" data-tab="fav">收藏</div>
      <span id="vb_count"></span>
    </div>
    <div id="vb_list"></div>
  </div>
</div>`;
}

async function fillVoices() {
    const sel = $('#vb_voice');
    const voices = await getVoices();
    const last = vbSettings().lastVoice;
    sel.empty();
    voices.forEach(v => sel.append($('<option></option>').val(v.id).text(v.name)));
    sel.append($('<option></option>').val(MANUAL).text('手动输入 Voice ID…'));
    if (last && voices.some(v => v.id === last)) {
        sel.val(last);
    } else if (last) {
        sel.val(MANUAL);
        $('#vb_voice_manual').val(last);
    }
    $('#vb_voice_manual').toggleClass('vb-hidden', sel.val() !== MANUAL);
}

function selectedVoice() {
    const v = $('#vb_voice').val();
    if (v === MANUAL) {
        const id = String($('#vb_voice_manual').val() || '').trim();
        return { id, name: id };
    }
    return { id: v, name: $('#vb_voice option:selected').text() };
}

async function renderList() {
    const all = (await dbAll()).sort((a, b) => b.createdAt - a.createdAt);
    const favCount = all.filter(r => r.favorite).length;
    const rows = currentTab === 'fav' ? all.filter(r => r.favorite) : all;
    $('#vb_count').text(currentTab === 'fav' ? `${favCount} 条` : `${all.length} 条 · 收藏 ${favCount}`);

    const list = $('#vb_list').empty();
    if (!rows.length) {
        list.append(`<div class="vb-empty">${currentTab === 'fav' ? '还没有收藏的语音' : '还没有语音，写一句试试'}</div>`);
        return;
    }
    rows.forEach(r => {
        list.append(`
<div class="vb-item" data-id="${esc(r.id)}">
  <div class="vb-item-text">${esc(r.text)}</div>
  <div class="vb-item-foot">
    <span class="vb-item-meta">${esc(r.voiceName)} · ${fmtTime(r.createdAt)}${r.duration ? ' · ' + fmtDur(r.duration) : ''}</span>
    <div class="vb-item-actions">
      <div class="vb-icon-btn vb-play fa-solid fa-play" title="播放"></div>
      <div class="vb-icon-btn vb-fav ${r.favorite ? 'fa-solid vb-on' : 'fa-regular'} fa-star" title="收藏"></div>
      <div class="vb-icon-btn vb-export fa-solid fa-download" title="导出"></div>
      <div class="vb-icon-btn vb-del fa-solid fa-trash-can" title="删除"></div>
    </div>
  </div>
</div>`);
    });
    refreshPlayIcons();
}

let generating = false;
async function onGenerate() {
    if (generating) return;
    const text = String($('#vb_text').val() || '').trim();
    const voice = selectedVoice();
    if (!text) { toastr.warning('先写点什么吧'); return; }
    if (!voice.id) { toastr.warning('请选择或输入一个 Voice ID'); return; }

    generating = true;
    const btn = $('#vb_gen').addClass('vb-busy').html('<i class="fa-solid fa-spinner fa-spin"></i>');
    try {
        const { buf, mime } = await synthesize(text, voice.id);
        const duration = await getDuration(new Blob([buf], { type: mime }));
        const rec = {
            id: `vb_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            text,
            voiceId: voice.id,
            voiceName: voice.name,
            createdAt: Date.now(),
            favorite: false,
            mime,
            duration,
            audio: buf,
        };
        await dbPut(rec);
        vbSettings().lastVoice = voice.id;
        saveSettingsDebounced();
        $('#vb_text').val('');
        if (currentTab === 'fav') setTab('all');
        await renderList();
        togglePlay(rec.id);
    } catch (e) {
        console.error('[VoiceBox] 生成失败', e);
        toastr.error(String(e.message || e).slice(0, 200), '语音生成失败');
    } finally {
        generating = false;
        btn.removeClass('vb-busy').text('生成');
    }
}

function setTab(tab) {
    currentTab = tab;
    $('.vb-tab').removeClass('active');
    $(`.vb-tab[data-tab="${tab}"]`).addClass('active');
}

async function openPanel() {
    $('#vb_overlay').removeClass('vb-hidden');
    await fillVoices();
    await renderList();
}
function closePanel() {
    $('#vb_overlay').addClass('vb-hidden');
    stopAudio();
}

function bindEvents() {
    $('#vb_close').on('click', closePanel);
    $('#vb_overlay').on('click', (e) => { if (e.target.id === 'vb_overlay') closePanel(); });
    $(document).on('keydown', (e) => {
        if (e.key === 'Escape' && !$('#vb_overlay').hasClass('vb-hidden')) closePanel();
    });

    $('#vb_gen').on('click', onGenerate);
    $('#vb_voice').on('change', () => {
        $('#vb_voice_manual').toggleClass('vb-hidden', $('#vb_voice').val() !== MANUAL);
    });
    $('.vb-tab').on('click', async function () {
        setTab($(this).data('tab'));
        await renderList();
    });

    const list = $('#vb_list');
    const idOf = (el) => $(el).closest('.vb-item').data('id');

    list.on('click', '.vb-play', function () { togglePlay(idOf(this)); });
    list.on('click', '.vb-export', function () { exportClip(idOf(this)); });
    list.on('click', '.vb-item-text', function () { $(this).toggleClass('vb-expanded'); });

    list.on('click', '.vb-fav', async function () {
        const rec = await dbGet(idOf(this));
        if (!rec) return;
        rec.favorite = !rec.favorite;
        await dbPut(rec);
        await renderList();
    });

    list.on('click', '.vb-del', async function () {
        const id = idOf(this);
        const rec = await dbGet(id);
        if (!rec) return;
        const msg = rec.favorite ? '这条已收藏，确定删除吗？删除后无法恢复。' : '删除这条语音？删除后无法恢复。';
        if (!confirm(msg)) return;
        if (playingId === id) stopAudio();
        await dbDel(id);
        await renderList();
    });
}

function addMenuButton() {
    const item = $(`
<div id="vb_wand_btn" class="list-group-item flex-container flexGap5 interactable" tabindex="0">
  <div class="fa-solid fa-microphone-lines extensionsMenuExtensionButton"></div>
  <span>语音盒</span>
</div>`);
    item.on('click', openPanel);
    $('#extensionsMenu').append(item);
}

jQuery(async () => {
    vbSettings();
    $('body').append(panelHtml());
    bindEvents();
    addMenuButton();
    try { await openDb(); } catch (e) { console.error('[VoiceBox] IndexedDB 打开失败', e); }
    console.log('[VoiceBox] loaded');
});
