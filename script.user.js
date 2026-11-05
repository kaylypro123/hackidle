// ==UserScript==
// @name         Auto Complete
// @namespace    vlmod
// @version      6.1
// @description  Auto Hoài Niệm + Ns Mod + Auto Dã Tẩu ẩn popup, giữ tương tác Rương/Nhân vật/Kỹ năng + cập nhật GitHub All-in-One
// @match        *://hoainiem2003.net/*
// @match        *://*/*vltk*
// @match        https://volamidle.pages.dev/*
// @match        https://hoaniemi2003.net/vltk/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.xmlHttpRequest
// @connect      raw.githubusercontent.com
// @connect      github.com
// @connect      githubusercontent.com
// @connect      api.github.com
// @connect      cdn.jsdelivr.net
// ==/UserScript==
(function () {
    'use strict';
    if (window.__VLM && window.__VLM.v >= 8.41) return;

    /* ===== 0. DUY TRÌ CHẠY NỀN KHI ẨN TAB / THU NHỎ =====
       Best effort: Worker phát nhịp nền chậm hơn để giảm tải; callback game vẫn chạy trên luồng chính.
       Khi tab hoạt động trở lại, scheduler tự chuyển về requestAnimationFrame gốc.
       Không thể chống việc Chrome/Windows đóng băng tab hoặc đưa máy vào Sleep.
    */
    const VLTK_BG_TICK_MS = 100;
    const VLTK_BG_STALL_MS = 600;
    const VLTK_SKIP_DRAW_WHEN_HIDDEN = true;

    // Lấy getter gốc TRƯỚC khi giả lập document.hidden/visibilityState.
    function vltkFindNativeGetter(prop) {
        let proto = Document.prototype;
        while (proto) {
            try {
                const desc = Object.getOwnPropertyDescriptor(proto, prop);
                if (desc && typeof desc.get === 'function') return desc.get;
            } catch (e) { }
            proto = Object.getPrototypeOf(proto);
        }
        return null;
    }

    const vltkRealHiddenGet = vltkFindNativeGetter('hidden');
    const vltkRealVisibilityGet = vltkFindNativeGetter('visibilityState');
    const vltkRealWebkitHiddenGet = vltkFindNativeGetter('webkitHidden');

    function vltkReallyHidden() {
        try {
            if (vltkRealHiddenGet) return !!vltkRealHiddenGet.call(document);
        } catch (e) { }
        try {
            if (vltkRealVisibilityGet) return vltkRealVisibilityGet.call(document) === 'hidden';
        } catch (e) { }
        try {
            if (vltkRealWebkitHiddenGet) return !!vltkRealWebkitHiddenGet.call(document);
        } catch (e) { }
        return false;
    }

    function vltkReallyUnfocused() {
        try {
            return typeof document.hasFocus === 'function' && !document.hasFocus();
        } catch (e) {
            return false;
        }
    }

    function vltkActuallyBackground() {
        return vltkReallyHidden() || vltkReallyUnfocused();
    }

    // Game vẫn thấy tab đang hiển thị như cơ chế chống pause của bản cũ.
    function vltkFakeDocumentProperty(prop, value) {
        try {
            Object.defineProperty(document, prop, {
                configurable: true,
                get: function () { return value; }
            });
        } catch (e) { }
    }
    vltkFakeDocumentProperty('hidden', false);
    vltkFakeDocumentProperty('visibilityState', 'visible');
    vltkFakeDocumentProperty('webkitHidden', false);
    vltkFakeDocumentProperty('webkitVisibilityState', 'visible');

    const vltkNativeRAF = window.requestAnimationFrame.bind(window);
    const vltkNativeCAF = typeof window.cancelAnimationFrame === 'function'
        ? window.cancelAnimationFrame.bind(window)
        : function () { };

    let vltkBackgroundMode = false;
    let vltkNativeRafPending = false;
    let vltkNativeRafId = 0;
    let vltkNativeRafToken = 0;
    let vltkNativeRequestAt = 0;
    let vltkProbePending = false;
    let vltkProbeId = 0;
    let vltkProbeToken = 0;
    let vltkWorker = null;
    let vltkFallbackTimer = null;
    let vltkRafNextId = 1;
    let vltkLastFrameTime = performance.now();
    let vltkVirtualTime = vltkLastFrameTime;
    const vltkRafQueue = new Map();

    // Speed gốc mặc định luôn TẮT sau mỗi lần nạp script; chỉ chạy khi người dùng bật.
    // Nút ON/OFF trong tab Speed vẫn cho phép bật/tắt thủ công trong phiên hiện tại.
    window.vltkSpeedEnabled = false;
    try { localStorage.setItem('__vltkSpeedEnabled', '0'); } catch (e) { }
    window.vltkSelectedSpeed = 1;

    function vltkFlushRaf(now) {
        if (!vltkRafQueue.size) return;

        const frameNow = (typeof now === 'number' && isFinite(now))
            ? now : performance.now();
        const dt = Math.max(0, frameNow - vltkLastFrameTime);
        vltkLastFrameTime = frameNow;

        const currentSpeed = window.vltkSpeedEnabled
            ? (Number(window.vltkSelectedSpeed) || 1)
            : 1;
        vltkVirtualTime += dt * currentSpeed;

        // Snapshot giữ đúng quy tắc: RAF được đăng ký trong callback chạy ở frame kế tiếp.
        const frameIds = Array.from(vltkRafQueue.keys());
        for (const id of frameIds) {
            // Cho phép callback trước hủy callback sau trong cùng một frame.
            if (!vltkRafQueue.has(id)) continue;
            const callback = vltkRafQueue.get(id);
            vltkRafQueue.delete(id);
            try {
                callback(vltkVirtualTime);
            } catch (err) {
                setTimeout(function () { throw err; }, 0);
            }
        }
    }

    function vltkScheduleNativeRaf() {
        if (vltkBackgroundMode || vltkNativeRafPending || !vltkRafQueue.size) return;

        vltkNativeRafPending = true;
        vltkNativeRequestAt = performance.now();
        const token = ++vltkNativeRafToken;

        vltkNativeRafId = vltkNativeRAF(function (timestamp) {
            if (token !== vltkNativeRafToken) return;
            vltkNativeRafPending = false;
            if (vltkActuallyBackground()) {
                vltkSetBackgroundMode(true);
                return;
            }

            if (vltkBackgroundMode) vltkSetBackgroundMode(false);
            vltkFlushRaf(timestamp);
            vltkScheduleNativeRaf();
        });
    }

    function vltkScheduleProbe() {
        if (vltkProbePending || vltkActuallyBackground()) return;
        vltkProbePending = true;
        const token = ++vltkProbeToken;
        vltkProbeId = vltkNativeRAF(function () {
            if (token !== vltkProbeToken) return;
            vltkProbePending = false;
            if (!vltkActuallyBackground()) {
                vltkSetBackgroundMode(false);
            }
        });
    }

    function vltkSetBackgroundMode(isBackground) {
        const next = !!isBackground;
        if (vltkBackgroundMode === next) return;
        vltkBackgroundMode = next;

        if (vltkBackgroundMode) {
            // Hủy frame/probe gốc đang chờ để không chạy trùng với nhịp Worker.
            if (vltkNativeRafPending) {
                ++vltkNativeRafToken;
                try { vltkNativeCAF(vltkNativeRafId); } catch (e) { }
                vltkNativeRafPending = false;
            }
            if (vltkProbePending) {
                ++vltkProbeToken;
                try { vltkNativeCAF(vltkProbeId); } catch (e) { }
                vltkProbePending = false;
            }
        } else {
            if (vltkProbePending) {
                ++vltkProbeToken;
                try { vltkNativeCAF(vltkProbeId); } catch (e) { }
                vltkProbePending = false;
            }
            vltkScheduleNativeRaf();
        }
    }

    // Worker phát nhịp 100ms khi ở nền để giảm tải. Nếu CSP chặn Blob Worker, dùng timer dự phòng.
    function vltkStartFallbackTimer() {
        if (vltkFallbackTimer !== null) return;
        vltkFallbackTimer = setInterval(vltkPump, VLTK_BG_TICK_MS);
    }

    function vltkPump() {
        const now = performance.now();
        const actuallyBg = vltkActuallyBackground();

        if (actuallyBg) {
            vltkSetBackgroundMode(true);
        } else if (!vltkBackgroundMode && vltkNativeRafPending &&
                   now - vltkNativeRequestAt >= VLTK_BG_STALL_MS) {
            // RAF không trả callback dù đang có frame chờ: chuyển tạm sang Worker.
            vltkSetBackgroundMode(true);
        }

        if (vltkBackgroundMode) {
            if (vltkRafQueue.size) vltkFlushRaf(now);
            // Nếu chỉ bị stall tạm thời (không thật sự ẩn/mất focus), thăm dò RAF gốc.
            if (!actuallyBg) vltkScheduleProbe();
        } else {
            vltkScheduleNativeRaf();
        }
    }

    try {
        const workerSource = 'setInterval(function(){ postMessage(0); },' + VLTK_BG_TICK_MS + ');';
        const workerBlob = new Blob([workerSource], { type: 'application/javascript' });
        const workerUrl = URL.createObjectURL(workerBlob);
        vltkWorker = new Worker(workerUrl);
        vltkWorker.onmessage = vltkPump;
        vltkWorker.onerror = function () {
            try { vltkWorker.terminate(); } catch (e) { }
            vltkWorker = null;
            vltkStartFallbackTimer();
        };
    } catch (e) {
        vltkWorker = null;
        vltkStartFallbackTimer();
    }

    // Khởi tạo theo trạng thái thật; focus/blur và visibility sẽ cập nhật tiếp.
    vltkBackgroundMode = vltkActuallyBackground();
    if (vltkBackgroundMode && vltkRafQueue.size) vltkPump();

    function vltkOnVisibility(e) {
        vltkSetBackgroundMode(vltkActuallyBackground());
        try { e.stopImmediatePropagation(); } catch (err) { }
    }
    window.addEventListener('visibilitychange', vltkOnVisibility, true);
    document.addEventListener('visibilitychange', vltkOnVisibility, true);
    window.addEventListener('webkitvisibilitychange', vltkOnVisibility, true);
    document.addEventListener('webkitvisibilitychange', vltkOnVisibility, true);

    window.addEventListener('blur', function (e) {
        vltkSetBackgroundMode(true);
        try { e.stopImmediatePropagation(); } catch (err) { }
    }, true);
    window.addEventListener('focus', function () {
        if (!vltkReallyHidden()) vltkSetBackgroundMode(false);
    }, true);

    // Giữ màn hình không tự ngủ khi trình duyệt/thiết bị cho phép.
    let wakeLock = null;
    async function requestWakeLock() {
        try {
            if ('wakeLock' in navigator && !vltkBackgroundMode) {
                wakeLock = await navigator.wakeLock.request('screen');
            }
        } catch (err) { }
    }
    requestWakeLock();
    window.addEventListener('focus', requestWakeLock, true);

    // API RAF thống nhất cho game và các module Auto.
    window.requestAnimationFrame = function (callback) {
        if (typeof callback !== 'function') return 0;
        const id = vltkRafNextId++;
        vltkRafQueue.set(id, callback);
        if (vltkBackgroundMode) {
            // Worker sẽ gọi vltkPump; không dùng RAF gốc khi đã xác định ở nền.
        } else {
            vltkScheduleNativeRaf();
        }
        return id;
    };

    window.cancelAnimationFrame = function (id) {
        vltkRafQueue.delete(id);
    };

    // Tránh vẽ Canvas khi game thực sự ở nền; logic callback vẫn tiếp tục.
    if (VLTK_SKIP_DRAW_WHEN_HIDDEN && window.CanvasRenderingContext2D) {
        const canvasProto = CanvasRenderingContext2D.prototype;
        const drawMethods = [
            'drawImage', 'fillText', 'strokeText', 'fill', 'stroke',
            'fillRect', 'strokeRect'
        ];
        drawMethods.forEach(function (name) {
            try {
                const original = canvasProto[name];
                if (typeof original !== 'function' || original.__vltkBgWrapped) return;
                const wrapped = function () {
                    if (vltkActuallyBackground()) return;
                    return original.apply(this, arguments);
                };
                wrapped.__vltkBgWrapped = true;
                canvasProto[name] = wrapped;
            } catch (e) { }
        });
    }

    window.__vltkChayNen = {
        version: '3.9',
        tickMs: VLTK_BG_TICK_MS,
        stallMs: VLTK_BG_STALL_MS,
        get background() { return vltkBackgroundMode; },
        get pendingFrames() { return vltkRafQueue.size; },
        get workerActive() { return !!vltkWorker; }
    };

    console.log('%c[VLTK] Duy trì chạy nền đã bật (best effort)', 'color:#9fe36a');

    function triggerFullClick(el) {
        if (!el) return false;
        ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(evt => {
            try { el.dispatchEvent(new MouseEvent(evt, { view: window, bubbles: true, cancelable: true })); } catch (e) { }
        });
        if (typeof el.click === 'function') el.click();
        return true;
    }

    function clickByText(text, exact = false) {
        const allNodes = document.querySelectorAll('button, div, span, a, p, td');
        for (let el of allNodes) {
            if (el.innerText) {
                const inner = el.innerText.trim();
                if (exact ? inner === text : inner.includes(text)) {
                    triggerFullClick(el);
                    return true;
                }
            }
        }
        return false;
    }

    /* ===== CẤU HÌNH ===== */
    const KEY = 'vlm8_cfg';
    const DEF = {
        cv: 87, patch: true, wide: false, tab: 'act', min: false, pos: null,
        autoEquip: false, eqSec: 5,
        lockSlots: { weapon: false, armor: false, helm: false, belt: false, boot: false, cuff: false, amulet: false, ring1: false, ring2: false, pendant: false },
        setAutoOn: true, setThreshold: 3, setIntervalSec: 30, setCooldown: 60, setDryRun: false,
        setScanMode: 'full', setMixPairs: 20, setMixFilterPct: 50,
        bagOn: true, free: 8, bagSec: 3, gameSell: true, toFb: true, keepRar: 4, lvlAhead: 20, sellOff: true, sellRare: false, sellLocked: false, sellVio: true, keepEnh: 5,
        fbOn: true, fbSec: 10, fbRun: true, fbExt: true, fbWhiteKeep: 10, fbJew: 6, fbMax: 100,
        rebirthOn: false, rebirthDelay: 5,
        hpPotOn: true, hpPotPct: 75, mpPotOn: true, mpPotPct: 50,
        potOn: false, potStrict: true, potStr: 0, potDex: 0, potVit: 0, potEng: 0, potRem: 'dt', potSec: 5,
        gameSpeed: 1.0, autoEvent: false, washLockRar: 4,
        actEnabled: true, actMode: 'push',
        t2End: 't1',
        twAi: true, twRange: 240, twPad: 30, twStep: 80, twMoveCost: 6, twMargin: 3, twFlee: 50,
        twLoot: true, twCtrR: 30, twKite: true, twArena: 500, twPull: 0.45,
        twMarginPx: 20, twSweetSpot: 30, twMaxFar: 320, twMaxStall: 85,
        twCrowdR: 300, twCrowdMax: 3, twThreatMax: 3,
        twReHp: 90, rangedPrio: true, meleeTelePrio: true, teleDetect: true,
        lootRadius: 1000, lootTimeoutMs: 5000, itemTimeoutMs: 3000, lootCooldownMs: 3000, lootFailMax: 3, lootDisableMs: 10000
    };
    let C = Object.assign({}, DEF);
    try { Object.assign(C, JSON.parse(localStorage.getItem(KEY) || '{}')) } catch (e) { }
    if (!(C.cv >= 87)) {
        C.patch = true;
        C.sellVio = true;
        C.twCtrR = 0;
        C.twArena = 1500;
        C.twRgR = 400;
        if (C.actMode === 'off' || !C.actMode) C.actMode = 'push';
        if (!C.lockSlots || typeof C.lockSlots !== 'object') C.lockSlots = { weapon: false, armor: false, helm: false, belt: false, boot: false, cuff: false, amulet: false, ring1: false, ring2: false, pendant: false };
        if (!C.setScanMode) C.setScanMode = 'full';
        if (C.setMixPairs == null) C.setMixPairs = 20;
        if (C.setMixFilterPct == null) C.setMixFilterPct = 50;
        C.cv = 87;
    }
    if (!(C.cv >= 88)) {
        if (C.twRgR === 400) C.twRgR = 240;
        if (C.twMaxNear === 300) C.twMaxNear = 180;
        if (C.twMaxFar === 370) C.twMaxFar = 320;
        if (C.twFlee === 35) C.twFlee = 50;
        if (C.twArena === 1500) C.twArena = 500;
        if (C.twStep === 100) C.twStep = 80;
        if (C.twMargin === 4) C.twMargin = 3;
        if (C.twReHp === 80) C.twReHp = 90;
        if (C.rangedPrio == null) C.rangedPrio = true;
        C.cv = 88;
    }
    if (!(C.cv >= 89)) {
        if (C.twCtrR === 0) C.twCtrR = 30;
        if (C.lootRadius == null) C.lootRadius = 150;
        if (C.lootTimeoutMs == null) C.lootTimeoutMs = 1500;
        if (C.itemTimeoutMs == null) C.itemTimeoutMs = 500;
        C.cv = 89;
    }
    if (!(C.cv >= 90)) {
        if (C.lootCooldownMs == null) C.lootCooldownMs = 3000;
        if (C.lootFailMax == null) C.lootFailMax = 3;
        if (C.lootDisableMs == null) C.lootDisableMs = 10000;
        C.cv = 90;
    }
    if (!(C.cv >= 91)) {
        if (C.meleeTelePrio == null) C.meleeTelePrio = true;
        if (C.teleDetect == null) C.teleDetect = true;
        C.cv = 91;
    }
    if (!(C.cv >= 92)) {
        C.meleeTelePrio = false;
        if (C.teleDetect == null) C.teleDetect = true;
        C.cv = 92;
    }
    if (!(C.cv >= 93)) {
        if (C.lootRadius === 150) C.lootRadius = 1000;
        if (C.lootTimeoutMs === 1500) C.lootTimeoutMs = 5000;
        if (C.itemTimeoutMs === 500) C.itemTimeoutMs = 3000;
        C.cv = 93;
    }
    if (!(C.cv >= 94)) {
        if (C.twMarginPx == null) C.twMarginPx = 20;
        if (C.twSweetSpot == null) C.twSweetSpot = 30;
        if (C.twRgR != null) delete C.twRgR;
        if (C.twMaxNear != null) delete C.twMaxNear;
        C.cv = 94;
    }
    if (!(C.cv >= 95)) {
        if (C.twCrowdR == null) C.twCrowdR = 300;
        if (C.twCrowdMax == null) C.twCrowdMax = 3;
        if (C.twThreatMax == null) C.twThreatMax = 3;
        C.cv = 95;
    }
    if (C.actMode !== 'push' && C.actMode !== 't1' && C.actMode !== 't2') C.actMode = 'push';
    if (C.t2End !== 't1' && C.t2End !== 'push') C.t2End = 't1';
    if (C.tab === 'nsmod') C.tab = 'act';
    const save = () => { try { localStorage.setItem(KEY, JSON.stringify(C)) } catch (e) { } };
    C.autoEquip = false;
    C.sellLocked = false;
    save();

    const M = window.__VLM = { v: 8.41, ran: 0, start: 0, res: [], N: {}, chk: {}, how: '', file: '', why: {} };
    const S = {
        eq: 0, sold: 0, gold: 0, toFb: 0, ext: 0, fbSold: 0, fbGold: 0, short: 0, err: '',
        rebirthCnt: 0, rebirthErr: '', rebirthLast: 0, pendingRebirth: 0,
        twInfo: null, twWas: 0, twFloor: 0, twDie1: 0, twDie2: 0, twEnter: 0, twLast: 0, twMsg: '', twErr: '', pushTriggered: false, exitAt: 0, exitFail: 0, lastEff: '', needWash: false, lastWash: 0, lastSetScan: 0, lastSetSwap: 0, setLog: '', setHistory: [], showSetHistory: false, lastPushCheck: 0, startTime: Date.now(),
        sellByRarity: { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 }, gameSellCount: 0, gameSellGold: 0, scriptSellCount: 0, scriptSellGold: 0, bagTickRuns: 0, lastBagTick: 0, fbRunCount: 0, lastFbTick: 0, events: [], pushLootLastOk: 0, pushLootLastN: 0, pushLootLastT: 0, twLootLastOk: 0, twLootLastN: 0, twLootLastT: 0, twLootPhaseLast: 0, guildMsg: '', guildBusy: false, guildUid: 0, guildUidSrc: '', guildLastAt: 0
    };
    const pushEvent = (type, msg) => { try { S.events.unshift({ t: Date.now(), type: type, msg: msg }); if (S.events.length > 30) S.events.length = 30 } catch (e) { } };

    const R = (s, f) => new RegExp(s.replace(/@/g, () => '([\\w$]+)'), f || '');
    window.__vlAE = function (origFn) {
        return true;
    };

    /* ===== 1. BẢN VÁ ===== */
    const PATCH = [
        ['Điều khiển tự mặc', '@=\\(\\)=>!\\(!@\\.autoEquip\\|\\|@\\(\\)\\|\\|@\\.facHold>Date\\.now\\(\\)\\)',
            m => m[0].replace('||' + m[3] + '()||', () => '||(window.__vlAE?window.__vlAE(' + m[3] + '):' + m[3] + '())||')]
    ];

    /* ===== 2. DÒ TÊN HÀM ===== */
    const NA = [
        [['xr', 'ws'], 'function @\\(\\)\\{const @=@\\.rw\\|\\|\\(\\3\\.rw=\\{\\}\\)', [1, 3]],
        [['ws', 'Y'], '\\$\\{@\\.inv\\.length\\}\\/\\$\\{@\\(\\)\\}\\x3c\\/span>', [1, 2]],
        [['Y'], '@\\.inv\\.length<@\\(\\)\\?"":"disabled"', [2]],
        [['Fn', 'Wn'], '@=(\\d+),@=\\(\\)=>@\\.fbox\\|\\|\\(\\4\\.fbox=\\[\\]\\)', [1, 3]],
        [['Wn'], '@=\\(\\)=>@\\.fbox\\|\\|\\(\\2\\.fbox=\\[\\]\\)', [1]],
        [['Ao', 'Rs', 'Ko'], '@=!0,@\\(\\),@\\("Đã sắp xếp hành trang', [1, 2, 3]],
        [['wi'], '"#ivBest"\\)\\.onclick=\\(\\)=>\\{[\\s\\S]*?const @=@\\.power,@=@\\(\\);@\\(\\)', [2]],
        [['lc'], 'const @=@\\(\\);@\\(\\x60Bán \\$\\{\\1\\.n\\} món', [2]],
        [['Hn'], '@+=@\\(@\\),@\\.splice\\(\\4\\.indexOf\\(\\3\\),1\\)', [2]],
        [['Hn'], '\\.gold\\+=@\\(@\\)', [1]],
        [['Ue', 'Ze'], 'for\\(const @ of @\\.filter\\(@\\)\\)\\{const @=@\\(\\1\\);if\\(!\\4\\.ok\\)', [3, 5]],
        [['Ru'], 'function @\\(\\)\\{if\\(!@\\|\\|!\\2\\.fac\\|\\|!\\2\\.autoForge\\)return null', [1]],
        [['Ee'], 'filter\\(@=>@\\.includes\\(\\1\\.d\\)&&\\1\\.r>0\\)', [2]],
        [['H'], '@\\.setFac&&@>=0&&@\\[@\\.fac\\]&&\\2!==\\3\\[\\4\\.fac\\]\\.id', [3]],
        [['Zn', 'nn'], '\\(@\\(@\\[@\\]\\)&&!@\\(\\2\\[\\3\\]\\)\\?\'\\x3cu class="ivup"', [1, 4]],
        [['An'], 'function @\\(@\\)\\{const @=@\\[\\2\\.d\\];return"ring"===\\3\\?', [1]],
        [['An'], 'Object\\.assign\\(\\{\\},@\\.eq\\);@\\[@\\(@\\)\\]=\\4;', [3]],
        [['Xt', 'sn'], 'const @=@\\(@\\.eq\\),@=@;let @;\\5=@\\?@:null;try\\{\\6=\\2\\(@\\)\\}finally\\{\\5=\\4\\}const @=@\\(\\1\\)', [2, 11]],
        [['on'], '"Nếu đủ điều kiện, so với đang mặc",@=@\\?\\[\\]:@\\(@\\)', [3]],
        [['qt'], 'function @\\(@=@\\(\\)\\)\\{const @=@\\[\\2\\];let @=0;for', [1]]
    ];
    const NEED = ['ws', 'wi', 'xr', 'Y', 'Wn', 'Fn', 'Rs', 'Ao', 'Ko', 'lc', 'Hn', 'Ue', 'Ze', 'Ru', 'Ee', 'H', 'Zn', 'nn', 'Xt', 'sn', 'on', 'An', 'qt', 'ph', 'uh', 'pos', 'it', 'nt', 'ch', 'towerExit', 'stK', 'yhK', 'pick', 'ai', 'cast', 't2Go', 't2Used', 't2Max', 't2Rb'];

    function findNames(G) {
        const N = {};
        for (const a of NA) { const m = R(a[1]).exec(G); if (m) a[0].forEach((k, i) => { if (!N[k]) N[k] = m[a[2][i]] }) }
        if (!N.wi && /\bCi\s*=\s*\{corpses/.test(G)) N.wi = 'Ci'; else if (!N.wi && /\bMi\s*=\s*\{corpses/.test(G)) N.wi = 'Mi';
        const m = R('function @\\(\\)\\{const @=@\\(\\),@=@\\(\\2\\.stat\\.reborn\\);if\\(@\\.lvl<\\4\\)').exec(G);
        if (m) {
            N.ph = m[1]; N.uh = m[5];
            const sub = G.slice(m.index, m.index + 1500);
            const a = R('if\\(@<Date\\.now\\(\\)\\)return \\1=Date\\.now\\(\\)').exec(sub); if (a) N.mh = a[1];
            const b = R('\\.zoneShown=null,@\\(\\);').exec(sub); if (b) N.my = b[1];
        }
        if (!N.uh) { const u = R('@=@=>100\\+20\\*\\2').exec(G); if (u) N.uh = u[1] }
        findQCFns(G, N);
        findN2(G, N);
        if (!N.wi) N.wi = 'Ci';
        return N;
    }
    function findQCFns(G, N) {
        const chp = /\{floor:Math\.max\(1,/.exec(G);
        if (chp) { const before = G.slice(0, chp.index); const fns = [...before.matchAll(/function\s+([\w$]+)\s*\([^)]*\)\s*\{/g)]; if (fns.length) N.ch = fns[fns.length - 1][1]; }
        for (const h of G.matchAll(/function\s+([\w$]+)\s*\([^)]*\)\s*\{/g)) {
            const st = h.index; let d = 0, j = st;
            while (j < G.length) { if (G[j] === '{') d++; else if (G[j] === '}') { d--; if (!d) break } j++ }
            const bd = G.slice(st, j + 1);
            if (/\.tower=null/.test(bd) && !/stat\.reborn/.test(bd) && !/\.dg=null/.test(bd)) { N.towerExit = h[1]; break }
        }
        const m2 = /if\(([\w$]+)\(\)>=([\w$]+)\)return void [\w$]+\(`Hôm nay đã vào Tháp II/.exec(G);
        if (m2) { N.t2Used = m2[1]; N.t2Max = m2[2]; const f = enclFn(G, m2.index); if (f) N.t2Go = f.n; }
        const m3 = /if\(([\w$]+)\(\)<([\w$]+)\)return void [\w$]+\(`Cần chuyển sinh \$\{\2\}`\)/.exec(G);
        if (m3) { N.t2Rbf = m3[1]; N.t2Rb = m3[2]; }
    }
    const ref = n => n ? '(typeof ' + n + '!==\"undefined\"?' + n + ':null)' : 'null';
    function fnEnd(G, at) { let d = 0; for (let j = at; j < G.length; j++) { const c = G[j]; if (c === '{') d++; else if (c === '}') { d--; if (!d) return j } } return G.length }
    function enclFn(G, i, back) {
        const b0 = Math.max(0, i - (back || 30000)), s = G.slice(b0, i), re = /function ([\w$]+)\(([^)]*)\)\{/g, c = []; let m;
        while ((m = re.exec(s))) c.push({ n: m[1], p: m[2].split(',').map(x => x.trim()), at: b0 + m.index + m[0].length - 1 });
        for (let k = c.length - 1; k >= 0; k--) { let d = 0, ok = true; for (let j = c[k].at; j < i; j++) { const ch = G[j]; if (ch === '{') d++; else if (ch === '}') { d--; if (!d) { ok = false; break } } } if (ok) return c[k] }
        return null
    }
    function findN2(G, N) {
        try {
            let m = /\[([\w$]+)\.x,\1\.y\]=([\w$]+)\(([\w$]+)\.w\/2,\3\.h\/2\)/.exec(G); if (m) { N.pos = m[1]; N.it = m[2]; N.nt = m[3] }
            if (!N.pos) N.pos = 'Bi';
            if (!N.it) N.it = 'it';
            if (!N.nt) N.nt = 'nt';
            N.pick = (function () { const r = /function ([\w$]+)\(([\w$]+),[\w$]+\)\{const [\w$]+=[\w$]+\.ground\.indexOf\(\2\)/.exec(G); return r ? r[1] : null })();
            N.stK = (function () { const r = /Ci\.stall>45\*Math\.max\(1,\.75\*([\w$]+)\)/.exec(G); return r ? r[1] : null })();
            N.yhK = (function () { const r = /\(([\w$]+)\.farT=\(\1\.farT\|\|0\)\+[\w$]+\)<([\w$]+)/.exec(G); return r ? r[2] : null })();
            for (const re of [/Ci\.moveTo=(?!null)[\w$.]+,Ci\.meleeTg=null,\.05/g, /Ci\.moveTo=(?!null)[\w$.]+,Ci\.meleeTg=null/g]) {
                let mm; while (!N.ai && (mm = re.exec(G))) {
                    const f = enclFn(G, mm.index); if (!f) continue; const body = G.slice(f.at, fnEnd(G, f.at));
                    if (body.split('meleeTg').length > 3 && body.includes('.enemies') && G.split(f.n + '(').length > 2) N.ai = f.n
                }
                if (N.ai) break
            }
            {
                const i = G.indexOf('Ci.meleeTg=null;return Ci.moveTo=null,');
                if (i >= 0) {
                    if (!N.ai) { const f = enclFn(G, i, 60000); if (f) N.ai = f.n }
                    const c = /^Ci\.meleeTg=null;return Ci\.moveTo=null,([\w$]+)\(/.exec(G.slice(i, i + 80)); if (c) N.cast = c[1]
                }
            }
        } catch (e) { N.n2err = e.message }
    }

    /* --- Lõi tháp (dùng chung T1/T2) --- */
    function twCore() {
        const N = M.N || {}; return `(function(){
var T=window.__vlTW=window.__vlTW||{};if(T.ready&&T.v===95)return 1;T.v=95;T.dbg={txt:"-"};T.ign=new WeakSet();T.bad=[];T.kt=null;
T.vnTarget=null;T.lootFailStreak=0;T.lootCooldownUntil=0;T.lootDisabledUntil=0;
var POS=function(){return ${ref(N.pos)}},ST=function(){return ${ref(N.ws)}||{}},NT=function(){return ${ref(N.nt)}};
var IT=${ref(N.it)},PICK=${ref(N.pick)};
${N.cast ? `if(!window.__vlCastHk){try{var oc=${N.cast};if(typeof oc==="function"){var wc=function(t){try{if(t&&!t.around&&+t.rad>0)window.__vlTW.rad=+t.rad}catch(e){}return oc.apply(this,arguments)};${N.cast}=wc;window.__vlCastHk=${N.cast}===wc}}catch(e){T.castErr=e.message}}` : ''}
T.hp=function(){var mx=+(Ci.P&&Ci.P.life)||0;return mx>0?Math.max(0,Math.min(100,Ci.life/mx*100)):100};
T.ctr=function(){var n=NT();if(!n||!n.w)return null;var c=[n.w/2,n.h/2];try{if(IT)c=IT(n.w/2,n.h/2)}catch(e){}return{x:Math.round(c[0]),y:Math.round(c[1])}};
T.info=function(){var L=ST(),r={tower:!!Ci.tower,two:!!(Ci.tower&&Ci.tower.two),floor:Ci.tower?Ci.tower.floor:0,dead:Ci.deadT>0,dg:!!Ci.dg,town:!!Ci.town,hp:T.hp(),cd1:0,best1:0,t2Left:null,t2Need:null,rb:0};
 ${N.xr ? `try{var g=${N.xr}().stat;r.best1=+g.towerBest||0;r.rb=+g.reborn||0}catch(e){}` : ''}
 ${N.tWait ? `try{var w=${N.tWait}-(Date.now()-(+L.towerOut||0));r.cd1=w>0&&w<=${N.tWait}?w:0}catch(e){}` : ''}
 ${N.t2Max && N.t2Used ? `try{r.t2Left=+(${N.t2Max}-${N.t2Used}())}catch(e){}` : ''}
 ${N.t2Rb ? `try{r.t2Need=+${N.t2Rb}}catch(e){}` : ''}
 return r};
T.enter2=function(){
 if(Ci.tower||Ci.dg||Ci.deadT>0)return "busy";
 ${N.t2Go ? `try{${N.t2Go}()}catch(e){return "lỗi "+e.message}` : `var b=document.getElementById("t2Go");if(b&&!b.disabled){b.click()}else return "nobtn"`}
 return Ci.tower?"ok":"game từ chối"};
T.stLim=function(){var k=1;${N.stK ? `try{k=+${N.stK}||1}catch(e){}` : ''}return 45*Math.max(1,.75*k)};
T.yh=function(){var v=2;${N.yhK ? `try{v=+${N.yhK}||2}catch(e){}` : ''}return v};
T.fmax=function(){var m=0;(Ci.enemies||[]).forEach(function(e){if(e&&!e.dead&&e.hp>0&&(+e.farT||0)>m)m=+e.farT||0});return m};
T.tInfo=function(){return "dịch chuyển "+T.fmax().toFixed(1)+"/"+T.yh()+"s · giờ "+Math.round(+Ci.stall||0)+"/"+Math.round(T.stLim())+"s · tốc "+(T.spd?Math.round(T.spd):"?")+" · tầm "+(T.rad||"?")};
T.kiteMax=function(p,L,c,now){T.kNote="";
 var rad=T.rad||(+c.twRange>0?+c.twRange:400),hp=T.hp(),flee=hp<(+c.twFlee||35);
 var __mPx=+c.twMarginPx||0,__ss=+c.twSweetSpot||30;
 var A=T.anc||T.ctr()||{x:p.x,y:p.y},R=Math.max(150,+c.twArena||1500);
 var nR=Math.max(80,45+__mPx+__ss),rgR=Math.max(200,204+__mPx+__ss);
 var fR=Math.max(nR+20,Math.min(rad-15,+c.twMaxFar||370));
 var step=Math.max(50,+c.twStep||100),mc=Math.max(0,+c.twMoveCost||6),mg=Math.max(0,+c.twMargin||4);
 var dE=function(e,q){return Math.hypot(e.x-q.x,e.y-q.y)-(e.ranged?0:(e.r||17))};
 var ME=[],RG=[],SO=[];var __yh=T.yh?T.yh():2,__twW=1;if(!T.pp)T.pp=new WeakMap();
 L.forEach(function(e){var o=T.pp.get(e);if(c.teleDetect!==false&&o&&Math.hypot(e.x-o.x,e.y-o.y)>60){e.__vlTp=now;T.bad.push({x:o.x,y:o.y,t:now})}T.pp.set(e,{x:e.x,y:e.y});(e.ranged?RG:ME).push(e);if(c.teleDetect!==false&&(+e.farT||0)>=__yh-__twW)SO.push(e)});
 if(c.teleDetect!==false&&SO.length&&!flee){var __bestEsc=null,__bestEscD=-1;for(var __sa=0;__sa<16;__sa++){var __san=__sa*Math.PI/8,__sx=p.x+Math.cos(__san)*step,__sy=p.y+Math.sin(__san)*step;try{if(IT){var __sz=IT(__sx,__sy);if(__sz&&__sz.length>1){if(Math.hypot(__sz[0]-__sx,__sz[1]-__sy)>60)continue;__sx=__sz[0];__sy=__sz[1]}}}catch(e){}if(Math.hypot(__sx-p.x,__sy-p.y)<20)continue;var __minLandD=1e9,__blocked=false;for(var __si=0;__si<SO.length;__si++){var __se=SO[__si],__seR=__se.ranged?200:((__se.r||17)+24),__seLd=.7*__seR,__ex=p.x-__se.x,__ey=p.y-__se.y,__el=Math.hypot(__ex,__ey)||1,__lx=p.x+__ex/__el*__seLd,__ly=p.y+__ey/__el*__seLd,__ld=Math.hypot(__sx-__lx,__sy-__ly);if(__ld<__minLandD)__minLandD=__ld}for(var __ni=0;__ni<L.length;__ni++){if(SO.indexOf(L[__ni])>=0)continue;var __ne=L[__ni],__neR=__ne.ranged?200:((__ne.r||17)+24);if(Math.hypot(__sx-__ne.x,__sy-__ne.y)<__neR+40){__blocked=true;break}}if(__blocked)continue;if(__minLandD>__bestEscD){__bestEscD=__minLandD;__bestEsc={x:Math.round(__sx),y:Math.round(__sy)}}}if(__bestEsc){T.odir=(__bestEsc.x>=p.x)?1:-1;T.kt={x:__bestEsc.x,y:__bestEsc.y,why:"🏃 TELE-ESCAPE · "+SO.length+" quái sắp tele · đích cách "+Math.round(__bestEscD)+"px"};T.ktT=now;return T.kt}else{var __fx=0,__fy=0;for(var __fi=0;__fi<SO.length;__fi++){__fx+=p.x-SO[__fi].x;__fy+=p.y-SO[__fi].y}var __fl=Math.hypot(__fx,__fy)||1;__fx/=__fl;__fy/=__fl;var __tx=p.x+__fx*step,__ty=p.y+__fy*step;try{if(IT){var __tz=IT(__tx,__ty);if(__tz&&__tz.length>1){__tx=__tz[0];__ty=__tz[1]}}}catch(e){}T.odir=(__tx>=p.x)?1:-1;T.kt={x:Math.round(__tx),y:Math.round(__ty),why:"🏃 TELE-ESCAPE (fallback) · "+SO.length+" quái"};T.ktT=now;return T.kt}}
 var mn=function(a,q){var m=1e9;a.forEach(function(e){var d=dE(e,q);if(d<m)m=d});return m};
 var nm=mn(ME,p),nr=mn(RG,p),na=mn(L,p);
 var lim=T.stLim(),st=+Ci.stall||0;
 var crowdR=+c.twCrowdR||300,crowdMax=+c.twCrowdMax||3,threatMax=+c.twThreatMax||3;
 var crowdCount=0,threatMag=0;
 for(var _ci=0;_ci<L.length;_ci++){var _ce=L[_ci],_cd=Math.hypot(_ce.x-p.x,_ce.y-p.y);if(_cd<=crowdR)crowdCount++;if(_cd<600&&_cd>30)threatMag+=(600-_cd)/600}
 var crowdEscape=(crowdCount>=crowdMax)||(threatMag>=threatMax);
 if(!flee&&st>lim*Math.max(10,+c.twMaxStall||85)/100){T.kt=null;T.kNote="sắp quá giờ tầng → đứng bắn";return null}
 T.bad=T.bad.filter(function(b){return now-b.t<3000});
 if(T.kt){if(!T.kpos||Math.hypot(p.x-T.kpos.x,p.y-T.kpos.y)>6){T.kpos={x:p.x,y:p.y};T.kposT=now}else if(now-T.kposT>700){T.bad.push({x:T.kt.x,y:T.kt.y,t:now});T.kt=null;T.odir=-(T.odir||1)}}
 if(!flee&&!SO.length&&!crowdEscape&&nm>=nR*.85&&nr>=rgR&&na<=fR+10){T.kt=null;return null}
 if(T.kt&&now-T.ktT<900&&Math.hypot(T.kt.x-p.x,T.kt.y-p.y)>20&&nm>=nR*.5&&nr>=rgR-15)return T.kt;
 var had=!!T.kt,od=T.odir||1,ax=p.x-A.x,ay=p.y-A.y,al=Math.hypot(ax,ay);
 var distToSegSq=function(px,py,x1,y1,x2,y2){var l2=(x2-x1)*(x2-x1)+(y2-y1)*(y2-y1);if(l2===0)return(px-x1)*(px-x1)+(py-y1)*(py-y1);var t=((px-x1)*(x2-x1)+(py-y1)*(y2-y1))/l2;t=Math.max(0,Math.min(1,t));var projX=x1+t*(x2-x1),projY=y1+t*(y2-y1);return(px-projX)*(px-projX)+(py-projY)*(py-projY)};
 var sc=function(q,mv,o){var s=mv?mc:0,j,d;
  for(j=0;j<ME.length;j++){var e=ME[j];d=dE(e,q);var r1=Math.max(30,(e.r||17)+28+__mPx),r2=r1+__ss;
   if(d<r1)s+=(r1-d)*10*(flee?2:1);
   else if(d<=r2)s-=5;
   else s+=(d-r2)*(flee?5:3);
   if(mv&&distToSegSq(e.x,e.y,p.x,p.y,q.x,q.y)<r1*r1)s+=500;
  }
  for(j=0;j<RG.length;j++){var e=RG[j];d=dE(e,q);var r1=204+__mPx,r2=r1+__ss;
   if(d<r1)s+=(r1-d)*8*(flee?2:1);
   else if(d<=r2)s-=3;
   else s+=(d-r2)*(flee?5:1);
   if(mv&&distToSegSq(e.x,e.y,p.x,p.y,q.x,q.y)<r1*r1)s+=500;
  }
  if(!flee){d=mn(L,q);if(d>fR)s+=(d-fR)*3}
  if(crowdEscape)for(j=0;j<L.length;j++){var _e3=L[j],_d3=Math.hypot(_e3.x-q.x,_e3.y-q.y);if(_d3<crowdR)s+=(crowdR-_d3)*(flee?3:2)}
  d=Math.hypot(q.x-A.x,q.y-A.y);s+=d*.05;if(d>R)s+=(d-R)*4;
  if(mv&&al>30){var mx=q.x-p.x,my=q.y-p.y,ml=Math.hypot(mx,my)||1;s-=((-ay*o)*mx+(ax*o)*my)/(al*ml)*12;if(o!==od)s+=15}
  for(j=0;j<T.bad.length;j++)if(Math.hypot(q.x-T.bad[j].x,q.y-T.bad[j].y)<80)s+=300;
  if(c.teleDetect!==false)for(j=0;j<SO.length;j++){var __e=SO[j],__u=Math.min(1,Math.max(0,((+__e.farT||0)-(__yh-__twW))/__twW));if(__u<=0)continue;var __vx=__e.x-q.x,__vy=__e.y-q.y,__vl=Math.hypot(__vx,__vy)||1,__ux=__vx/__vl,__uy=__vy/__vl,__rngE=__e.ranged?200:((__e.r||17)+24),__lr=.7*__rngE,__lx=q.x+__ux*__lr,__ly=q.y+__uy*__lr,__ex=q.x-__ux*180,__ey=q.y-__uy*180,__w=0;if(Math.hypot(__lx-q.x,__ly-q.y)<__rngE+10)__w+=150;try{if(IT){var __z=IT(__ex,__ey);if(__z&&Math.hypot(__z[0]-__ex,__z[1]-__ey)>60)__w+=120}}catch(x){}var __dd2=Math.hypot(__ex-A.x,__ey-A.y);if(__dd2>R)__w+=(__dd2-R)*1.5;for(var __k=0;__k<L.length;__k++){if(L[__k]===__e)continue;var __d3=Math.hypot(L[__k].x-__ex,L[__k].y-__ey);if(__d3<140)__w+=(140-__d3)*(L[__k].ranged?.5:1)}s+=__w*__u}
  return s};
 var s0=sc(p,false,od),best=null,RR=[.8,1.4,2];
 for(var a=0;a<16;a++){var an=a*Math.PI/8;for(var m=0;m<3;m++){var x=p.x+Math.cos(an)*step*RR[m],y=p.y+Math.sin(an)*step*RR[m];
  try{if(IT){var z=IT(x,y);if(z&&z.length>1){if(Math.hypot(z[0]-x,z[1]-y)>60)continue;x=z[0];y=z[1]}}}catch(e){}
  if(Math.hypot(x-p.x,y-p.y)<30)continue;var q={x:Math.round(x),y:Math.round(y)};
  for(var k=0;k<2;k++){var o=k?-od:od,v=sc(q,true,o);if(!best||v<best.s)best={x:q.x,y:q.y,s:v,o:o}}}}
 for(var fgx=-3;fgx<=3;fgx++)for(var fgy=-3;fgy<=3;fgy++){if(fgx===0&&fgy===0)continue;var fx=p.x+fgx*25,fy=p.y+fgy*25;if(Math.hypot(fx-p.x,fy-p.y)>step*1.5)continue;
  try{if(IT){var fz=IT(fx,fy);if(fz&&fz.length>1){if(Math.hypot(fz[0]-fx,fz[1]-fy)>60)continue;fx=fz[0];fy=fz[1]}}}catch(e){}
  if(Math.hypot(fx-p.x,fy-p.y)<15)continue;var fq={x:Math.round(fx),y:Math.round(fy)};
  for(var fk=0;fk<2;fk++){var fo=fk?-od:od,fv=sc(fq,true,fo);if(!best||fv<best.s)best={x:fq.x,y:fq.y,s:fv,o:fo}}}
 for(var ti=0;ti<L.length;ti++)for(var tj=ti+1;tj<L.length;tj++){var ei=L[ti],ej=L[tj],tdx=ej.x-ei.x,tdy=ej.y-ei.y,tdl=Math.hypot(tdx,tdy);
  if(tdl<30||tdl>600)continue;var tri=(ei.ranged?200:((ei.r||17)+24))+20,trj=(ej.ranged?200:((ej.r||17)+24))+20;
  var tmx=(ei.x*trj+ej.x*tri)/(tri+trj),tmy=(ei.y*trj+ej.y*tri)/(tri+trj),tnx=-tdy/tdl,tny=tdx/tdl;
  for(var ts=-1;ts<=1;ts+=2){var tx2=tmx+tnx*(tri+trj)*0.6*ts,ty2=tmy+tny*(tri+trj)*0.6*ts;
   try{if(IT){var tz=IT(tx2,ty2);if(tz&&tz.length>1){if(Math.hypot(tz[0]-tx2,tz[1]-ty2)>60)continue;tx2=tz[0];ty2=tz[1]}}}catch(e){}
   var tdp=Math.hypot(tx2-p.x,ty2-p.y);if(tdp<30||tdp>step*3)continue;var tq={x:Math.round(tx2),y:Math.round(ty2)};
   for(var tk=0;tk<2;tk++){var to=tk?-od:od,tv=sc(tq,true,to);if(!best||tv<best.s)best={x:tq.x,y:tq.y,s:tv,o:to}}}}
 if(!best||best.s>s0-mg){T.kt=null;T.kNote="không có chỗ giãn tốt hơn";return null}
 T.odir=best.o;
 T.kt={x:best.x,y:best.y,why:"🪁 MAX · "+(flee?"chạy, máu "+Math.round(hp)+"%":nr<rgR?"giãn quái xa "+Math.round(nr)+"px":"giãn cận chiến "+Math.round(nm)+"px")+" · vòng "+(best.o>0?"↻":"↺")+" · cách tâm "+Math.round(Math.hypot(best.x-A.x,best.y-A.y))+" · "+T.tInfo()};
 T.ktT=now;if(!had){T.kpos={x:p.x,y:p.y};T.kposT=now}return T.kt};
T.drive=function(){var c=T.C||{},p=POS(),now=Date.now();
 if(Ci.tower&&p&&!T.ctr0){var __c=T.ctr();if(__c&&__c.x!=null)T.ctr0={x:__c.x,y:__c.y};else T.ctr0={x:Math.round(p.x),y:Math.round(p.y)};T.anc=T.ctr0;T.spd=0;T.lp=null;console.log("%c[VL THÁP] anchor cố định ("+T.ctr0.x+","+T.ctr0.y+")","color:#6cf")}
 if(!Ci.tower&&T.ctr0){T.ctr0=null;T.forceCtr=false;T.lootStartT=null;T.wasDead=false;T._vT=null;T.overrideMove=null;T.lootFailStreak=0;T.lootDisabledUntil=0;T.lootCooldownUntil=0;T.tlPhase=0;T.tlLast=0;T.tlDone=false;T.pushLootT=0}
 if(Ci.tower&&p){T.twSeen=now;
  if(T.lp){var dt=(now-T.lpT)/1000,mv=Math.hypot(p.x-T.lp.x,p.y-T.lp.y);if(dt>.04&&dt<.6&&mv>2){var vv=mv/dt;if(vv<1000)T.spd=T.spd?T.spd*.85+vv*.15:vv}}
  T.lp={x:p.x,y:p.y};T.lpT=now}
 if(Ci.deadT<=0)T.wasDead=false;
 if(!c.twAi||Ci.deadT>0||!p){T.st="";T.kt=null;return}
 var mine=function(){var m=Ci.moveTo;return !!(m&&m.vl)};
 var L=(Ci.enemies||[]).filter(function(e){return e&&e.hp>0&&!e.dead});
 if(!Ci.tower){
  if(c.twLoot){
   var __pls=Math.max(0.2,+c.pushLootSec||5)*1000;
   if(!T.pushLootT||now-T.pushLootT>=__pls){
    T.pushLootT=now;
    var __plN=(Ci.ground||[]).length,__plOk=0;
    if(__plN>0&&PICK){
     var __plArr=(Ci.ground||[]).slice();
     for(var __pli=0;__pli<__plArr.length;__pli++){
      var __pitem=__plArr[__pli];
      if(!__pitem)continue;
      try{if(PICK(__pitem,true))__plOk++}catch(e){}
     }
     if(__plOk){T.pickedItems=(T.pickedItems||0)+__plOk;T.pushLootTotal=(T.pushLootTotal||0)+__plOk;}
    }
    T.lastLootPush={ok:__plOk,n:__plN,t:now};
    T.dbg={txt:"💰 push loot · nhặt "+__plOk+"/"+__plN+" món"};
   }
  }
  if(L.length){
   T.lt=null;
   if(T.overrideMove){Ci.moveTo=null;T.overrideMove=null;}
   T.st="fight-push";T.dbg={txt:"⚔ push combat · "+L.length+" quái"};return;
  }
  if(c.twLoot){
   var __pls=Math.max(0.2,+c.pushLootSec||5)*1000;
   if(!T.pushLootT||now-T.pushLootT>=__pls){
    T.pushLootT=now;
    var __plN=(Ci.ground||[]).length,__plOk=0;
    if(__plN>0&&PICK){
     var __plArr=(Ci.ground||[]).slice();
     for(var __pli=0;__pli<__plArr.length;__pli++){
      var __pitem=__plArr[__pli];
      if(!__pitem)continue;
      try{if(PICK(__pitem,true))__plOk++}catch(e){}
     }
     if(__plOk){T.pickedItems=(T.pickedItems||0)+__plOk;T.pushLootTotal=(T.pushLootTotal||0)+__plOk;}
    }
    T.lastLootPush={ok:__plOk,n:__plN,t:now};
    T.dbg={txt:"💰 push loot · nhặt "+__plOk+"/"+__plN+" món"};
   }
  }
  if(T.overrideMove){Ci.moveTo=null;T.overrideMove=null;}
  T.st="push-wait";
  if(!T.dbg||!T.dbg.txt)T.dbg={txt:"🚀 push chờ wave"};
  return;
 }
 if(L.length){T.lt=null;T.tlPhase=0;T.tlLast=0;T.tlDone=false;
  if(c.twKite!==false){var k=null;try{k=T.kiteMax(p,L,c,now)}catch(e){T.kErr=e.message}
   if(k){Ci.moveTo={x:k.x,y:k.y,hp:1,max:1,vl:1};Ci.meleeTg=null;T.overrideMove={x:k.x,y:k.y,hp:1,max:1,vl:1};T.st="kite";T.dbg={txt:"🪁 thả diều · "+L.length+" quái · "+k.why};return}}
  Ci.moveTo=null;T.overrideMove=null;T.st="fight";T.dbg={txt:"⚔ đánh "+L.length+" quái"+(T.kNote?" · "+T.kNote:"")+" · "+T.tInfo()};return}
 T.kt=null;
 var __vdt=function(){var d=(now-(T._vT||now))/1000;T._vT=now;if(d<=0)d=0.016;if(d>0.2)d=0.2;return d};
 var __vnMove=function(tx,ty,spd){if(typeof vn==="function"){T.vnTarget={x:tx,y:ty,spd:spd,until:Date.now()+800}}else{var d=__vdt();var dd=Math.hypot(tx-qi.x,ty-qi.y);vn(qi,tx,ty,Math.min(dd,spd*d));Ci.moveTo={x:tx,y:ty,hp:1,max:1,vl:1};Ci.meleeTg=null}};
 var __vnFallback=function(tx,ty,spd){var d=__vdt();var dd=Math.hypot(tx-qi.x,ty-qi.y);if(typeof vn==="function")vn(qi,tx,ty,Math.min(dd,spd*d));else{Ci.moveTo={x:tx,y:ty,hp:1,max:1,vl:1};Ci.meleeTg=null}};
 if(c.twLoot&&!T.tlDone){
  var __tlArr=(Ci.ground||[]).slice(),__tlOk=0,__tlN=__tlArr.length;
  var __tlDo=false;
  if(!T.tlPhase||T.tlPhase===0){
   T.tlPhase=1;T.tlLast=now;__tlDo=true;
  } else if(T.tlPhase>=3){
   if(now-(+T.tlLast||0)>=500){T.tlDone=true;T.dbg={txt:"💰 loot xong · về tâm"}}
  } else if(now-(+T.tlLast||0)>=500){
   T.tlPhase=+T.tlPhase+1;T.tlLast=now;__tlDo=true;
  }
  if(__tlDo){
   if(__tlN>0&&PICK){
    for(var __tli=0;__tli<__tlArr.length;__tli++){
     var __tlIt=__tlArr[__tli];
     if(!__tlIt)continue;
     try{if(PICK(__tlIt,true))__tlOk++}catch(e){}
    }
    if(__tlOk){T.pickedItems=(T.pickedItems||0)+__tlOk;T.twLootTotal=(T.twLootTotal||0)+__tlOk;}
   }
   T.lastLootTw={ok:__tlOk,n:__tlN,t:now,phase:T.tlPhase};T.dbg={txt:"💰 loot "+T.tlPhase+"/3 · nhặt "+__tlOk+"/"+__tlN+" món"};
  }
 }
 var cc=T.ctr0||T.anc||T.ctr();if(!cc){T.dbg={txt:"⚠ không đọc được tâm map"};return}
 var dc=Math.hypot(cc.x-p.x,cc.y-p.y);
 if(dc>Math.max(10,+c.twCtrR||30)){Ci.moveTo={x:cc.x,y:cc.y,hp:1,max:1,vl:1};Ci.meleeTg=null;T.overrideMove={x:cc.x,y:cc.y,hp:1,max:1,vl:1};T.st="ctr";
  if(!T.tlDone&&T.tlPhase>0)T.dbg={txt:"💰 loot "+T.tlPhase+"/3 · đang về tâm"};
  else T.dbg={txt:"🎯 về tâm ("+cc.x+","+cc.y+") · cách "+Math.round(dc)+"px"}}
 else{Ci.moveTo=null;T.overrideMove=null;T.st="wait";T.dbg={txt:"⏳ đứng tâm map, chờ quái"}}};
if(!window.__vlSmoothMove){window.__vlSmoothMove=1;(function(){var _lt=0;window.__vlSmoothDbg={mvOK:0,pl:'?',pos:null,sameRef:false};var _mv=function(p,tx,ty,step){var d=Math.hypot(tx-p.x,ty-p.y)||1;var a=Math.min(1,step/d);var bx=p.x,by=p.y;p.x+=(tx-p.x)*a;p.y+=(ty-p.y)*a;window.__vlSmoothDbg.mvOK++;window.__vlSmoothDbg.pos={x:Math.round(p.x),y:Math.round(p.y)};return Math.hypot(p.x-bx,p.y-by)>0.01};var _getPl=function(){var __p=null,__s='null';try{var p=POS();if(p&&typeof p.x==="number"&&!isNaN(p.x)){__p=p;__s='POS()'}}catch(e){}if(!__p)try{if(typeof Ci!=="undefined"&&Ci.P&&typeof Ci.P.x==="number"&&!isNaN(Ci.P.x)){__p=Ci.P;__s='Ci.P'}}catch(e){}if(window.__vlSmoothDbg){window.__vlSmoothDbg.pl=__s;window.__vlSmoothDbg.sameRef=(__p&&__p===window.__vlSmoothDbg._lp);window.__vlSmoothDbg._lp=__p}return __p};var _rf=function(ts){try{var dt=_lt?(ts-_lt):16.7;_lt=ts;var T=window.__vlTW;if(T){var p=_getPl();if(p){var tx=null,ty=null,spd=500;if(T.vnTarget&&Date.now()<T.vnTarget.until){tx=T.vnTarget.x;ty=T.vnTarget.y;spd=T.vnTarget.spd;if(Math.hypot(tx-p.x,ty-p.y)<3)T.vnTarget=null}else if((T.forceCtr||T.st==="ctr")&&(T.ctr0||T.anc)&&typeof Ci!=="undefined"&&Ci.tower&&!(Ci.enemies||[]).length){var c0=T.ctr0||T.anc;var dc=Math.hypot(c0.x-p.x,c0.y-p.y);if(dc>2){tx=c0.x;ty=c0.y;spd=dc>300?800:dc>100?500:250}}if(tx!=null&&_mv){var dc2=Math.hypot(tx-p.x,ty-p.y);var step=spd*dt/1000;if(dc2>0.5)_mv(p,tx,ty,Math.min(dc2,step))}}}}catch(e){}requestAnimationFrame(_rf)};requestAnimationFrame(_rf);setTimeout(function(){try{console.log("%c[VL SMOOTH] \u2713 installed \u00b7 mv="+(_mv?_mv.name:"NONE")+" \u00b7 pl="+(_getPl()?"\u2713":"\u2717"),"color:#8f8;font-weight:bold")}catch(e){}},2000)})()}
if(!window.__vlTwIv)window.__vlTwIv=setInterval(function(){try{var t=window.__vlTW;if(t&&t.drive)t.drive()}catch(e){}},100);

T.ready=true;return 1})()`
    }

    /* ===== 3. API BRIDGE ===== */
    function apiCode(N) {
        const MS = N.ws, W = N.wi; let s = '';
        if (!MS || !W) return s;
        const zone = 'if(' + MS + '.maxStage>' + MS + '.stage){' + MS + '.stage=' + MS + '.maxStage;' + MS + '.wave=1;' + W + '.enemies=[];' + W + '.corpses=[];' + W + '.zoneShown=null;' + (N.my ? 'try{' + N.my + '()}catch(e){}' : '') + '}';
        s += 'window.__vlPushGet=function(){try{return{stage:' + MS + '.stage,maxStage:' + MS + '.maxStage,push:!!' + MS + '.push,hold:!!' + MS + '.hold,wave:' + MS + '.wave,lvl:' + MS + '.lvl}}catch(e){return{err:e.message}}};';
        s += 'window.__vlPushSet=function(on,snap){try{' + MS + '.push=!!on;' + MS + '.hold=false;if(snap){' + zone + '}return{ok:true,stage:' + MS + '.stage,push:!!' + MS + '.push}}catch(e){return{ok:false,msg:e.message}}};';
        if (N.ph && N.uh && N.xr) {
            const H = N.xr, U = N.uh, P = N.ph, MH = N.mh, rb = '((' + H + '().stat.reborn)||0)';
            s += 'window.__vlRbGet=function(){try{var r=' + rb + ',need=' + U + '(r);return{lvl:' + MS + '.lvl,reborn:r,need:need,ready:' + MS + '.lvl>=need,xpts:' + MS + '.xpts||0,stage:' + MS + '.stage,maxStage:' + MS + '.maxStage}}catch(e){return{err:e.message}}};';
            s += 'window.__vlRbDo=function(snap){try{var r0=' + rb + ',t=' + U + '(r0);if(' + MS + '.lvl<t)return{ok:false,msg:"cần cấp "+t};' +
                'if(' + W + '.tower||' + W + '.dg)return{ok:false,msg:"đang ở tháp/phó bản"};' +
                (MH ? MH + '=Date.now()+5e3;' + P + '();' : P + '();if(' + rb + '===r0)' + P + '();') +
                'if(' + rb + '===r0)return{ok:false,msg:"game không chuyển sinh"};' +
                'if(snap){' + zone + '}' +
                'return{ok:true,reborn:' + rb + ',stage:' + MS + '.stage}}catch(e){return{ok:false,msg:e.message}}};';
        }
        if (N.ch) { s += 'window.__vlTowerEnter=function(){try{if(' + W + '.tower||' + W + '.dg||' + W + '.deadT>0)return{ok:false,msg:"busy"};' + N.ch + '();return{ok:true}}catch(e){return{ok:false,msg:e.message}}};'; }
        if (N.towerExit) s += 'window.__vlTowerExit=function(){try{' + N.towerExit + '();return{ok:true}}catch(e){return{ok:false,msg:e.message}}};';
        return s;
    }
    function expo(N) {
        const p = ['__v:8.2', 'ev:function(__vlS){return eval(__vlS)}'];
        for (const k of ['ws', 'wi', 'xr', 'Fn', 'Ee', 'H']) if (N[k]) p.push('get ' + k + '(){try{return ' + N[k] + '}catch(e){return null}}');
        if (N.Ao) p.push('get Ao(){return ' + N.Ao + '}', 'set Ao(v){' + N.Ao + '=v}');
        for (const k of ['Y', 'Wn', 'Rs', 'Ko', 'ac', 'ds', 'lc', 'Hn', 'Ue', 'Ze', 'Ru', 'An', 'qt', 'Xt', 'sn', 'on', 'uh'])
            if (N[k]) p.push(k + ':function(){return ' + N[k] + '.apply(void 0,arguments)}');
        if (N.Zn && N.nn) p.push('isUp:function(t){return!!(' + N.Zn + '(t)&&!' + N.nn + '(t))}');
        const ck = Object.keys(N).filter(k => /^[A-Za-z_$][\w$]*$/.test(N[k]));
        p.push('__chk:function(){var r={};' + ck.map(k => 'try{r["' + k + '"]=typeof ' + N[k] + '}catch(e){r["' + k + '"]="ERR"}').join('') + 'return r}');
        return ';window.__VLX={' + p.join(',') + '};' + apiCode(N);
    }
    function insert(code, N) {
        const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        let m = null;

        // Ưu tiên chèn ngay trước hàm xr đã được bộ dò nhận diện,
        // để __VLX nằm trong đúng phạm vi biến nội bộ của game.
        if (N && N.xr) {
            try {
                const exact = new RegExp('[;}]\\s*(?=function\\s+' + esc(N.xr) + '\\s*\\()');
                m = exact.exec(code);
            } catch (e) {}
        }

        // Dự phòng theo cách dò tương thích với bản Auto gốc.
        if (!m) {
            m = R('[;}]function @\\(\\)\\{const @=@\\.rw\\|\\|').exec(code);
        }

        if (!m) {
            M.why.insert = 'Không tìm thấy vị trí chèn __VLX trong g.js';
            return null;
        }

        M.why.insert = N && N.xr
            ? ('Đã chèn __VLX cạnh hàm ' + N.xr)
            : 'Đã chèn __VLX theo vị trí dự phòng';
        const at = m.index + 1;
        return code.slice(0, at) + expo(N) + code.slice(at);
    }
    function build(G) {
        const ok = s => { try { new Function(s); return 1 } catch (e) { return e instanceof SyntaxError ? 0 : 1 } };
        const one = (src, p) => { const m = R(p[1]).exec(src); return m ? src.slice(0, m.index) + p[2](m) + src.slice(m.index + m[0].length) : null };

        // Dò tên hàm trên mã gốc trước khi chèn bất kỳ cầu nối nào.
        const N = M.N = findNames(G);

        // Cầu nối Ns được chèn đúng trong lần nạp g.js do Auto Hoài Niệm kiểm soát.
        // Kiểm tra chính xác dấu hiệu cầu nối, không dùng includes tổng quát.
        const nsBridgeExists = /window\.__vltkGetNs\s*=/.test(G);
        const nsMarker = /\blet\s+e\s*=\s*0\s*;/;
        if (!nsBridgeExists && nsMarker.test(G)) {
            G = G.replace(nsMarker, match => match +
                '\ntry {' +
                ' window.__vltkGetNs = function(){ try { return (typeof Ns !== "undefined") ? Ns : undefined; } catch(_e) { return undefined; } };' +
                ' window.Ns = window.__vltkGetNs();' +
                '} catch (__vltkNsBridgeErr) {}' +
                '\n');
            M.why.ns = 'Đã gắn cầu nối Ns vào g.js';
        } else if (nsBridgeExists) {
            M.why.ns = 'g.js đã có cầu nối Ns';
        } else {
            M.why.ns = 'Không tìm thấy điểm móc let e = 0 trong g.js';
        }

        for (const safe of [false, true]) {
            let code = G; const res = [];
            if (C.patch) for (const p of PATCH) {
                const n = one(code, p);
                if (n == null) { res.push('❌ ' + p[0]); continue }
                if (safe && !ok(n)) { res.push('⚠ ' + p[0] + ' (bỏ)'); continue }
                code = n; res.push('✅ ' + p[0]);
            }
            const out = insert(code, N);
            if (out && ok(out)) {
                M.res = res.concat('✅ Kết nối hàm');
                M.why.build = 'Đã chèn API Auto Hoài Niệm';
                return out;
            }
            if (safe) {
                M.res = res.concat('❌ Kết nối hàm');
                M.why.build = 'Không chèn được API Auto Hoài Niệm';
                return code;
            }
        }
        return G;
    }

    /* ===== 4. NẠP FILE GAME ===== */
    const MK = ['Phúc Duyên', 'Kho Rèn', 'allres_p', 'Hành trang', 'ivBag'];
    const oF = window.fetch; let done = false;
    function isCand(s) {
        if (!s.src || s.dataset.vl) return false; let u; try { u = new URL(s.src, location.href) } catch (e) { return false }
        if (s.type === 'javascript/blocked') { M.why.late = 'Script khác chặn file game – tắt bản cũ'; return false }
        if (/\/js\/g\.js$/.test(u.pathname)) return true;
        return C.wide && !done && (s.async || s.defer) && u.origin === location.origin && !/\/(sw|jquery|gtag|analytics)[\w.-]*\.js$/i.test(u.pathname)
    }
    function reAdd(src, s) { const n = document.createElement('script'); n.src = src; n.async = true; n.dataset.vl = 're'; (s.parentNode || document.head || document.documentElement).appendChild(n) }
    function inject(code) {
        const body = 'window.__VLM.start=1;\n' + code + '\n;window.__VLM.ran=1;';
        const p = document.head || document.documentElement, s = document.createElement('script');
        s.dataset.vl = 'p'; s.textContent = body; p.appendChild(s);
        if (M.ran) { M.how = 'inline'; return }
        if (M.start) { M.how = 'inline (lỗi)'; return }
        const b = document.createElement('script'); b.dataset.vl = 'p';
        b.src = URL.createObjectURL(new Blob([body], { type: 'text/javascript' }));
        b.onload = () => { M.how = M.ran ? 'blob' : 'blob (lỗi)' }; p.appendChild(b);
    }
    function grab(s) {
        const src = s.src; s.type = 'javascript/blocked'; s.dataset.vl = 'blk';
        oF.call(window, src, { credentials: 'same-origin' }).then(r => r.text()).then(t => {
            if (!done && MK.filter(m => t.includes(m)).length >= 3) {
                done = true; M.file = src.replace(location.origin, '');
                window.__dumpSrc = t;
                inject(build(t)); whenBody(initUI)
            }
            else reAdd(src, s)
        }).catch(e => { M.why.fetch = String(e); reAdd(src, s) })
    }
    for (const s of document.querySelectorAll('script[src]')) if (/\/js\/g\.js/.test(s.src) && !s.dataset.vl) M.why.late = 'Userscript chạy muộn → F5';
    const mo = new MutationObserver(ms => { for (const m of ms) for (const n of m.addedNodes) if (n.tagName === 'SCRIPT' && isCand(n)) grab(n) });
    mo.observe(document.documentElement || document, { childList: true, subtree: true });
    document.addEventListener('beforescriptexecute', e => { if (e.target.dataset && e.target.dataset.vl === 'blk') e.preventDefault() }, true);
    window.addEventListener('load', () => setTimeout(() => { mo.disconnect(); if (!box) initUI() }, 3000));

    /* ===== 4. LOGIC ENGINE EVENT & TẨY LUYỆN ===== */
    let autoEventInterval = null;
    let autoPDInterval = null;
    let isTayLuyenRunning = false;
    let tayLuyenInterval = null;

    let savedEventItems = [];
    let selectedEventValue = "";

    function isOurToolNode(node) {
        return !!(node && node.closest && node.closest('#vlm8, #vlMenuDock, #vlHandBtn'));
    }

    function clickOpenPhucDuyenOnce() {
        let targetEl = null;
        const allNodes = document.querySelectorAll('button, div, span, a, p');
        for (let el of allNodes) {
            if (isOurToolNode(el)) continue;
            if (el.innerText) {
                const txt = el.innerText.trim();
                if (txt === 'Mở rương Phúc Duyên' || (txt.includes('Mở rương') && txt.includes('Phúc Duyên'))) {
                    if (!targetEl || el.children.length < targetEl.children.length) {
                        targetEl = el;
                    }
                }
            }
        }
        if (targetEl) { triggerFullClick(targetEl); return true; }
        return clickByText('Mở rương Phúc Duyên', true) || clickByText('Mở rương');
    }

    function exchangePhucDuyen(times = 1) {
        let count = 0;
        const max = Math.max(1, Number(times) || 1);
        const timer = setInterval(() => {
            const clicked = clickOpenPhucDuyenOnce();
            count++;
            if (!clicked || count >= max) clearInterval(timer);
        }, 120);
    }

    function getEventItemList() {
        const items = [];
        const allNodes = document.querySelectorAll('button, div, span, a');

        allNodes.forEach(node => {
            if (isOurToolNode(node)) return;
            const txt = node.innerText ? node.innerText.trim() : '';

            if (txt === 'Đổi' || txt === 'ĐỔI') {
                let row = node.closest('tr, li, .row, div[style*="flex"], div');
                if (row && !isOurToolNode(row)) {
                    let rowText = row.innerText ? row.innerText.replace(/\n/g, ' ').trim() : '';
                    let cleanName = rowText.replace(/Đổi|ĐỔI/g, '').trim();

                    if (cleanName && cleanName.length > 1 && cleanName.length < 50) {
                        if (!items.some(it => it.text === cleanName)) {
                            items.push({ text: cleanName, top: node.getBoundingClientRect().top });
                        }
                    }
                }
            }
        });
        return items;
    }

    function exchangeSelectedItem(times = 1) {
        const sel = document.getElementById('v-sel-event');
        const valToExchange = (sel && sel.value) ? sel.value.trim() : selectedEventValue;
        if (!valToExchange) {
            alert('Vui lòng mở tab Sự kiện rồi bấm Quét Món!');
            return false;
        }

        let count = 0;
        const max = Math.max(1, Number(times) || 1);

        const timer = setInterval(() => {
            let clicked = false;
            const allButtons = document.querySelectorAll('button, div, span, a');

            for (let btn of allButtons) {
                if (isOurToolNode(btn)) continue;
                const btnTxt = btn.innerText ? btn.innerText.trim() : '';

                if (btnTxt === 'Đổi' || btnTxt === 'ĐỔI') {
                    let row = btn.closest('tr, li, .row, div[style*="flex"], div');
                    if (row && !isOurToolNode(row)) {
                        let rowText = row.innerText ? row.innerText.replace(/\n/g, ' ').trim() : '';
                        let keyWord = valToExchange.split(/\d+\s*Lệnh Bài/)[0].trim();

                        if (rowText.includes(keyWord) || valToExchange.includes(rowText.replace(/Đổi|ĐỔI/g, '').trim())) {
                            triggerFullClick(btn);
                            clicked = true;
                            break;
                        }
                    }
                }
            }

            count++;
            if (count >= max || !clicked) {
                clearInterval(timer);
            }
        }, 120);

        return true;
    }

    function checkTargetStatsAndClick() {
        const mBody = document.getElementById('mBody') || document.body;
        const bodyText = mBody ? (mBody.innerText || mBody.textContent || '') : '';

        const hasSkillLine = bodyText.includes('Kỹ năng vốn có') || bodyText.includes('Kỹ năng');
        const hasPlus2 = bodyText.includes('+2') || bodyText.includes('+ 2') || bodyText.includes('+2 cấp') || bodyText.includes('+ 2 cấp');

        if (hasSkillLine && hasPlus2) {
            stopTayLuyen();
            return;
        }

        const btn = document.getElementById('fRe') || document.querySelector('button#fRe') || document.querySelector('button.btn.red');
        if (btn) triggerFullClick(btn);
    }

    function stopTayLuyen() {
        isTayLuyenRunning = false;
        if (tayLuyenInterval) clearInterval(tayLuyenInterval);
        const btn = document.getElementById('v-btn-do-tayluyen');
        if (btn) {
            btn.innerText = '▶️ Bắt Đầu Tẩy';
            btn.style.background = '#a6e3a1';
        }
    }

    /* ===== 5. TÚI + MẶC ĐỒ ===== */
    let X = null, tk = 0;
    const fmt = n => { const a = Math.abs(n), s = n < 0 ? '-' : ''; return s + (a >= 1e9 ? (a / 1e9).toFixed(2) + 'B' : a >= 1e6 ? (a / 1e6).toFixed(2) + 'M' : a >= 1e3 ? (a / 1e3).toFixed(1) + 'k' : '' + Math.round(a)) };
    const cap = () => X.Y ? X.Y() : 60, fbArr = () => X.Wn ? X.Wn() : (X.ws.fbox || []), fbCap = () => +X.Fn || 120;
    const val = t => { try { return X.Hn ? +X.Hn(t) || 0 : +t.price || 0 } catch (e) { return 0 } };
    const rm = (t, a) => { const i = a.indexOf(t); if (i >= 0) a.splice(i, 1) };
    const sell = (t, a) => { const g = val(t); X.ws.gold += g; rm(t, a); return g };
    const dirty = () => { try { X.Ao = true } catch (e) { } try { X.Rs && X.Rs() } catch (e) { } };
    const isUp = t => { try { return X.isUp ? X.isUp(t) : false } catch (e) { return false } };
    const offFac = t => {
        const ws = X.ws; if (!X.H || !ws.fac) return false; const f = X.H[ws.fac]; if (!f || f.id == null) return false;
        const r = (t.req || []).find(q => q[0] === 39); return !!r && r[1] >= 0 && r[1] !== f.id
    };
    function why(t, rare) {
        if (t.enh >= (+C.keepEnh || 5)) return 'lock';
        if (t.vio && !C.sellVio) return 'lock';
        if (t.lock && !(C.sellRare && C.sellLocked)) return 'lock';
        if (offFac(t)) return C.sellOff ? '' : 'off';
        if (!t.vlOld && isUp(t)) return 'up';
        if ((t.lvl || 0) > X.ws.lvl + (+C.lvlAhead || 0)) return 'hi';
        if (!rare && !t.vlOld && ((t.r || 0) >= C.keepRar || t.set || t.plv)) return 'rare';
        return ''
    }
    const isMat = t => !t.set && (t.r === 0 || (X.Ee && X.Ee.includes(t.d) && t.r > 0) || (X.Ue && (() => { try { return X.Ue(t) } catch (e) { return false } })()));
    const SLOTS = ['weapon', 'armor', 'helm', 'belt', 'boot', 'cuff', 'amulet', 'ring1', 'ring2', 'pendant'];
    const SD = { weapon: 0, armor: 2, helm: 7, belt: 6, boot: 5, cuff: 8, amulet: 4, ring1: 3, ring2: 3, pendant: 9 };
    const D2SLOT = { 0: 'weapon', 2: 'armor', 4: 'amulet', 5: 'boot', 6: 'belt', 7: 'helm', 8: 'cuff', 9: 'pendant' };
    const canEval = () => !!(X && X.Xt && X.sn);
    function wearable(it) { try { const r = X.on ? X.on(it) : []; return !(r && r.length) } catch (e) { return true } }
    function slotOf(it) { if (it.vlSlot && SD[it.vlSlot] != null) return it.vlSlot; try { return X.An(it) || '' } catch (e) { return '' } }
    function equipTo(it, slot) {
        const ws = X.ws, i = ws.inv.indexOf(it); if (i < 0) return false;
        ws.inv.splice(i, 1); const old = ws.eq[slot]; ws.eq[slot] = it; delete it.vlOld;
        if (old) { old.vlOld = 1; ws.inv.push(old) }
        try { X.wi.dirty = true } catch (e) { } return true
    }
    function eqFreeSlots() {
        if (!X || !X.ws || !canEval()) return 0;
        const ws = X.ws;
        let n = 0;
        for (const slot of SLOTS) {
            if (C.lockSlots && C.lockSlots[slot]) continue;
            const cur = ws.eq[slot];
            if (cur && (cur.set || cur.leg)) continue;
            const cands = ws.inv.filter(it => {
                const s = slotOf(it);
                return (s === slot || (/^ring/.test(slot) && /^ring/.test(s)))
                    && !it.set && !it.leg && wearable(it);
            });
            if (!cands.length) continue;
            const E = Object.assign({}, ws.eq);
            let bestScore;
            try { bestScore = +X.sn(X.Xt(E)) || 0; } catch (e) { continue; }
            let best = null;
            for (const it of cands) {
                const T = Object.assign({}, E);
                T[slot] = it;
                try {
                    const v = +X.sn(X.Xt(T)) || 0;
                    if (v > bestScore && (!best || v > best.v)) best = { it: it, v: v };
                } catch (e) { }
            }
            if (best && equipTo(best.it, slot)) n++;
        }
        if (n) { S.eq += n; try { X.ds && X.ds() } catch (e) { } dirty(); }
        return n;
    }
    function detectSetsTick() {
        if (!C.setAutoOn || !X || !X.ws || !canEval()) return;
        const now = Date.now();
        if (now - (S.lastSetScan || 0) < (+C.setIntervalSec || 60) * 1000) return;
        if (now - (S.lastSetSwap || 0) < (+C.setCooldown || 60) * 1000) return;
        S.lastSetScan = now;
        const t0 = Date.now();
        const ws = X.ws, inv = ws.inv || [], eq = ws.eq || {};
        const all = [...new Set([...inv, ...Object.values(eq).filter(Boolean)])];
        const ALLSLOTS = ['weapon', 'armor', 'helm', 'belt', 'boot', 'cuff', 'amulet', 'pendant', 'ring1', 'ring2'];
        const LOCK = C.lockSlots || {};
        const lockedSlot = sl => LOCK[sl] === true;
        const sortH = a => a.slice().sort((x, y) => (y.mag?.length || 0) - (x.mag?.length || 0) || (y.r || 0) - (x.r || 0) || (y.lvl || 0) - (x.lvl || 0) || (y.enh || 0) - (x.enh || 0));
        const fullPool = {}; ALLSLOTS.forEach(s => fullPool[s] = []);
        for (const t of all) {
            if (!t || typeof t !== 'object') continue;
            if (t.d === 3) { fullPool.ring1.push(t); fullPool.ring2.push(t) }
            else { const sl = D2SLOT[t.d]; if (sl && fullPool[sl]) fullPool[sl].push(t) }
        }
        for (const sl in fullPool) fullPool[sl] = sortH(fullPool[sl]);
        const pool = {}; for (const sl of ALLSLOTS) pool[sl] = fullPool[sl].slice(0, 30);
        let origP; try { origP = +X.sn(X.Xt(eq)) || 0 } catch (e) { return }
        if (!origP) return;
        const origEq = {}; for (const sl of ALLSLOTS) origEq[sl] = eq[sl] || null;
        const meas = () => { let p = 0; try { p = +X.sn(X.Xt(eq)) || 0 } catch (e) { } return p };
        const hillClimb = (startCfg, rounds) => {
            const cfg = {}; for (const sl of ALLSLOTS) cfg[sl] = startCfg[sl] || null;
            for (const sl of ALLSLOTS) eq[sl] = cfg[sl];
            let p = meas();
            for (let r = 1; r <= rounds; r++) {
                let improved = false;
                for (const sl of ALLSLOTS) {
                    if (lockedSlot(sl)) continue;
                    let bestIt = cfg[sl], bestP = p;
                    for (const t of pool[sl]) {
                        if (t === cfg[sl]) continue;
                        const bak = eq[sl]; eq[sl] = t;
                        const p2 = meas();
                        eq[sl] = bak;
                        if (p2 > bestP) { bestP = p2; bestIt = t }
                    }
                    if (bestIt !== cfg[sl] && bestP > p * 1.005) { cfg[sl] = bestIt; eq[sl] = bestIt; p = bestP; improved = true }
                }
                if (!improved) break;
            }
            return { p: p, cfg: cfg };
        };
        const hc0 = hillClimb(origEq, 8);
        let bestP = hc0.p, bestCfg = hc0.cfg;
        const grps = {};
        for (const t of all) {
            if (!t || !t.set || t.set.grp == null) continue;
            const g = String(t.set.grp);
            if (!grps[g]) grps[g] = [];
            grps[g].push(t);
        }
        for (const g in grps) {
            const bySlot = {}; ALLSLOTS.forEach(s => bySlot[s] = []);
            for (const t of grps[g]) {
                if (t.d === 3) { bySlot.ring1.push(t); bySlot.ring2.push(t) }
                else { const sl = D2SLOT[t.d]; if (sl && bySlot[sl]) bySlot[sl].push(t) }
            }
            for (const sl in bySlot) bySlot[sl] = sortH(bySlot[sl]);
            let unique = 0; for (const sl of ALLSLOTS) if (bySlot[sl].length > 0) unique++;
            if (unique < 7) continue;
            const seed = {}; for (const sl of ALLSLOTS) seed[sl] = origEq[sl];
            const used = {}; let taken = 0;
            for (const sl of ALLSLOTS) {
                if (lockedSlot(sl)) continue;
                if (bySlot[sl][0] && taken < 7) { seed[sl] = bySlot[sl][0]; used[sl] = true; taken++ }
            }
            if (taken < 7) continue;
            const seedItems = new Set();
            for (const sl of ALLSLOTS) if (used[sl]) seedItems.add(seed[sl]);
            for (const sl of ALLSLOTS) {
                if (used[sl] || lockedSlot(sl)) continue;
                let bp = -1, bt = null;
                const bak = eq[sl];
                for (const t of fullPool[sl]) {
                    if (seedItems.has(t)) continue;
                    eq[sl] = t; const p = meas(); eq[sl] = bak;
                    if (p > bp) { bp = p; bt = t }
                }
                if (bt) seed[sl] = bt;
            }
            const r = hillClimb(seed, 8);
            if (r.p > bestP) { bestP = r.p; bestCfg = r.cfg }
        }
        const mode = C.setScanMode || 'full';
        if (mode === 'full' || mode === 'deep') {
            const mixGrps = [];
            for (const g in grps) {
                const bySlot = {}; ALLSLOTS.forEach(s => bySlot[s] = []);
                for (const t of grps[g]) {
                    if (t.d === 3) { bySlot.ring1.push(t); bySlot.ring2.push(t) }
                    else { const sl = D2SLOT[t.d]; if (sl && bySlot[sl]) bySlot[sl].push(t) }
                }
                for (const sl in bySlot) bySlot[sl] = sortH(bySlot[sl]);
                let unique = 0; for (const sl of ALLSLOTS) if (bySlot[sl].length > 0) unique++;
                if (unique < 4) continue;
                const top4 = []; const takenSl = {};
                for (const sl of ALLSLOTS) {
                    if (bySlot[sl][0] && top4.length < 4 && !takenSl[sl]) { top4.push({ sl: sl, t: bySlot[sl][0] }); takenSl[sl] = true }
                }
                if (top4.length < 4) continue;
                for (const sl of ALLSLOTS) eq[sl] = origEq[sl];
                for (const it of top4) eq[it.sl] = it.t;
                const mixP = meas();
                for (const sl of ALLSLOTS) eq[sl] = origEq[sl];
                mixGrps.push({ g: g, top4: top4, mixP: mixP });
            }
            const filter = C.setMixFilterPct || 50;
            const minP = origP * filter / 100;
            const validGrps = mixGrps.filter(x => x.mixP >= minP).sort((a, b) => b.mixP - a.mixP);
            const maxPairs = C.setMixPairs || 20;
            const pairs = [];
            for (let i = 0; i < validGrps.length; i++) {
                for (let j = i + 1; j < validGrps.length; j++) {
                    pairs.push({ A: validGrps[i], B: validGrps[j] });
                    if (mode === 'full' && pairs.length >= maxPairs) break;
                }
                if (mode === 'full' && pairs.length >= maxPairs) break;
            }
            for (const pr of pairs) {
                const seed = {}; for (const sl of ALLSLOTS) seed[sl] = origEq[sl];
                const used = {};
                for (const it of pr.A.top4) {
                    if (lockedSlot(it.sl)) continue;
                    if (!used[it.sl]) { seed[it.sl] = it.t; used[it.sl] = true }
                }
                for (const it of pr.B.top4) {
                    if (lockedSlot(it.sl)) continue;
                    if (!used[it.sl]) { seed[it.sl] = it.t; used[it.sl] = true }
                }
                const seedItems = new Set();
                for (const sl of ALLSLOTS) if (used[sl]) seedItems.add(seed[sl]);
                for (const sl of ALLSLOTS) {
                    if (used[sl] || lockedSlot(sl)) continue;
                    let bp = -1, bt = null;
                    const bak = eq[sl];
                    for (const t of fullPool[sl]) {
                        if (seedItems.has(t)) continue;
                        eq[sl] = t; const p = meas(); eq[sl] = bak;
                        if (p > bp) { bp = p; bt = t }
                    }
                    if (bt) seed[sl] = bt;
                }
                const rounds = mode === 'deep' ? 8 : 4;
                const r = hillClimb(seed, rounds);
                if (r.p > bestP) { bestP = r.p; bestCfg = r.cfg }
            }
        }
        for (const sl of ALLSLOTS) eq[sl] = origEq[sl];
        const elapsed = Date.now() - t0;
        const intervalMs = (+C.setIntervalSec || 60) * 1000;
        if (elapsed > intervalMs * 0.5) console.log('%c[VL SET] CẢNH BÁO: ' + elapsed + 'ms / ' + intervalMs + 'ms > 50%. Giảm mode hoặc tăng interval', 'color:#fc6');
        const swaps = [];
        for (const sl of ALLSLOTS) {
            if (origEq[sl] !== bestCfg[sl]) swaps.push({ slot: sl, old: origEq[sl], new: bestCfg[sl], delta: 0 });
        }
        if (!swaps.length) { S.setLog = 'Đã tối ưu (' + fmt(origP) + ') [' + elapsed + 'ms]'; return }
        const totalDelta = bestP - origP;
        const totalPct = totalDelta / origP * 100;
        const userThr = +C.setThreshold || 2;
        if (totalPct < userThr) { S.setLog = 'Cải thiện ' + totalPct.toFixed(2) + '% < ngưỡng ' + userThr + '% [' + elapsed + 'ms]'; return }
        const changes = swaps.map(s => ({
            slot: s.slot,
            old: s.old ? { n: s.old.n, r: s.old.r, grp: s.old.set?.grp, mag: s.old.mag?.length, lvl: s.old.lvl, enh: s.old.enh } : null,
            new: { n: s.new.n, r: s.new.r, grp: s.new.set?.grp, mag: s.new.mag?.length, lvl: s.new.lvl, enh: s.new.enh }
        }));
        const entry = { t: now, powerBefore: origP, powerAfter: bestP, delta: totalDelta, pct: totalPct, changes: changes, dry: !!C.setDryRun, mode: mode };
        S.setHistory.unshift(entry);
        S.setHistory = S.setHistory.slice(0, 10);
        if (C.setDryRun) { S.setLog = '[MÔ PHỎNG] +' + fmt(totalDelta) + ' (+' + totalPct.toFixed(1) + '%) ' + swaps.length + ' swap [' + elapsed + 'ms]'; return }
        for (const sl of ALLSLOTS) {
            const newIt = bestCfg[sl];
            if (eq[sl] === newIt) continue;
            if (newIt) { const i = inv.indexOf(newIt); if (i >= 0) inv.splice(i, 1) }
            if (eq[sl]) { eq[sl].vlOld = 1; inv.push(eq[sl]) }
            eq[sl] = newIt;
        }
        S.lastSetSwap = now;
        S.setLog = '+' + fmt(totalDelta) + ' (+' + totalPct.toFixed(1) + '%) ' + swaps.length + ' swap [' + elapsed + 'ms]';
        console.log('%c[VL SET] ' + fmt(origP) + ' -> ' + fmt(bestP) + ' (+' + totalPct.toFixed(1) + '%) ' + swaps.length + ' swap [' + elapsed + 'ms] mode=' + mode, 'color:#8f8');
        dirty();
    }
    function eqTick() {
        if (!canEval()) return;
        eqFreeSlots();
    }
    function bagTick(force) {
        if (!X || !X.ws || !Array.isArray(X.ws.inv)) return;
        S.bagTickRuns = (S.bagTickRuns || 0) + 1; S.lastBagTick = Date.now();
        let free = cap() - X.ws.inv.length, ch = 0;
        if (free >= C.free && !force) { S.short = 0; return }
        if (C.autoEquip) eqTick();
        if (C.gameSell && X.lc && cap() - X.ws.inv.length < C.free) { const r = X.lc(); if (r && r.n) { const __g = +(r.g || r.gold) || 0; S.sold += r.n; S.gold += __g; S.gameSellCount += r.n; S.gameSellGold += __g; pushEvent('sell', 'gameSell ' + r.n + ' món +' + fmt(__g)) } }
        free = cap() - X.ws.inv.length;
        if (free < C.free && C.toFb) {
            const fb = fbArr(), fc = fbCap();
            for (const t of X.ws.inv.slice()) {
                if (free >= C.free || fb.length >= fc) break;
                if (!why(t, false) && isMat(t)) { rm(t, X.ws.inv); fb.push(t); free++; S.toFb++; ch++ }
            }
        }
        for (const rare of [false, true]) {
            if (free >= C.free || (rare && !C.sellRare)) break;
            const L = X.ws.inv.filter(t => !why(t, rare)).sort((a, b) => (a.r || 0) - (b.r || 0) || val(a) - val(b));
            let __sellN = 0, __sellGold = 0;
            for (const t of L) { if (free >= C.free) break; const __g = sell(t, X.ws.inv); S.gold += __g; S.sold++; __sellN++; __sellGold += __g; const __r = Math.min(4, (t.r || 0)); S.sellByRarity[__r] = (S.sellByRarity[__r] || 0) + 1; free++; ch++ }
            if (__sellN > 0) { S.scriptSellCount += __sellN; S.scriptSellGold += __sellGold; pushEvent('sell', 'script bán ' + __sellN + ' món +' + fmt(__sellGold)) }
        }
        S.short = Math.max(0, C.free - free); if (ch) dirty();
    }
    window.__vlBagTick = bagTick;
    function fbTick() {
        if (C.fbRun && X.Ru && X.ws.autoForge) { try { X.Ru(); S.fbRunCount = (S.fbRunCount || 0) + 1; S.lastFbTick = Date.now() } catch (e) { } }
        let ch = 0;
        if (C.fbExt && X.Ue && X.Ze) {
            for (const t of fbArr().filter(t => { try { return X.Ue(t) } catch (e) { return false } })) {
                const r = X.Ze(t); if (!r || !r.ok) break; S.ext++; ch++
            }
        }
        const fb = fbArr(), keep = t => t.lock || t.enh > 0 || t.vio || t.set || (t.r === 0 && (t.mag || []).length);
        const byLv = (a, b) => (b.lvl || 0) - (a.lvl || 0), sl = t => { S.fbGold += sell(t, fb); S.fbSold++; ch++ };
        fb.filter(t => t.r === 0 && !keep(t)).sort(byLv).slice(Math.max(0, C.fbWhiteKeep | 0)).forEach(sl);
        if (X.Ee) fb.filter(t => X.Ee.includes(t.d) && t.r > 0 && !keep(t)).sort(byLv).slice(Math.max(0, C.fbJew | 0)).forEach(sl);
        if (fb.length > C.fbMax) {
            const L = fb.filter(t => !keep(t) && (t.r || 0) < C.keepRar).sort((a, b) => (a.r || 0) - (b.r || 0) || val(a) - val(b));
            for (const t of L) { if (fb.length <= C.fbMax) break; sl(t) }
        }
        if (ch) dirty();
    }

    /* ===== 6. CHUYỂN SINH ===== */
    function rebirthTick() {
        if (!C.rebirthOn) return;
        if (typeof window.__vlRbGet !== 'function') { S.rebirthErr = 'API chưa có'; return }
        const st = window.__vlRbGet();
        if (!st || st.err) { S.rebirthErr = st ? st.err : 'no state'; return }
        if (!st.ready) { S.rebirthErr = ''; S.pendingRebirth = 0; return }
        const wi = X && X.wi;
        if (wi && wi.tower) {
            if (!S.pendingRebirth) S.pendingRebirth = Date.now();
            if (typeof window.__vlTowerExit === 'function') try { window.__vlTowerExit() } catch (e) { }
        }
        if (S.pendingRebirth) {
            const el = Date.now() - S.pendingRebirth;
            if (el < 3000) { S.rebirthErr = '⏳ chờ thoát tháp để CS (' + Math.ceil((3000 - el) / 1000) + 's)'; return }
            if (X && X.wi && X.wi.tower) { S.rebirthErr = '⚠ không thoát được tháp để CS'; return }
        }
        S.rebirthErr = '';
        if (Date.now() - S.rebirthLast < Math.max(2, +C.rebirthDelay || 5) * 1000) return;
        const r = window.__vlRbDo(false);
        S.pendingRebirth = 0;
        if (r && r.ok) {
            S.rebirthCnt++; S.rebirthLast = Date.now();
            console.log('%c[VL RB] chuyển sinh lần ' + r.reborn + ' → ải ' + r.stage, 'color:#f0f;font-weight:bold')
        }
        else if (r && r.msg) S.rebirthErr = r.msg;
    }

    /* ===== 6b. TỰ BƠM MÁU + CỘNG TIỀM NĂNG ===== */
    function hpPotTick() {
        if (!C.hpPotOn) return;
        if (!X || !X.wi) return;
        try {
            const hp = +X.ev('Ci.life') || 0;
            const hpMax = +X.ev('Ci.P.life') || 1;
            const pct = hpMax > 0 ? hp / hpMax * 100 : 100;
            if (pct >= C.hpPotPct) return;
            const cd = +X.ev('(Ci.potCd||{}).life') || 0;
            if (cd > 0) return;
            let ok = false;
            try { if (typeof window.Lr === 'function') { window.Lr('life'); ok = true; } } catch (e) { }
            if (!ok) {
                const btn = document.querySelector('#bHp');
                if (btn) { btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true })); ok = true; }
            }
        } catch (e) { S.err = 'bơm máu: ' + e.message; }
    }
    function mpPotTick() {
        if (!C.mpPotOn) return;
        if (!X || !X.wi) return;
        try {
            const mp = +X.ev('Ci.mana') || 0;
            const mpMax = +X.ev('Ci.P.mana') || 1;
            const pct = mpMax > 0 ? mp / mpMax * 100 : 100;
            if (pct >= C.mpPotPct) return;
            const cd = +X.ev('(Ci.potCd||{}).mana') || 0;
            if (cd > 0) return;
            let ok = false;
            try { if (typeof window.Lr === 'function') { window.Lr('mana'); ok = true; } } catch (e) { }
            if (!ok) {
                const btn = document.querySelector('#bMp') || document.querySelector('#bMana');
                if (btn) { btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true })); ok = true; }
            }
        } catch (e) { S.err = 'bơm mana: ' + e.message; }
    }
    function potTick() {
        if (!X || !X.wi) return;
        const ws = X.ws;
        if (!ws || !ws.attr) return;
        const markDirty = () => { try { X.wi.dirty = true; } catch (e) { try { X.ev('Ci.dirty=true'); } catch (_) { } } };
        try {
            if (C.potStrict && !S.needWash) {
                const tgs = { str: +C.potStr || 0, dex: +C.potDex || 0, vit: +C.potVit || 0, eng: +C.potEng || 0 };
                const cur = { str: +ws.attr.str || 0, dex: +ws.attr.dex || 0, vit: +ws.attr.vit || 0, eng: +ws.attr.eng || 0 };
                const attrPts = +ws.attrPts || 0;
                const curSum = cur.str + cur.dex + cur.vit + cur.eng;
                const totalAvail = attrPts + curSum;
                const sumTgt = tgs.str + tgs.dex + tgs.vit + tgs.eng;
                if (sumTgt > 0 && sumTgt <= totalAvail) {
                    let needFix = false;
                    for (const k in tgs) {
                        if (cur[k] < tgs[k]) { needFix = true; break; }
                    }
                    if (needFix) {
                        S.needWash = true;
                        console.log('%c[VL STRICT] có stat < target → wash + cộng lại theo ưu tiên', 'color:#fc6');
                    }
                }
            }
            if (S.needWash) {
                const cur = { str: +ws.attr.str || 0, dex: +ws.attr.dex || 0, vit: +ws.attr.vit || 0, eng: +ws.attr.eng || 0 };
                const total = cur.str + cur.dex + cur.vit + cur.eng;
                if (total > 0) {
                    ws.attrPts = (ws.attrPts || 0) + total;
                    ws.attr.str = 0; ws.attr.dex = 0; ws.attr.vit = 0; ws.attr.eng = 0;
                    markDirty();
                    console.log('%c[VL WASH] tẩy ' + total + ' điểm tiềm năng về pool', 'color:#fc6');
                }
                S.needWash = false;
                S.lastWash = Date.now();
            }
            const attrPts = +ws.attrPts || 0;
            if (attrPts <= 0) return;
            const prio = [
                { k: 'str', tgt: +C.potStr || 0 },
                { k: 'dex', tgt: +C.potDex || 0 },
                { k: 'vit', tgt: +C.potVit || 0 },
                { k: 'eng', tgt: +C.potEng || 0 }
            ];
            let remaining = attrPts, added = false;
            for (const p of prio) {
                if (remaining <= 0) break;
                const cur = +ws.attr[p.k] || 0;
                const need = Math.max(0, p.tgt - cur);
                if (need <= 0) continue;
                const add = Math.min(need, remaining);
                if (add > 0) {
                    ws.attr[p.k] = cur + add;
                    ws.attrPts = (ws.attrPts || 0) - add;
                    markDirty();
                    remaining -= add; added = true;
                }
            }
            if (remaining > 0) {
                if (C.potRem === 'dt') {
                    try { X.ev('dn()'); } catch (e) { S.err = 'dn: ' + e.message; }
                } else if (C.potRem === 'even') {
                    const per = Math.floor(remaining / 4);
                    const rem = remaining - per * 4;
                    const aS = per + (rem > 0 ? 1 : 0);
                    const aD = per + (rem > 1 ? 1 : 0);
                    const aV = per + (rem > 2 ? 1 : 0);
                    const aE = per;
                    if (aS > 0) { ws.attr.str = (+ws.attr.str || 0) + aS; ws.attrPts = (ws.attrPts || 0) - aS; }
                    if (aD > 0) { ws.attr.dex = (+ws.attr.dex || 0) + aD; ws.attrPts = (ws.attrPts || 0) - aD; }
                    if (aV > 0) { ws.attr.vit = (+ws.attr.vit || 0) + aV; ws.attrPts = (ws.attrPts || 0) - aV; }
                    if (aE > 0) { ws.attr.eng = (+ws.attr.eng || 0) + aE; ws.attrPts = (ws.attrPts || 0) - aE; }
                    markDirty();
                }
            }
            if (added) {
                markDirty();
                console.log('%c[VL POT] cộng xong · còn ' + Math.max(0, remaining), 'color:#fc6');
            }
        } catch (e) { S.err = 'tiềm năng: ' + e.message; }
    }

    /* ===== 7. THÁP I/II ===== */
    function twRangedHook() {
        const NH = M.N || {};
        if (!X || !X.ev || !NH.cast) return null;
        if (window.__vlRaHkInstalled) {
            try { const v = X.ev(NH.cast + '===window.__vlRaHk'); if (v === true) return 'already' } catch (e) { }
            window.__vlRaHkInstalled = false;
        }
        try { const v2 = X.ev('(typeof window.__vlRaHk==="function")&&(' + NH.cast + '===window.__vlRaHk)'); if (v2 === true) { window.__vlRaHkInstalled = true; return 'already' } } catch (e) { }
        try {
            const reassignOk = X.ev('(function(){try{var o=' + NH.cast + ';var t=function(){return o.apply(this,arguments)};' + NH.cast + '=t;var ok=' + NH.cast + '===t;' + NH.cast + '=o;return ok}catch(e){return "ERR:"+e.message}})()');
            if (reassignOk !== true) { console.log('%c[VL HOOK] ✗ không reassign được ' + NH.cast + ': ' + reassignOk, 'color:#f66'); return 'err: cannot reassign ' + NH.cast + ': ' + reassignOk }
            const code = 'var o=' + NH.cast + ';if(typeof o!=="function"){throw new Error("not func")}window.__vlOrigRa=o;window.__vlRaHk=function(skill,primary,allTargets){try{var __tw=window.__vlTW;var __cfg=(__tw&&__tw.C)||{};if((__cfg.rangedPrio||__cfg.meleeTelePrio)&&Ci.tower&&!Ci.deadT&&allTargets&&allTargets.length>0){var __pos=(typeof qi!=="undefined")?qi:null;if(__pos&&skill){var __maxR=400;try{if(typeof aa!=="undefined"&&skill.range&&aa[skill.range])__maxR=aa[skill.range]}catch(e){}var __yh=10;try{if(__tw&&__tw.yh)__yh=+__tw.yh()||10}catch(e){}var __thr=Math.max(4,__yh-3);var __best=null,__bs=1e9,__bm=null,__bmS=1e9;for(var __i=0;__i<allTargets.length;__i++){var __en=allTargets[__i];if(!__en||__en.dead||__en.hp<=0)continue;var __dd=Math.hypot(__en.x-__pos.x,__en.y-__pos.y);if(__dd>__maxR||__dd>320)continue;var __hpPct=__en.max?__en.hp/__en.max:1;var __farT=+__en.farT||0;if(__cfg.rangedPrio&&__en.ranged){var __sc=__dd+__hpPct*100-__farT*20;if(__sc<__bs){__best=__en;__bs=__sc}}if(__cfg.meleeTelePrio&&!__en.ranged&&__farT>=__thr){var __scM=__dd+__hpPct*100-__farT*40;if(__scM<__bmS){__bm=__en;__bmS=__scM}}}if(__bm&&primary!==__bm){__tw.rpMeleeC=(__tw.rpMeleeC||0)+1;__tw.rpMeleeLast={d:Math.round(Math.hypot(__bm.x-__pos.x,__bm.y-__pos.y)),hp:Math.round(__bm.hp),farT:+(__bm.farT||0).toFixed(1)};return o.call(this,skill,__bm,allTargets)}if(__best&&!__bm&&(!primary||!primary.ranged)&&primary!==__best){__tw.rpC=(__tw.rpC||0)+1;__tw.rpLast={d:Math.round(Math.hypot(__best.x-__pos.x,__best.y-__pos.y)),hp:Math.round(__best.hp),farT:+(__best.farT||0).toFixed(1)};return o.call(this,skill,__best,allTargets)}}}}catch(ex){if(window.__vlTW)window.__vlTW.rpErr=ex.message}return o.apply(this,arguments)};' + NH.cast + '=window.__vlRaHk;window.__vlRaHkInstalled=' + NH.cast + '===window.__vlRaHk;';
            X.ev(code);
            return window.__vlRaHkInstalled ? 'ok' : 'fail';
        } catch (e) { return 'err: ' + e.message }
    }
    function twAiHook() {
        const NH = M.N || {};
        if (!X || !X.ev || !NH.ai) return 'no_ai';
        if (window.__vlAiHkInstalled) {
            try { const v = X.ev(NH.ai + '===window.__vlLaHk'); if (v === true) return 'already' } catch (e) { }
            window.__vlAiHkInstalled = false;
        }
        try {
            const reassignOk = X.ev('(function(){try{var o=' + NH.ai + ';var t=function(){return o.apply(this,arguments)};' + NH.ai + '=t;var ok=' + NH.ai + '===t;' + NH.ai + '=o;return ok}catch(e){return "ERR:"+e.message}})()');
            if (reassignOk !== true) { console.log('%c[VL HOOK] ✗ không reassign được ' + NH.ai + ': ' + reassignOk, 'color:#f66'); return 'err: cannot reassign ' + NH.ai + ': ' + reassignOk }
            const code = 'var o=' + NH.ai + ';if(typeof o!=="function"){throw new Error("not func")}window.__vlOrigLa=o;window.__vlLaHk=function(){try{var __tw=window.__vlTW;var __cfg=(__tw&&__tw.C)||{};if((__cfg.rangedPrio||__cfg.meleeTelePrio)&&Ci.tower&&!Ci.deadT&&Ci.enemies&&Ci.enemies.length){var __pos=(typeof qi!=="undefined")?qi:null;if(__pos){var __best=null,__bs=1e9;for(var __i=0;__i<Ci.enemies.length;__i++){var __en=Ci.enemies[__i];if(!__en||__en.dead||__en.hp<=0||!__en.ranged)continue;var __dd=Math.hypot(__en.x-__pos.x,__en.y-__pos.y);if(__dd>320)continue;var __hpPct=__en.max?__en.hp/__en.max:1;var __farT=+__en.farT||0;var __sc=__dd+__hpPct*100-__farT*20;if(__sc<__bs){__best=__en;__bs=__sc}}if(__best&&Ci.meleeTg!==__best){Ci.meleeTg=__best;__tw.rpC=(__tw.rpC||0)+1;__tw.rpLast={d:Math.round(Math.hypot(__best.x-__pos.x,__best.y-__pos.y)),hp:Math.round(__best.hp),farT:+(__best.farT||0).toFixed(1)}}}}}catch(e){}return o.apply(this,arguments)};' + NH.ai + '=window.__vlLaHk;window.__vlAiHkInstalled=' + NH.ai + '===window.__vlLaHk;';
            X.ev(code);
            const ok = X.ev('window.__vlAiHkInstalled===true');
            if (ok === true) { console.log('%c[VL HOOK] ✓ la hook OK · ai=' + NH.ai, 'color:#8f8'); return 'ok' }
            return 'fail: la=' + X.ev('typeof window.__vlLaHk');
        } catch (e) { return 'err: ' + e.message }
    }
    function twInstall() {
        const T0 = window.__vlTW;
        if (T0 && T0.ready) {
            T0.C = C;
            if (!T0._rehk || Date.now() - T0._rehk > 2000) {
                T0._rehk = Date.now();
                try {
                    const r1 = twRangedHook();
                    if (r1 === 'ok') console.log('%c[VL HOOK] cài lại ra hook', 'color:#8f8');
                    else if (r1 && r1 !== 'already' && typeof r1 === 'string' && r1.indexOf('err') === 0) S.twErr = 'ra: ' + r1;
                    const r2 = twAiHook();
                    if (r2 === 'ok') console.log('%c[VL HOOK] cài lại la hook', 'color:#8f8');
                    else if (r2 && r2 !== 'already' && typeof r2 === 'string' && r2.indexOf('err') === 0) S.twErr = (S.twErr || '') + ' ai: ' + r2;
                } catch (e) { S.twErr = 'rehook: ' + e.message }
            }
            return T0
        }
        if (!X || !X.ev) return null;
        try { X.ev(twCore()) } catch (e) { S.twErr = 'cài tháp: ' + e.message; return null }
        try { twRangedHook() } catch (e) { S.twErr = 'cài hook ranged: ' + e.message }
        try { twAiHook() } catch (e) { S.twErr = (S.twErr || '') + ' cài hook ai: ' + e.message }
        const T = window.__vlTW; if (T && T.ready) { T.C = C; return T }
        return null
    }
    function twTrack(ti) {
        if (!ti) return;
        const k = ti.tower ? (ti.two ? 2 : 1) : 0;
        if (k) S.twFloor = ti.floor;
        if (S.twWas && !k && ti.dead) {
            if (S.twWas === 1) S.twDie1++;
            else if (S.twWas === 2) S.twDie2++;
            console.log('%c[VL THÁP] gục ở Tháp ' + (S.twWas === 1 ? 'I' : 'II') + ' tầng ' + S.twFloor, 'color:#f66')
        }
        S.twWas = k
    }
    function twTick(ti, T, mode) {
        if (S.pendingRebirth) { S.twMsg = '⏳ chờ chuyển sinh xong mới vào tháp'; return }
        if (!ti || !T) { S.twMsg = '⚠ chưa đọc được tháp'; return }
        if (ti.dead) { S.twMsg = '💀 đang trọng thương'; return }
        if (ti.hp < Math.min(100, +C.twReHp || 0)) { S.twMsg = '⏳ hồi máu ' + Math.round(ti.hp) + '% trước khi vào'; return }
        const now = Date.now();
        if (now - S.twLast < 5000) return;
        if (mode === 't2') {
            if (ti.t2Left != null && ti.t2Left <= 0) { S.twMsg = '↩ Tháp II hết lượt hôm nay'; return }
            if (ti.t2Need != null && ti.rb < ti.t2Need) { S.twMsg = '⚠ cần chuyển sinh ' + ti.t2Need + ' để vào Tháp II'; return }
            S.twLast = now;
            if (!T.enter2) { S.twMsg = '⚠ chưa có hàm vào Tháp II'; return }
            const g = T.enter2();
            if (g === 'ok') { S.twEnter++; S.twMsg = '▶ vào Tháp II'; console.log('%c[VL THÁP] vào Tháp II', 'color:#fc6') }
            else if (g === 'clicked') S.twMsg = '… đã bấm vào Tháp II';
            else S.twMsg = '⚠ Tháp II: ' + g;
            return;
        }
        if (ti.cd1 > 0) { S.twMsg = '⏳ vào lại Tháp I sau ' + Math.ceil(ti.cd1 / 1e3) + 's'; return }
        S.twLast = now;
        const r = typeof window.__vlTowerEnter === 'function' ? window.__vlTowerEnter() : { ok: false, msg: 'chưa có API vào tháp' };
        if (r && r.ok) { S.twEnter++; S.twMsg = '▶ vào Tháp I'; console.log('%c[VL THÁP] vào Tháp I', 'color:#fc6') }
        else S.twMsg = '⚠ Tháp I: ' + ((r && r.msg) || 'lỗi')
    }

    /* ===== 8. ĐIỀU PHỐI ===== */
    function flowTick() {
        if (!C.actEnabled) {
            S.twMsg = '⛔ Auto Hoạt động đang TẮT';
            return;
        }
        try { rebirthTick() } catch (e) { S.rebirthErr = 'CS: ' + e.message }
        const T = twInstall(), ti = T ? T.info() : null;
        const wi = X && X.wi;
        const want = C.actMode || 'push';
        let eff = want;
        if (want === 't2' && ti) {
            const out = (ti.t2Left != null && ti.t2Left <= 0) || (ti.t2Need != null && ti.rb < ti.t2Need);
            if (out) eff = (C.t2End === 'push') ? 'push' : 't1';
        }
        S.twInfo = ti;
        if (eff !== S.lastEff) {
            const L = { push: 'Push ải', t1: 'Tháp I', t2: 'Tháp II' };
            if (S.lastEff) console.log('%c[VL MODE] ' + L[S.lastEff] + ' → ' + L[eff] + (want !== eff ? ' (fallback từ ' + L[want] + ')' : ''), 'color:' + (eff === 'push' ? '#fc6' : '#8f8'));
            S.pushTriggered = false;
            S.lastEff = eff;
        }
        if (wi && wi.tower) {
            const inT2 = !!wi.tower.two;
            const mismatch = (eff === 'push') || (eff === 't1' && inT2) || (eff === 't2' && !inT2);
            if (mismatch) {
                const now = Date.now();
                if (now - S.exitAt > 1000 && S.exitFail < 5) {
                    S.exitAt = now; S.exitFail++;
                    if (typeof window.__vlTowerExit === 'function') try { window.__vlTowerExit() } catch (e) { }
                    console.log('%c[VL MODE] thoát tháp → chuyển sang ' + ({ push: 'Push ải', t1: 'Tháp I', t2: 'Tháp II' }[eff] || eff), 'color:#fc6');
                }
                const L = { push: 'Push ải', t1: 'Tháp I', t2: 'Tháp II' };
                S.twMsg = S.exitFail >= 5 ? '⚠ không thoát được tháp — bấm "Rời tháp" thủ công' : ('🚪 đang thoát tháp để chuyển sang ' + (L[eff] || eff) + (S.exitFail ? ' (lần ' + S.exitFail + '/5)' : ''));
                return;
            }
            S.exitFail = 0;
        }
        const am = eff;
        if (am === 'push') {
            if (!S.pushTriggered || Date.now() - (S.lastPushCheck || 0) > 3000) {
                S.pushTriggered = true;
                S.lastPushCheck = Date.now();
                if (typeof window.__vlPushGet === 'function' && typeof window.__vlPushSet === 'function') {
                    try {
                        var ps = window.__vlPushGet();
                        if (ps && (!ps.push || ps.stage < ps.maxStage)) {
                            window.__vlPushSet(true, true);
                            console.log('%c[VL PUSH] tự động ép ải max + push (stage ' + ps.stage + ' → ' + ps.maxStage + ')', 'color:#fc6');
                        }
                    } catch (e) { }
                }
            }
            S.twMsg = '🚀 Push ải max (Tự động)';
            return;
        }
        if (am !== 't1' && am !== 't2') return;
        try { twTrack(ti) } catch (e) { S.twErr = e.message }
        if (!ti || !ti.tower) {
            try { twTick(ti, T, am) } catch (e) { S.twMsg = 'lỗi: ' + e.message }
        }
    }

    /* ===== 9. VÒNG LẶP AUTO MAIN ===== */
    setInterval(() => {
        if (!X) { X = window.__VLX || null; if (!X) { stat(); return } }
        tk++; let ws = null; try { ws = X.ws } catch (e) { }
        if (!ws || !ws.fac || !Array.isArray(ws.inv)) { if (tk % 2 === 0) stat(); return }
        const run = (on, sec, name, f) => { if (!on || tk % Math.max(1, sec | 0)) return; try { f() } catch (e) { S.err = name + ': ' + e.message } };
        run(true, C.eqSec, 'mặc đồ', eqTick);
        run(C.bagOn, C.bagSec, 'túi', () => bagTick(false));
        run(C.fbOn, C.fbSec, 'kho rèn', fbTick);
        try { hpPotTick() } catch (e) { S.err = 'bơm máu: ' + e.message }
        try { mpPotTick() } catch (e) { S.err = 'bơm mana: ' + e.message }
        try { flowTick() } catch (e) { S.err = 'điều phối: ' + e.message }
        run(C.potOn, +C.potSec || 5, 'tiềm năng', potTick);
        try { detectSetsTick() } catch (e) { S.err = 'set: ' + e.message }

        stat();
    }, 1000);

    /* ===== 6. THÀNH PHẦN GIAO DIỆN CHUẨN MENU DỌC (6 TAB AUTO) ===== */
    let handBtn = null, menuDock = null, box = null, B = null, SH = null, INFO = null;
    let menuOpen = false;

    const MENU_ITEMS = [
        { id: 'act', title: '⚔ Hoạt động' },
        { id: 'bag', title: '🎒 Túi' },
        { id: 'pot', title: '⚡ Tiềm năng' },
        { id: 'speed', title: '⚡ Speed' },
        { id: 'speedhn', title: '🐎 Speed HN' },
        { id: 'event', title: '🎁 Event' },
        { id: 'wash', title: '✨ Tẩy luyện' },
        { id: 'nsmod', title: '🛡️ Ns Mod' },
        { id: 'reset', title: '🔄 Reset' },
        { id: 'update', title: '🔄 Cập nhật Auto' }
    ];

    const BCSS = 'background:#333;color:#eee;border:1px solid #666;border-radius:3px;cursor:pointer;';
    const LCSS = 'display:flex;justify-content:space-between;align-items:center;margin:2px 0;gap:4px';
    const ICSS = 'width:64px;background:#222;color:#eee;border:1px solid #555';

    function whenBody(f) { if (document.body) f(); else document.addEventListener('DOMContentLoaded', f) }
    function el(tag, p) {
        const e = document.createElement(tag);
        if (p) for (const k in p) { const v = p[k]; if (k === 'css') e.style.cssText = v; else if (k === 'text') e.textContent = v; else if (k === 'on') e.onclick = v; else e[k] = v }
        for (let i = 2; i < arguments.length; i++) { const c = arguments[i]; if (c != null && c !== '') e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c) }
        return e
    }

    function fN(k, l, mx) {
        const i = el('input', { type: 'number', min: 0, step: 'any', value: C[k], css: ICSS }); if (mx != null) i.max = mx;
        i.oninput = i.onchange = () => { C[k] = +i.value || 0; save() }; return el('label', { css: LCSS }, l, i)
    }
    function fB(k, l) { const i = el('input', { type: 'checkbox', checked: !!C[k] }); i.onchange = () => { C[k] = i.checked; save() }; return el('label', { css: LCSS }, l, i) }
    function fS(k, l, opts) {
        const s = el('select', { css: 'background:#222;color:#eee;border:1px solid #555' });
        for (const [v, t] of opts) { const o = el('option', { value: v, text: t }); if (C[k] === v) o.selected = true; s.appendChild(o) }
        s.onchange = () => { C[k] = s.value; save() }; return el('label', { css: LCSS }, l, s)
    }
    function btn(t, f, style) { return el('button', { text: t, css: BCSS + (style || '') + 'margin:3px 3px 0 0;padding:2px 6px', on: () => { try { f() } catch (e) { S.err = e.message } stat(); setTimeout(draw, 300) } }) }
    const note = t => el('div', { text: t, css: 'color:#9cf;margin:3px 0;white-space:pre-wrap' });
    const hdr = t => el('div', { text: t, css: 'color:#fc6;font-weight:bold;margin:6px 0 3px;border-bottom:1px solid #333' });

    function getT2Data() {
        try {
            if (window.__VLX && typeof window.__VLX.xr === 'function') {
                const data = window.__VLX.xr();
                if (data && data.t2) return data.t2;
                if (data && data.rw && data.rw.t2) return data.rw.t2;
            }
            if (window.Ns && window.Ns.rw && window.Ns.rw.t2) return window.Ns.rw.t2;
        } catch (e) { }
        return null;
    }

    function doResetThap2() {
        const t2 = getT2Data();
        if (!t2) {
            console.warn('[Auto Reset] Chưa lấy được dữ liệu Tháp 2.');
            return false;
        }
        try {
            t2.cur = 0;
            t2.best = 1;
            t2.runs = 0;
            try { if (window.Ci) window.Ci.dirty = true; } catch (e) { }
            return true;
        } catch (e) {
            console.warn('[Auto Reset] Không thể reset Tháp 2:', e);
            return false;
        }
    }
    window.doResetThap2 = doResetThap2;

    // Lấy đối tượng Ns do game khởi tạo; hỗ trợ cả biến Ns dạng lexical.
    function getNsForReset() {
        try {
            let ns = null;
            if (typeof window.__vltkGetNs === 'function') ns = window.__vltkGetNs();
            if (!ns && window.Ns) ns = window.Ns;
            if (ns && typeof ns === 'object') {
                window.Ns = ns;
                return ns;
            }
        } catch (e) {
            console.warn('[Auto Reset] Không đọc được Ns:', e);
        }
        return null;
    }

    // Lấy đúng đối tượng Ns.war do game khởi tạo.
    function getNsWarForReset() {
        const ns = getNsForReset();
        if (ns && ns.war && typeof ns.war === 'object') {
            return { ns, war: ns.war };
        }
        return null;
    }

    // AUTO DÃ TẨU: xử lý tuần tự, ẩn popup nhận EXP khi auto chạy và khôi phục khi dừng.
    // Thứ tự: hoàn thành task.have -> dựng popup ẩn -> bấm nút XP -> chờ game xác nhận.
    let daTauAutoBusy = false;
    let daTauAutoRunning = false;
    let daTauAutoTimer = null;
    let daTauAutoToken = 0;
    let daTauAutoCount = 0;
    let daTauAutoUI = null;
    let daTauPendingCancel = null;
    // Các popup Dã Tẩu được ẩn tạm khi Auto chạy; khôi phục lại khi người dùng bấm Dừng.
    let daTauHiddenQuestNodes = [];
    let daTauPopupGuardObserver = null;
    let daTauPopupGuardTimer = null;

    // Ẩn popup bằng visibility/opacity/pointer-events, không display:none.
    // Cách này giữ node và handler của nút EXP trong DOM để button.click() vẫn chạy.
    function daTauHideNode(node) {
        if (!node || !node.style) return;
        if (!daTauHiddenQuestNodes.some(item => item.node === node)) {
            daTauHiddenQuestNodes.push({
                node,
                visibility: node.style.getPropertyValue('visibility'),
                visibilityPriority: node.style.getPropertyPriority('visibility'),
                opacity: node.style.getPropertyValue('opacity'),
                opacityPriority: node.style.getPropertyPriority('opacity'),
                pointerEvents: node.style.getPropertyValue('pointer-events'),
                pointerEventsPriority: node.style.getPropertyPriority('pointer-events')
            });
        }
        node.style.setProperty('visibility', 'hidden', 'important');
        node.style.setProperty('opacity', '0', 'important');
        node.style.setProperty('pointer-events', 'none', 'important');
    }

    function daTauRestoreQuestPopup() {
        const saved = daTauHiddenQuestNodes.splice(0);
        saved.forEach(item => {
            const node = item.node;
            if (!node || !node.style) return;
            const restore = (name, value, priority) => {
                if (value) node.style.setProperty(name, value, priority || '');
                else node.style.removeProperty(name);
            };
            restore('visibility', item.visibility, item.visibilityPriority);
            restore('opacity', item.opacity, item.opacityPriority);
            restore('pointer-events', item.pointerEvents, item.pointerEventsPriority);
        });
    }

    function daTauNodeHasGameSurface(node) {
        if (!node || !node.querySelector) return false;
        try {
            if (node.matches && node.matches('canvas,video,iframe,#game,#game-container')) return true;
            if (node.querySelector('canvas,video,iframe,#game,#game-container')) return true;
            // Không ẩn nhầm một container đang chứa các tab chức năng chính.
            const controls = Array.from(node.querySelectorAll('button,a,[role="button"],[tabindex]'));
            const tabNames = /r\u01b0\u01a1ng|nh\u00e2n\s*v\u1eadt|k\u1ef9\s*n\u0103ng|inventory|character|skill/i;
            let tabCount = 0;
            for (const control of controls) {
                const label = String((control.innerText || control.textContent || '') + ' ' +
                    (control.getAttribute('aria-label') || '') + ' ' + (control.title || '')).trim();
                if (tabNames.test(label)) tabCount++;
                if (tabCount >= 2) return true;
            }
            return false;
        } catch (e) {
            return false;
        }
    }

    function daTauIsPopupSemantic(node) {
        if (!node || !node.matches) return false;
        try {
            if (node.matches('[role="dialog"],[aria-modal="true"]')) return true;
            const labels = [node.id || '', typeof node.className === 'string' ? node.className : ''];
            return labels.some(label => /(?:^|[\s_-])(?:qc[-_])?(?:modal|popup|dialog)(?:$|[\s_-])/i.test(label));
        } catch (e) {
            return false;
        }
    }

    function daTauFindPopupRoot(button) {
        const width = Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0);
        const height = Math.max(document.documentElement.clientHeight || 0, window.innerHeight || 0);
        const ancestors = [];
        for (let node = button.parentElement; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
            ancestors.push(node);
        }

        // Ưu tiên hộp thoại semantic gần nút XP nhất. Không chọn node chứa canvas,
        // game root hoặc các tab Rương/Nhân vật/Kỹ năng.
        for (const node of ancestors) {
            if (!daTauIsPopupSemantic(node) || daTauNodeHasGameSurface(node)) continue;
            const rect = node.getBoundingClientRect();
            if (rect.width >= 120 && rect.height >= 45) return node;
        }

        // Fallback: chọn phần tử positioned GẦN nút EXP nhất và nhỏ hơn game viewport.
        // Quan trọng: dừng ngay ở ứng viên đầu tiên, không tiếp tục đi lên để chọn
        // một ancestor lớn có thể bao trùm cả các tab chức năng của game.
        for (const node of ancestors) {
            if (daTauNodeHasGameSurface(node)) continue;
            const rect = node.getBoundingClientRect();
            const css = window.getComputedStyle(node);
            const positioned = css.position === 'fixed' || css.position === 'absolute';
            const reasonable = rect.width >= 150 && rect.height >= 65 &&
                rect.width < width * 0.94 && rect.height < height * 0.94 &&
                (rect.width * rect.height) < (width * height * 0.86);
            if (positioned && reasonable) return node;
        }

        // Fallback cuối chỉ quanh nút, không bao giờ chọn một root toàn màn hình.
        for (const node of ancestors.slice(0, 4)) {
            if (daTauNodeHasGameSurface(node)) continue;
            const rect = node.getBoundingClientRect();
            if (rect.width >= 100 && rect.height >= 40 &&
                rect.width < width * 0.88 && rect.height < height * 0.88) return node;
        }
        return null;
    }

    function daTauIsBackdropCandidate(node) {
        if (!node || !node.getBoundingClientRect || !node.style) return false;
        try {
            const rect = node.getBoundingClientRect();
            const css = window.getComputedStyle(node);
            const width = Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0);
            const height = Math.max(document.documentElement.clientHeight || 0, window.innerHeight || 0);
            const positioned = css.position === 'fixed' || css.position === 'absolute';
            const label = String((node.id || '') + ' ' +
                (typeof node.className === 'string' ? node.className : '')).toLowerCase();
            // Không xem mọi .overlay là backdrop. Chỉ chấp nhận tên lớp phủ rõ ràng
            // và thực sự phủ gần toàn màn hình.
            const named = /backdrop|scrim|modal[-_ ]?mask|popup[-_ ]?mask|mask-layer|shade|overlay/.test(label);
            const coversScreen = rect.width >= width * 0.82 && rect.height >= height * 0.76 &&
                rect.left <= width * 0.1 && rect.top <= height * 0.1 &&
                rect.right >= width * 0.9 && rect.bottom >= height * 0.9;
            if (!positioned || !named || !coversScreen) return false;
            if (daTauNodeHasGameSurface(node)) return false;
            return true;
        } catch (e) {
            return false;
        }
    }

    function daTauHideQuestPopup(button) {
        if (!daTauAutoRunning) return false;
        if (!button || !button.isConnected) {
            try { button = document.querySelector('button[data-qcp="xp"]'); } catch (e) { button = null; }
        }
        if (!button || !button.isConnected) return false;

        // Nếu nút đã nằm trong hộp thoại được ẩn, không chạy thuật toán lần nữa.
        // Tránh MutationObserver tự chọn nhầm ancestor khác sau khi style đổi.
        if (daTauHiddenQuestNodes.some(item => {
            try { return item.node && (item.node === button || item.node.contains(button)); }
            catch (e) { return false; }
        })) return true;

        const root = daTauFindPopupRoot(button);
        if (!root || root === document.body || root === document.documentElement) {
            console.warn('[Auto Dã Tẩu] Không tìm được khung popup đủ chắc chắn; bỏ qua ẩn để không khóa giao diện game.');
            return false;
        }

        const hideSet = new Set([root]);
        // Backdrop chỉ được nhận diện trong chuỗi anh em của popup, không tìm/ẩn
        // overlay bất kỳ trên toàn document vì có thể là lớp giao diện chính của game.
        let ancestor = root.parentElement;
        while (ancestor && ancestor !== document.documentElement) {
            for (const sibling of Array.from(ancestor.children || [])) {
                if (!sibling || sibling === root || sibling.contains(root) || sibling.contains(button)) continue;
                if (daTauIsBackdropCandidate(sibling)) hideSet.add(sibling);
            }
            if (ancestor === document.body) break;
            ancestor = ancestor.parentElement;
        }

        hideSet.forEach(node => {
            if (node !== document.body && node !== document.documentElement) daTauHideNode(node);
        });
        return true;
    }

    // Theo dõi toàn bộ thời gian Auto chạy. Một số game dựng lại popup sau khi nhận EXP;
    // observer này tiếp tục ẩn popup mới cho đến khi người chơi bấm Dừng.
    function daTauStartPopupGuard() {
        if (daTauPopupGuardObserver) {
            try { daTauPopupGuardObserver.disconnect(); } catch (e) { }
            daTauPopupGuardObserver = null;
        }
        if (daTauPopupGuardTimer) {
            clearInterval(daTauPopupGuardTimer);
            daTauPopupGuardTimer = null;
        }
        const apply = () => {
            if (!daTauAutoRunning) return;
            try { daTauHideQuestPopup(); } catch (e) { }
        };
        try {
            if (document.documentElement) {
                daTauPopupGuardObserver = new MutationObserver(apply);
                daTauPopupGuardObserver.observe(document.documentElement, {
                    childList: true, subtree: true, attributes: true,
                    attributeFilter: ['class', 'style', 'aria-hidden', 'aria-modal', 'data-qcp']
                });
            }
        } catch (e) { daTauPopupGuardObserver = null; }
        daTauPopupGuardTimer = setInterval(apply, 120);
        apply();
    }

    function daTauStopPopupGuard() {
        if (daTauPopupGuardObserver) {
            try { daTauPopupGuardObserver.disconnect(); } catch (e) { }
            daTauPopupGuardObserver = null;
        }
        if (daTauPopupGuardTimer) {
            clearInterval(daTauPopupGuardTimer);
            daTauPopupGuardTimer = null;
        }
    }

    function daTauGetVisibleAction(labelList) {
        const normalize = value => String(value || '')
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/\s+/g, ' ')
            .replace(/[：:]/g, '')
            .trim();
        const wanted = new Set(labelList.map(normalize));
        const selector = 'button,a,[role="button"],[tabindex],[aria-label],[title],div,span';
        const blocked = '#vlm8,#vltk-ns-panel,#vlHandBtn,#vlMenuDock,#vlm-update-notice,#vltk-ns-open-wrapper';
        const found = [];
        try {
            document.querySelectorAll(selector).forEach(node => {
                if (!node || !node.isConnected || (node.closest && node.closest(blocked))) return;
                const r = node.getBoundingClientRect();
                if (!r || r.width < 2 || r.height < 2 || !node.getClientRects().length) return;
                const cs = window.getComputedStyle ? window.getComputedStyle(node) : null;
                if (cs && (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0)) return;
                const rawText = (node.innerText || node.textContent || '').trim();
                const rawLabel = node.getAttribute('aria-label') || node.getAttribute('title') || '';
                const txt = normalize(rawText);
                const aria = normalize(rawLabel);
                const containsDauTau = (wanted.has('da tau') || wanted.has('nhiem vu da tau')) &&
                    ((txt.includes('da tau') && txt.length <= 60) || (aria.includes('da tau') && aria.length <= 60));
                const containsQuest = wanted.has('nhiem vu') &&
                    ((txt.includes('nhiem vu') && txt.length <= 28) || (aria.includes('nhiem vu') && aria.length <= 28));
                if (!wanted.has(txt) && !wanted.has(aria) && !containsDauTau && !containsQuest) return;

                let action = node;
                const actionSelector = 'button,a,[role="button"],[tabindex],[onclick]';
                if (!(action.matches && action.matches(actionSelector))) {
                    action = node.closest ? node.closest(actionSelector) : null;
                }
                if (!action) {
                    let parent = node.parentElement;
                    for (let i = 0; parent && i < 4; i++, parent = parent.parentElement) {
                        let pcs = null;
                        try { pcs = window.getComputedStyle(parent); } catch (e) {}
                        if ((parent.matches && parent.matches(actionSelector)) || (pcs && pcs.cursor === 'pointer')) {
                            action = parent;
                            break;
                        }
                    }
                }
                if (!action || !action.isConnected || (action.closest && action.closest(blocked))) return;
                const tag = action.tagName || '';
                const actionable = /^(BUTTON|A)$/.test(tag) || action.getAttribute('role') === 'button' || action.hasAttribute('tabindex') || action.hasAttribute('onclick');
                const exact = wanted.has(txt) || wanted.has(aria);
                const score = (actionable ? 0 : 50) + (exact ? 0 : 100) + Math.min(rawText.length || rawLabel.length, 80);
                found.push({ action, score, label: rawText || rawLabel });
            });
        } catch (e) {}
        found.sort((a, b) => a.score - b.score);
        return found.length ? found[0] : null;
    }

    function daTauFullClick(element) {
        if (!element || !element.isConnected) return false;
        if (element.disabled || element.getAttribute('aria-disabled') === 'true') return false;
        const r = element.getBoundingClientRect();
        const init = { bubbles: true, cancelable: true, view: window,
            clientX: Math.round(r.left + r.width / 2), clientY: Math.round(r.top + r.height / 2) };
        try {
            ['pointerdown', 'mousedown', 'pointerup', 'mouseup'].forEach(type => {
                try { element.dispatchEvent(new MouseEvent(type, init)); } catch (e) {}
            });
            element.click();
            return true;
        } catch (e) {
            console.warn('[Auto Dã Tẩu] Không kích hoạt được nút giao diện:', e);
            return false;
        }
    }

    function daTauRefreshNs() {
        const ns = getNsForReset();
        try { if (ns && typeof ns.update === 'function') ns.update(); } catch (e) {}
        try { if (ns && typeof ns.render === 'function') ns.render(); } catch (e) {}
    }

    function daTauCallQcPopup() {
        try {
            // Đây là hàm mở popup Dã Tẩu đúng theo luồng của game.
            if (typeof eb === 'function') { eb('qc'); daTauHideQuestPopup(); return true; }
        } catch (e) {}
        try {
            if (typeof window.eb === 'function') { window.eb('qc'); daTauHideQuestPopup(); return true; }
        } catch (e) {}
        return false;
    }

    function daTauOpenQuestUI(done) {
        // Ưu tiên API gốc từ game; nếu bản game không expose eb thì mới dò nút giao diện.
        if (daTauCallQcPopup()) {
            setTimeout(() => {
                daTauRefreshNs();
                daTauHideQuestPopup();
                if (done) done(true);
            }, 250);
            return true;
        }

        const dauLabels = ['Dã Tẩu', 'Nhiệm vụ Dã Tẩu', 'Nhiệm vụ: Dã Tẩu'];
        const questLabels = ['Nhiệm vụ'];
        let started = false;
        const dau = daTauGetVisibleAction(dauLabels);
        if (dau) {
            started = daTauFullClick(dau.action);
            setTimeout(() => { daTauRefreshNs(); if (done) done(started); }, 250);
            return true;
        }
        const quest = daTauGetVisibleAction(questLabels);
        if (quest) {
            started = daTauFullClick(quest.action);
            setTimeout(() => {
                const dau2 = daTauGetVisibleAction(dauLabels);
                if (dau2) started = daTauFullClick(dau2.action) || started;
                setTimeout(() => { daTauRefreshNs(); if (done) done(started); }, 250);
            }, 250);
            return true;
        }
        if (done) done(false);
        return false;
    }

    function daTauFindXpButton() {
        let buttons = [];
        try { buttons = Array.from(document.querySelectorAll('button[data-qcp="xp"]')); } catch (e) {}
        return buttons.find(button => {
            // Không kiểm tra visibility/display: popup được ẩn khi Auto chạy,
            // nhưng node và handler click vẫn tồn tại để gọi button.click().
            return !!(button && button.isConnected && !button.disabled && button.getAttribute('aria-disabled') !== 'true');
        }) || null;
    }

    function daTauGetState() {
        const ns = getNsForReset();
        const qc = ns && ns.qc;
        const task = qc && qc.task;
        return { ns, qc, task, step: qc && Number(qc.step), need: task && task.need, have: task && task.have };
    }

    function daTauStateSignature(state) {
        if (!state || !state.qc || !state.task) return '';
        const fields = [];
        try {
            Object.keys(state.task).sort().forEach(key => {
                let value;
                try { value = state.task[key]; } catch (e) { value = '[getter-error]'; }
                if (value === null || ['string', 'number', 'boolean', 'undefined'].includes(typeof value)) {
                    fields.push([key, value]);
                } else if (Array.isArray(value)) {
                    fields.push([key, 'array', value.length]);
                } else {
                    fields.push([key, Object.prototype.toString.call(value)]);
                }
            });
        } catch (e) {}
        return JSON.stringify([state.step, fields]);
    }

    function daTauLogDiagnostics(prefix) {
        const state = daTauGetState();
        const qc = state.qc;
        let methods = [];
        try {
            const objects = [qc, state.task];
            objects.forEach(obj => {
                if (!obj || typeof obj !== 'object') return;
                Object.getOwnPropertyNames(obj).forEach(key => {
                    try { if (typeof obj[key] === 'function') methods.push(key); } catch (e) {}
                });
                const proto = Object.getPrototypeOf(obj);
                if (proto) Object.getOwnPropertyNames(proto).forEach(key => {
                    try { if (key !== 'constructor' && typeof obj[key] === 'function') methods.push(key); } catch (e) {}
                });
            });
        } catch (e) {}
        console.warn(prefix || '[Auto Dã Tẩu] Chẩn đoán:', {
            connected: !!qc, step: qc && qc.step, task: state.task,
            qcKeys: qc ? Object.keys(qc) : [], taskKeys: state.task ? Object.keys(state.task) : [],
            qcMethods: Array.from(new Set(methods))
        });
    }

    function daTauSetUiStatus(message) {
        const ui = daTauAutoUI;
        if (!ui) return;
        if (ui.status && ui.status.isConnected) ui.status.textContent = message || '';
        if (ui.start && ui.start.isConnected) {
            ui.start.disabled = !!daTauAutoRunning;
            ui.start.textContent = daTauAutoRunning ? '▶ AUTO ĐANG CHẠY' : '▶ CHẠY AUTO DÃ TẨU';
        }
        if (ui.stop && ui.stop.isConnected) {
            ui.stop.disabled = !daTauAutoRunning;
            ui.stop.textContent = daTauAutoRunning ? '⏹ DỪNG AUTO' : '⏹ ĐÃ DỪNG';
        }
    }

    function runDaTauAutoFlow() {
        if (daTauAutoBusy) return Promise.resolve({ ok: false, claimed: false, message: 'Đang xử lý bước trước.' });
        const initial = daTauGetState();
        if (!initial.qc || !initial.task || typeof initial.task !== 'object' ||
            initial.task.need === undefined || initial.task.need === null) {
            return Promise.resolve({ ok: false, claimed: false, message: 'Chưa có Ns.qc.task.need.' });
        }

        daTauAutoBusy = true;
        return new Promise(resolve => {
            let buttonPoll = null;
            let progressPoll = null;
            let observer = null;
            let timeout = null;
            let claimed = false;
            let baseline = null;
            let clickAt = 0;
            let refreshedAfterClick = false;
            let finished = false;
            let cancelBeforeClaim = null;

            const finish = (ok, message, didClaim) => {
                if (finished) return;
                finished = true;
                if (daTauPendingCancel === cancelBeforeClaim) daTauPendingCancel = null;
                if (buttonPoll) clearInterval(buttonPoll);
                if (progressPoll) clearInterval(progressPoll);
                if (timeout) clearTimeout(timeout);
                if (observer) { try { observer.disconnect(); } catch (e) {} }
                buttonPoll = progressPoll = timeout = observer = null;
                daTauAutoBusy = false;
                if (message) (ok ? console.info : console.warn)(message);
                resolve({ ok: !!ok, claimed: !!didClaim, message: message || '' });
            };

            // Nút Dừng có thể hủy an toàn khi chưa gửi click nhận EXP.
            // Nếu click đã gửi, để bước xác nhận kết thúc nhưng không chạy vòng kế tiếp.
            cancelBeforeClaim = () => {
                if (!claimed) finish(false, '[Auto Dã Tẩu] Đã dừng trước khi bấm nhận EXP.', false);
            };
            daTauPendingCancel = cancelBeforeClaim;

            const hasProgressed = () => {
                const latest = daTauGetState();
                if (!latest.qc || !latest.task) return false;
                const stepChanged = Number.isFinite(latest.step) && Number.isFinite(baseline.step) && latest.step !== baseline.step;
                const taskReplaced = latest.task !== baseline.task;
                const taskChanged = daTauStateSignature(latest) !== baseline.signature;
                return stepChanged || taskReplaced || taskChanged;
            };

            const waitForProgress = () => {
                progressPoll = setInterval(() => {
                    if (hasProgressed()) {
                        const latest = daTauGetState();
                        finish(true, '[Auto Dã Tẩu] Game đã chuyển nhiệm vụ/step sau khi nhận EXP. Step hiện tại: ' + latest.step, true);
                        return;
                    }
                    const elapsed = Date.now() - clickAt;
                    // Đề nghị game làm mới popup một lần sau click, nhưng không bấm nhận lần hai.
                    if (!refreshedAfterClick && elapsed >= 1200) {
                        refreshedAfterClick = true;
                        daTauRefreshNs();
                        daTauOpenQuestUI();
                        daTauHideQuestPopup();
                    }
                    if (elapsed >= 20000) {
                        daTauLogDiagnostics('[Auto Dã Tẩu] Đã bấm nhận EXP nhưng chưa thấy game đổi nhiệm vụ/step:');
                        finish(false, '[Auto Dã Tẩu] Đã gửi lệnh nhận EXP nhưng chưa xác nhận được từ game. Auto tạm dừng để tránh bấm nhận trùng.', true);
                    }
                }, 250);
            };

            const clickWhenReady = () => {
                const button = daTauFindXpButton();
                if (button) {
                    // Chụp trạng thái sau khi task.have đã được đặt đủ, ngay trước khi gửi lệnh claim.
                    const before = daTauGetState();
                    baseline = { step: before.step, task: before.task, signature: daTauStateSignature(before) };
                    try {
                        button.click();
                        claimed = true;
                        clickAt = Date.now();
                        if (buttonPoll) clearInterval(buttonPoll);
                        if (observer) { try { observer.disconnect(); } catch (e) {} }
                        buttonPoll = observer = null;
                        console.info('[Auto Dã Tẩu] Đã bấm nút nhận EXP. Đang chờ game xác nhận...');
                        waitForProgress();
                    } catch (e) {
                        finish(false, '[Auto Dã Tẩu] Không bấm được nút nhận EXP: ' + (e && e.message ? e.message : e), false);
                    }
                    return true;
                }
                return false;
            };

            const waitForButton = () => {
                if (clickWhenReady()) return;
                buttonPoll = setInterval(() => {
                    if (clickWhenReady()) return;
                    if (Date.now() - startedAt >= 15000) {
                        daTauLogDiagnostics('[Auto Dã Tẩu] Không thấy nút nhận EXP sau 15 giây:');
                        finish(false, '[Auto Dã Tẩu] Không thấy nút button[data-qcp="xp"] hoạt động sau 15 giây. Auto sẽ thử lại.', false);
                    }
                }, 120);
                try {
                    observer = new MutationObserver(() => { if (!finished) { daTauHideQuestPopup(); clickWhenReady(); } });
                    observer.observe(document.documentElement || document, {
                        childList: true, subtree: true, attributes: true,
                        attributeFilter: ['disabled', 'aria-disabled', 'class', 'style', 'data-qcp']
                    });
                } catch (e) {}
            };

            const startedAt = Date.now();
            timeout = setTimeout(() => {
                if (!finished && !claimed) {
                    daTauLogDiagnostics('[Auto Dã Tẩu] Hết thời gian chờ nút nhận thưởng:');
                    finish(false, '[Auto Dã Tẩu] Hết thời gian chờ nút nhận thưởng EXP. Auto sẽ thử lại.', false);
                }
            }, 15500);

            // Bước 1: đặt tiến độ đủ; không tự ghi qc.step và không gán qc.pick.
            try {
                const state = daTauGetState();
                if (!state.qc || !state.task) {
                    finish(false, '[Auto Dã Tẩu] Dữ liệu Dã Tẩu chưa sẵn sàng.', false);
                    return;
                }
                state.task.have = state.task.need;
                daTauRefreshNs();
            } catch (e) {
                finish(false, '[Auto Dã Tẩu] Không thể hoàn thành tiến độ nhiệm vụ: ' + (e && e.message ? e.message : e), false);
                return;
            }

            // Bước 2: gọi popup gốc eb("qc"), sau đó đợi nút EXP được render.
            daTauOpenQuestUI(() => {
                if (finished) return;
                const state = daTauGetState();
                if (state.task && state.task.have !== state.task.need) {
                    try { state.task.have = state.task.need; } catch (e) {}
                    daTauRefreshNs();
                }
                waitForButton();
            });
        });
    }

    function daTauAutoLoop(token) {
        if (!daTauAutoRunning || token !== daTauAutoToken) return;
        daTauSetUiStatus('Đang xử lý nhiệm vụ Dã Tẩu thứ ' + (daTauAutoCount + 1) + '...');
        runDaTauAutoFlow().then(result => {
            if (!daTauAutoRunning || token !== daTauAutoToken) return;
            if (result.ok) {
                daTauAutoCount++;
                daTauSetUiStatus('Đã nhận EXP ' + daTauAutoCount + ' lần. Đang chuẩn bị nhiệm vụ tiếp theo...');
                daTauAutoTimer = setTimeout(() => daTauAutoLoop(token), 1000);
                return;
            }
            if (!result.claimed) {
                // Chưa bấm nhận: có thể an toàn thử lại sau khi giao diện/game nạp xong.
                daTauSetUiStatus((result.message || 'Chưa sẵn sàng') + ' Thử lại sau 2 giây...');
                daTauAutoTimer = setTimeout(() => daTauAutoLoop(token), 2000);
                return;
            }
            // Đã click nhưng chưa xác nhận: dừng an toàn để tránh nhận trùng/đẩy task sai.
            daTauAutoRunning = false;
            daTauAutoToken++;
            daTauStopPopupGuard();
            daTauRestoreQuestPopup();
            daTauSetUiStatus('Auto tạm dừng: game chưa xác nhận EXP. Xem Console để biết chi tiết.');
        }).catch(error => {
            if (!daTauAutoRunning || token !== daTauAutoToken) return;
            daTauAutoRunning = false;
            daTauAutoToken++;
            daTauStopPopupGuard();
            daTauRestoreQuestPopup();
            daTauSetUiStatus('Auto gặp lỗi: ' + (error && error.message ? error.message : error));
            console.error('[Auto Dã Tẩu] Lỗi vòng lặp:', error);
        });
    }

    function startDaTauAuto() {
        if (daTauAutoRunning) return;
        daTauAutoRunning = true;
        daTauAutoCount = 0;
        daTauAutoToken++;
        if (daTauAutoTimer) clearTimeout(daTauAutoTimer);
        daTauAutoTimer = null;
        daTauStartPopupGuard();
        console.info('[Auto Dã Tẩu] Bắt đầu chạy liên tục. Bấm DỪNG AUTO để kết thúc.');
        daTauSetUiStatus('Đã bật Auto Dã Tẩu. Đang bắt đầu...');
        daTauAutoLoop(daTauAutoToken);
    }

    function stopDaTauAuto() {
        if (!daTauAutoRunning && !daTauAutoBusy) return;
        daTauAutoRunning = false;
        daTauAutoToken++;
        if (daTauAutoTimer) clearTimeout(daTauAutoTimer);
        daTauAutoTimer = null;
        if (daTauPendingCancel) {
            try { daTauPendingCancel(); } catch (e) {}
        }
        daTauStopPopupGuard();
        daTauRestoreQuestPopup();
        daTauSetUiStatus(daTauAutoBusy
            ? 'Đã yêu cầu dừng. Bước đang xử lý sẽ kết thúc, không chạy nhiệm vụ kế tiếp.'
            : 'Đã dừng Auto Dã Tẩu.');
        console.info('[Auto Dã Tẩu] Đã dừng theo yêu cầu.');
    }

    function tabReset() {
        const a = [];

        a.push(hdr('⚔️ Reset chiến trường'));
        a.push(el('button', {
            text: '⚔️ RESET CHIẾN TRƯỜNG',
            css: BCSS + 'width:100%;padding:8px 0;font-weight:bold;margin:4px 0 8px;background:#fab387;color:#111;',
            on: () => {
                const data = getNsWarForReset();
                if (!data) {
                    console.warn('[Auto Reset] Chưa kết nối được Ns.war.');
                    return;
                }
                try {
                    data.war.tk = 0;
                    data.war.tkWins = 0;
                } catch (e) {
                    console.warn('[Auto Reset] Không thể reset chiến trường:', e);
                }
            }
        }));

        a.push(hdr('🛒 Reset cửa hàng'));
        a.push(el('button', {
            text: '🛒 RESET CỬA HÀNG',
            css: BCSS + 'width:100%;padding:8px 0;font-weight:bold;margin:4px 0 8px;background:#a6e3a1;color:#111;',
            on: () => {
                const data = getNsWarForReset();
                if (!data) {
                    console.warn('[Auto Reset] Chưa kết nối được Ns.war.');
                    return;
                }
                try {
                    data.war.bought = {};
                } catch (e) {
                    console.warn('[Auto Reset] Không thể reset cửa hàng:', e);
                }
            }
        }));

        a.push(hdr('🧭 AUTO DÃ TẨU EXP'));
        const daTauStartBtn = el('button', {
            type: 'button', text: '▶ CHẠY AUTO DÃ TẨU',
            css: BCSS + 'flex:1;min-width:0;padding:9px 4px;font-weight:bold;background:#28a745;color:#fff;',
            on: () => startDaTauAuto()
        });
        const daTauStopBtn = el('button', {
            type: 'button', text: '⏹ ĐÃ DỪNG', disabled: true,
            css: BCSS + 'flex:1;min-width:0;padding:9px 4px;font-weight:bold;background:#b23b3b;color:#fff;',
            on: () => stopDaTauAuto()
        });
        const daTauStatus = el('div', {
            text: daTauAutoRunning ? ('Auto đang chạy · Đã nhận ' + daTauAutoCount + ' lần') : 'Đang dừng.',
            css: 'width:100%;box-sizing:border-box;padding:7px 8px;margin:4px 0 8px;background:#20242c;color:#d8dee9;border:1px solid #555;border-radius:4px;font-size:11px;line-height:1.4;'
        });
        const daTauButtons = el('div', { css: 'display:flex;gap:6px;width:100%;margin:4px 0 0;' }, daTauStartBtn, daTauStopBtn);
        a.push(daTauButtons, daTauStatus);
        daTauAutoUI = { start: daTauStartBtn, stop: daTauStopBtn, status: daTauStatus };
        daTauSetUiStatus(daTauAutoRunning ? ('Auto đang chạy · Đã nhận ' + daTauAutoCount + ' lần') : 'Đang dừng.');

        a.push(hdr('🏅 Tăng điểm chiến trường'));
        const meritInput = el('input', {
            type: 'number',
            min: '0',
            step: '1',
            placeholder: 'Nhập số điểm chiến trường',
            value: '',
            css: 'flex:1;min-width:0;box-sizing:border-box;padding:7px 8px;background:#222;color:#eee;border:1px solid #666;border-radius:4px;'
        });
        const meritButton = el('button', {
            text: '⬆ TĂNG',
            css: BCSS + 'flex:0 0 auto;padding:7px 14px;font-weight:bold;background:#89b4fa;color:#111;',
            on: () => {
                const raw = String(meritInput.value || '').trim();
                if (!raw) {
                    alert('⚠️ Vui lòng nhập số điểm chiến trường.');
                    meritInput.focus();
                    return;
                }

                const meritValue = Number(raw);
                if (!Number.isSafeInteger(meritValue) || meritValue < 0) {
                    alert('⚠️ Số điểm phải là số nguyên không âm hợp lệ.');
                    meritInput.focus();
                    return;
                }

                const data = getNsWarForReset();
                if (!data) {
                    console.warn('[Auto Reset] Chưa kết nối được Ns.war để cập nhật điểm.');
                    return;
                }

                try {
                    data.war.merit = meritValue;
                } catch (e) {
                    console.warn('[Auto Reset] Không thể cập nhật điểm chiến trường:', e);
                }
            }
        });
        a.push(el('div', {
            css: 'display:flex;align-items:center;gap:6px;width:100%;margin:4px 0 10px;'
        }, meritInput, meritButton));

        return a;
    }

    function tabAct() {
        const a = [];
        a.push(hdr('⚙️ Trạng thái Auto Hoạt động'));
        const btnToggleAct = el('button', {
            text: C.actEnabled ? '🟢 ĐANG BẬT (ON)' : '🔴 ĐÃ TẮT (OFF)',
            css: BCSS + 'width:100%;padding:6px 0;font-weight:bold;margin-bottom:8px;background:' + (C.actEnabled ? '#a6e3a1;color:#111' : '#f38ba8;color:#111'),
            on: () => {
                C.actEnabled = !C.actEnabled;
                save();
                draw();
            }
        });
        a.push(btnToggleAct);

        a.push(hdr('🏰 Reset Tháp 2'));
        a.push(el('button', {
            text: '🔄 RESET THÁP 2 (Về tầng 0 & reset lượt)',
            css: BCSS + 'width:100%;padding:6px 0;font-weight:bold;margin-bottom:8px;background:#fab387;color:#111;',
            on: () => {
                doResetThap2();
                if (typeof draw === 'function') draw();
            }
        }));

        a.push(hdr('🌀 Tự chuyển sinh (luôn chạy)'));
        a.push(fB('rebirthOn', 'Bật tự chuyển sinh'));
        a.push(fN('rebirthDelay', 'Cách nhau tối thiểu (s)', 600));
        a.push(hdr('💊 Tự bơm máu'));
        a.push(fB('hpPotOn', 'Bật tự bơm máu'));
        a.push(fN('hpPotPct', 'Bơm khi máu < %', 100));
        a.push(hdr('💧 Tự bơm mana'));
        a.push(fB('mpPotOn', 'Bật tự bơm mana'));
        a.push(fN('mpPotPct', 'Bơm khi mana < %', 100));
        a.push(hdr('Chế độ hoạt động'));
        const AM = [['push', '🚀 Push ải'], ['t1', '🏯 Tháp I'], ['t2', '🗼 Tháp II']];
        a.push(el('div', { css: 'display:flex;gap:3px;margin:3px 0' }, ...AM.map(o => el('button', {
            text: o[1],
            css: BCSS + 'flex:1;padding:3px 0;font-size:11px;' + (C.actMode === o[0] ? 'background:#654;color:#fc6;' : ''),
            on: () => { C.actMode = o[0]; save(); draw() }
        }))));

        a.push(hdr('🏯 Tháp'));
        a.push(fB('twAi', 'Tự điều khiển (hết quái → nhặt đồ → về tâm)'));
        a.push(fB('twLoot', 'Nhặt từ xa khi hết quái (3 lần × 500ms)'));
        a.push(fN('twPad', 'Coi là đã tới tâm khi cách ≤ (px)'));
        a.push(fN('twReHp', 'Chỉ vào tháp khi máu ≥ %', 100));

        a.push(hdr('🎏 Thả diều MAX (dùng chung 2 tháp)'));
        a.push(fB('twKite', 'Bật thả diều'));
        a.push(fB('rangedPrio', '🎯 Ưu tiên giết quái đánh xa (ranged)'));
        a.push(fB('meleeTelePrio', '⚡ Ưu tiên giết melee sắp teleport (farT ≥ yh-3)'));
        a.push(fB('teleDetect', '🔮 Dự đoán điểm teleport + né'));
        a.push(note('🎯 Hook: ✓ active'));
        a.push(btn('🔄 Reset setting tháp về đề xuất', () => {
            C.twMarginPx = 2; C.twSweetSpot = 5000; C.twMaxFar = 3200; C.twMaxStall = 85;
            save(); draw();
        }));
        a.push(fN('twMarginPx', 'Chạy hẳn khi máu < %', 100));
        a.push(fN('twStep', 'Sai số an toàn (px)'));
        a.push(fN('twSweetSpot', 'Độ rộng Sweet Spot (px)'));
        a.push(fN('twMaxFar', 'Khoảng cách xa tối đa (px)'));
        a.push(fN('twArena', 'Bán kính chạy (px)'));
        a.push(fN('twMaxStall', 'Đứng bắn khi quái % giờ tầng'));

        a.push(hdr('🛡 Tránh bị vây trước'));
        a.push(fN('twCrowdR', 'Bán kính vùng đông quái (px)'));
        a.push(fN('twCrowdMax', 'Số quái coi là bị vây'));
        a.push(fN('twThreatMax', 'Ngưỡng mối đe dọa (threat)'));

        return a;
    }

    function tabBag() {
        const a = [];
        a.push(fN('eqSec', 'Tự mặc đồ tốt mỗi (giây)'));
        a.push(hdr('🔒 Giữ đồ đang mặc (không thay)'));
        const SLOTS_NAME = [
            ['weapon', 'Vũ khí'], ['armor', 'Áo'], ['helm', 'Mũ'],
            ['belt', 'Đai'], ['boot', 'Giày'], ['cuff', 'Hộ uyển'],
            ['amulet', 'Dây chuyền'], ['ring1', 'Nhẫn 1'], ['ring2', 'Nhẫn 2'],
            ['pendant', 'Ngọc bội']
        ];
        const gSlot = el('div', { css: 'display:grid;grid-template-columns:1fr 1fr 1fr;gap:2px;margin:4px 0' });
        SLOTS_NAME.forEach(([k, label]) => {
            const chk = el('input', { type: 'checkbox', checked: !!C.lockSlots[k] });
            chk.onchange = () => { C.lockSlots[k] = chk.checked; save(); };
            gSlot.appendChild(el('label', { css: 'font-size:11px;display:flex;align-items:center;gap:2px' }, chk, label));
        });
        a.push(gSlot);

        a.push(el('div', { css: 'display:flex;gap:4px;margin:4px 0' },
            btn('🔒 Khóa tất cả', () => { SLOTS_NAME.forEach(([k]) => C.lockSlots[k] = true); save(); draw() }),
            btn('🔓 Bỏ khóa tất cả', () => { SLOTS_NAME.forEach(([k]) => C.lockSlots[k] = false); save(); draw() })
        ));
        a.push(note('Slot khóa: script không thay đồ dù có món mạnh hơn trong túi.\nĐồ set/leg đang mặc: tự giữ, không thay (trừ khi bật tự ghép bộ).'));

        a.push(hdr('🎯 Tự ghép bộ'));
        a.push(fS('setScanMode', 'Chế độ quét', [['full', 'Đầy đủ (3 tầng)'], ['fast', 'Nhanh']]));
        a.push(fN('setMixPairs', 'Mix 4+4 top N cặp'));
        a.push(fN('setMixFilterPct', 'Mix 4+4 ngưỡng lọc (%)'));
        a.push(fB('setAutoOn', 'Bật tự ghép bộ khi có bộ mạnh hơn'));
        a.push(fN('setThreshold', 'Ngưỡng tăng power (%)'));
        a.push(fN('setIntervalSec', 'Kiểm tra mỗi (giây)'));
        a.push(fN('setCooldown', 'Cooldown sau swap (giây)'));
        a.push(fB('setDryRun', 'Chỉ mô phỏng (không swap thật)'));

        a.push(hdr('🎒 Dọn túi'));
        a.push(fB('bagOn', 'Bật'));
        a.push(fN('free', 'Giữ trống (ô)'));
        a.push(fN('bagSec', 'Mỗi (giây)'));
        a.push(fB('gameSell', 'Bán đồ không khớp lọc'));
        a.push(fB('toFb', 'Chuyển nguyên liệu sang Kho Rèn'));
        a.push(fN('keepRar', 'Giữ độ hiếm ≥'));
        a.push(fN('lvlAhead', 'Giữ đồ cấp cao hơn +'));
        a.push(fB('sellOff', 'Bán đồ phái khác'));
        a.push(fB('sellRare', 'Thiếu ô: bán cả đồ quý'));
        a.push(fN('keepEnh', 'Giữ đồ cường hóa ≥ +'));

        a.push(hdr('⚙ Dọn Kho Rèn'));
        a.push(fB('fbOn', 'Bật'));
        a.push(fN('fbSec', 'Mỗi (giây)'));
        a.push(fB('fbRun', 'Chạy Tự rèn của game'));
        a.push(fB('fbExt', 'Tách đá đồ xanh'));

        return a;
    }

    function tabPot() {
        const a = [];
        a.push(hdr('⚡ Tự cộng tiềm năng'));
        a.push(fB('potOn', 'Bật tự cộng'));
        a.push(fB('potStrict', '☑ Kiểm tra và sửa điểm'));

        a.push(hdr('Số điểm ưu tiên muốn cộng'));
        a.push(fN('potStr', 'Sức mạnh (str)'));
        a.push(fN('potDex', 'Thân pháp (dex)'));
        a.push(fN('potVit', 'Sinh lực (vit)'));
        a.push(fN('potEng', 'Nội công (eng)'));

        a.push(hdr('Phần dư (sau khi đủ 4 stat trên)'));
        a.push(fS('potRem', 'Xử lý', [['dt', 'Theo đề xuất game'], ['eng', 'Vào Nội công'], ['vit', 'Vào Sinh lực']]));
        a.push(fN('potSec', 'Kiểm tra mỗi (giây)', 600));

        a.push(btn('↺ Reset cấu hình', () => {
            C.potStr = 0; C.potDex = 0; C.potVit = 0; C.potEng = 0; save(); draw();
        }));

        a.push(note('Ưu tiên cộng tuần tự: str → dex → vit → eng, hết điểm thì dừng.\n0 = bỏ qua stat đó.\nTự tẩy và cộng lại khi bạn đổi cấu hình.'));
        return a;
    }

    // ===== SPEED HN: tích hợp HN Speed 1.4.2 vào tab riêng =====
    const HN_SPEED_KEY = '__hnSpeed_rate';
    const HN_SPEED_RATES = [1, 2, 3, 5, 10, 20, 50, 100];
    const HN_SPEED_MAX = 100;
    const hnSpeedOkRate = v => Number.isInteger(v) && v >= 1 && v <= HN_SPEED_MAX;
    let hnSpeedRate = 1;
    let hnSpeedButton = null;
    let hnSpeedRateButtons = [];
    let hnSpeedInfo = null;

    // ===== CHỐNG ĐAU MẮT: làm tối lớp canvas game, không phủ lên UI HTML =====
    const HN_ANTI_EYE_KEY = '__hnSpeed_antiEye';
    let isAntiEyeStrain = false;
    let antiEyeStyleEl = null;
    let antiEyeButton = null;

    try { isAntiEyeStrain = localStorage.getItem(HN_ANTI_EYE_KEY) === '1'; } catch (e) { }

    function applyAntiEyeStrain() {
        try {
            if (!antiEyeStyleEl) {
                antiEyeStyleEl = document.getElementById('vltk-anti-eye-strain-style');
                if (!antiEyeStyleEl) {
                    antiEyeStyleEl = document.createElement('style');
                    antiEyeStyleEl.id = 'vltk-anti-eye-strain-style';
                    (document.head || document.documentElement).appendChild(antiEyeStyleEl);
                }
            }
            // Chỉ lọc canvas; không lọc container cha để các cửa sổ HTML nổi phía trên
            // (Dã Tẩu, Rương, Nhân vật, khung chat...) giữ nguyên độ sáng và thao tác.
            antiEyeStyleEl.textContent = isAntiEyeStrain
                ? 'canvas, #gameCanvas, #canvas, .game-canvas { filter: brightness(0.15) contrast(1.1) !important; transition: filter .3s ease !important; }'
                : 'canvas, #gameCanvas, #canvas, .game-canvas { filter: none !important; transition: filter .3s ease !important; }';
        } catch (e) { }
        if (antiEyeButton) {
            antiEyeButton.textContent = isAntiEyeStrain ? '🌙 BẬT' : '☀️ TẮT';
            antiEyeButton.style.background = isAntiEyeStrain ? '#a6e3a1' : '#313244';
            antiEyeButton.style.color = isAntiEyeStrain ? '#111' : '#eee';
        }
    }

    // Khôi phục ngay khi nạp script, không cần mở tab Speed HN trước.
    applyAntiEyeStrain();

    function toggleAntiEyeStrain(enable) {
        isAntiEyeStrain = typeof enable === 'boolean' ? enable : !isAntiEyeStrain;
        try { localStorage.setItem(HN_ANTI_EYE_KEY, isAntiEyeStrain ? '1' : '0'); } catch (e) { }
        applyAntiEyeStrain();
    }

    try {
        const storedRate = +localStorage.getItem(HN_SPEED_KEY);
        if (hnSpeedOkRate(storedRate)) hnSpeedRate = storedRate;
    } catch (e) { }

    function hnSpeedDraw() {
        if (!hnSpeedButton) return;
        hnSpeedButton.textContent = '🐎 x' + hnSpeedRate;
        hnSpeedButton.style.borderColor = hnSpeedRate === 1 ? '#666' : '#ffb04a';
        hnSpeedButton.style.color = hnSpeedRate === 1 ? '#ccc' : '#ffd27a';
        hnSpeedRateButtons.forEach(item => {
            item.button.style.background = item.rate === hnSpeedRate ? '#a6e3a1' : '#313244';
            item.button.style.color = item.rate === hnSpeedRate ? '#111' : '#eee';
        });
        if (hnSpeedInfo) hnSpeedInfo.textContent =
            'Tốc độ đang chọn: x' + hnSpeedRate +
            '\nNhấn nút 🐎 để chuyển mức; nhấn giữ nút để nhập tốc độ tùy chỉnh.';
    }

    function hnSpeedApply() {
        // Giữ nguyên cách áp dụng của HN Speed cũ.
        try {
            if (!/(^|\.)hoainiem2003\.net$/.test(location.hostname)) return;
            const d = (window.JXDEV && typeof window.JXDEV === 'object')
                ? window.JXDEV : (window.JXDEV = {});
            const nextRate = hnSpeedRate > 1 ? Math.min(HN_SPEED_MAX, hnSpeedRate) : 1;
            if (nextRate > 1) {
                if (d.spd !== nextRate) d.spd = nextRate;
            } else if (Object.prototype.hasOwnProperty.call(d, 'spd')) {
                delete d.spd;
            }
        } catch (e) { }
        hnSpeedDraw();
    }

    function hnSpeedSetRate(r) {
        hnSpeedRate = hnSpeedOkRate(r) ? r : 1;
        try { localStorage.setItem(HN_SPEED_KEY, String(hnSpeedRate)); } catch (e) { }
        hnSpeedApply();
    }

    // Không dùng setInterval nền: áp dụng một lần khi khởi tạo và khi quay lại trang.
    // Giá trị JXDEV.spd vẫn được giữ khi chuyển tab giao diện; khi trình duyệt hiện lại,
    // kiểm tra và khôi phục nếu game đã ghi đè giá trị.
    if (/(^|\.)hoainiem2003\.net$/.test(location.hostname)) {
        hnSpeedApply();
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) hnSpeedApply();
        }, { passive: true });
        window.addEventListener('focus', hnSpeedApply, { passive: true });
        window.addEventListener('pageshow', hnSpeedApply, { passive: true });
    }

    function hnSpeedNextRate() {
        let idx = HN_SPEED_RATES.indexOf(hnSpeedRate);
        if (idx === -1) {
            idx = HN_SPEED_RATES.findIndex(r => r > hnSpeedRate) - 1;
            if (idx < 0) idx = 0;
        }
        hnSpeedSetRate(HN_SPEED_RATES[(idx + 1) % HN_SPEED_RATES.length]);
    }

    function tabHNSpeed() {
        const a = [];
        a.push(hdr('🐎 HN Speed — tốc độ mô phỏng x1 đến x100'));

        const supportedHost = /(^|\.)hoainiem2003\.net$/.test(location.hostname);
        if (!supportedHost) {
            a.push(note('HN Speed chỉ hoạt động trên tên miền hoainiem2003.net.'));
            return a;
        }

        antiEyeButton = el('button', {
            text: isAntiEyeStrain ? '🌙 BẬT' : '☀️ TẮT',
            css: BCSS + 'min-width:76px;padding:6px 12px;font-weight:bold;',
            on: () => toggleAntiEyeStrain()
        });
        antiEyeButton.title = 'Bật/tắt chế độ làm tối lớp Canvas game';
        a.push(hdr('🌙 Chống đau mắt'));
        a.push(el('div', { css: 'display:flex;align-items:center;justify-content:space-between;gap:8px;margin:8px 0;' },
            el('span', { text: 'Chế độ màn hình:' }), antiEyeButton));
        applyAntiEyeStrain();

        hnSpeedButton = el('button', {
            text: '🐎 x' + hnSpeedRate,
            css: 'background:rgba(10,10,10,.92);border:1px solid #666;border-radius:6px;padding:7px 14px;font:bold 14px Tahoma,Arial,sans-serif;cursor:pointer;touch-action:none;user-select:none;'
        });
        hnSpeedButton.title = 'Chạm: mức kế tiếp · Giữ: nhập mức 1–100';
        let hnPointerDown = false, hnHoldTimer = null, hnMoved = false;

        hnSpeedButton.addEventListener('pointerdown', e => {
            hnPointerDown = true;
            hnMoved = false;
            try { hnSpeedButton.setPointerCapture(e.pointerId); } catch (err) { }
            hnHoldTimer = setTimeout(() => {
                hnHoldTimer = null;
                const v = prompt('Nhập tốc độ mong muốn (1-100):', hnSpeedRate);
                if (v !== null) {
                    const n = parseInt(v, 10);
                    if (hnSpeedOkRate(n)) hnSpeedSetRate(n);
                    else alert('Vui lòng nhập số nguyên từ 1 đến 100.');
                }
            }, 600);
        });

        hnSpeedButton.addEventListener('pointermove', () => {
            if (!hnPointerDown) return;
            hnMoved = true;
            if (hnHoldTimer) {
                clearTimeout(hnHoldTimer);
                hnHoldTimer = null;
            }
        });

        const finishHNSpeedPointer = () => {
            if (!hnPointerDown) return;
            if (hnHoldTimer) {
                clearTimeout(hnHoldTimer);
                hnHoldTimer = null;
                if (!hnMoved) hnSpeedNextRate();
            }
            hnPointerDown = false;
        };
        hnSpeedButton.addEventListener('pointerup', finishHNSpeedPointer);
        hnSpeedButton.addEventListener('pointercancel', finishHNSpeedPointer);
        a.push(el('div', {
            css: 'display:flex;align-items:center;justify-content:space-between;gap:8px;margin:8px 0;'
        }, el('span', { text: 'Tốc độ HN:' }), hnSpeedButton));

        const rateGrid = el('div', {
            css: 'display:grid;grid-template-columns:repeat(4,1fr);gap:4px;margin:8px 0;'
        });
        hnSpeedRateButtons = [];
        HN_SPEED_RATES.forEach(rateValue => {
            const rateButton = el('button', {
                text: 'x' + rateValue,
                css: BCSS + 'padding:6px 0;font-weight:bold;' +
                    (hnSpeedRate === rateValue ? 'background:#a6e3a1;color:#111;' : 'background:#313244;'),
                on: () => hnSpeedSetRate(rateValue)
            });
            hnSpeedRateButtons.push({ rate: rateValue, button: rateButton });
            rateGrid.appendChild(rateButton);
        });
        a.push(rateGrid);
        hnSpeedInfo = note('');
        a.push(hnSpeedInfo);
        hnSpeedApply();
        return a;
    }

    function tabSpeed() {
        const a = [];
        a.push(hdr('⚡ Hack Speed Engine (x1 - x100)'));
        const btnSw = el('button', {
            text: window.vltkSpeedEnabled ? 'ON' : 'OFF',
            css: BCSS + 'padding:4px 12px;font-weight:bold;background:' + (window.vltkSpeedEnabled ? '#a6e3a1;color:#111' : '#f38ba8;color:#111'),
            on: () => {
                window.vltkSpeedEnabled = !window.vltkSpeedEnabled;
                try { localStorage.setItem('__vltkSpeedEnabled', window.vltkSpeedEnabled ? '1' : '0'); } catch (e) { }
                btnSw.innerText = window.vltkSpeedEnabled ? 'ON' : 'OFF';
                btnSw.style.background = window.vltkSpeedEnabled ? '#a6e3a1' : '#f38ba8';
            }
        });
        a.push(el('div', { css: 'display:flex;align-items:center;justify-content:space-between;margin:6px 0' }, el('span', { text: 'Trạng thái Speed:' }), btnSw));

        const gridSpd = el('div', { css: 'display:grid;grid-template-columns:repeat(4,1fr);gap:4px;margin:8px 0' });
        [1, 2, 5, 10, 20, 50, 100].forEach(val => {
            const sBtn = el('button', {
                text: 'x' + val,
                css: BCSS + 'padding:6px 0;font-weight:bold;' + (window.vltkSelectedSpeed === val ? 'background:#a6e3a1;color:#111;' : 'background:#313244;'),
                on: () => {
                    window.vltkSelectedSpeed = val;
                    draw();
                }
            });
            gridSpd.appendChild(sBtn);
        });
        a.push(gridSpd);
        a.push(note('⚡ Đang chọn speed: x' + window.vltkSelectedSpeed + (window.vltkSpeedEnabled ? '' : '\nSpeed gốc đang TẮT; hệ số tốc độ trở về x1.')));
        return a;
    }

    function tabEvent() {
        const a = [];
        a.push(hdr('🎁 Auto Đổi Event Bánh'));
        const selEv = el('select', {
            id: 'v-sel-event',
            css: 'width:100%;background:#11111b;color:#a6e3a1;border:1px solid #45475a;border-radius:4px;padding:5px;font-size:11px;margin:4px 0'
        });

        if (savedEventItems.length === 0) {
            selEv.appendChild(el('option', { text: '-- Mở tab Event rồi bấm Quét --', value: '' }));
        } else {
            savedEventItems.forEach(item => {
                const opt = el('option', { value: item.text, text: item.text });
                if (item.text === selectedEventValue) opt.selected = true;
                selEv.appendChild(opt);
            });
        }

        selEv.onchange = () => {
            selectedEventValue = selEv.value;
        };

        a.push(selEv);

        const evBtns = el('div', { css: 'display:flex;gap:4px;margin-bottom:8px' });
        evBtns.appendChild(btn('🔍 Quét Món', () => {
            const list = getEventItemList();
            savedEventItems = list;
            selEv.innerHTML = '';
            if (list.length === 0) {
                selectedEventValue = "";
                selEv.appendChild(el('option', { text: '(Không tìm thấy, mở tab Event thử lại)', value: '' }));
                alert('Vui lòng mở tab Sự kiện trong game trước rồi nhấn Quét Món lại!');
            } else {
                list.forEach((item, idx) => {
                    const opt = el('option', { value: item.text, text: item.text });
                    if (idx === 0) selectedEventValue = item.text;
                    selEv.appendChild(opt);
                });
            }
        }));
        evBtns.appendChild(btn('⚡ Đổi 10 Lần', () => exchangeSelectedItem(10)));

        let isEvRun = autoEventInterval !== null;
        const btnEvAuto = btn(isEvRun ? '⏹ Dừng' : '🔁 Auto Đổi', () => {
            if (autoEventInterval) {
                clearInterval(autoEventInterval);
                autoEventInterval = null;
                btnEvAuto.innerText = '🔁 Auto Đổi';
                btnEvAuto.style.background = '#a6e3a1';
            } else {
                btnEvAuto.innerText = '⏹ Dừng';
                btnEvAuto.style.background = '#f38ba8';
                autoEventInterval = setInterval(() => { exchangeSelectedItem(1); }, 100);
            }
        }, isEvRun ? 'background:#f38ba8;color:#111;' : 'background:#a6e3a1;color:#111;');
        evBtns.appendChild(btnEvAuto);
        a.push(evBtns);

        a.push(hdr('📜 Auto Mở Phúc Duyên'));
        const pdBtns = el('div', { css: 'display:flex;gap:4px;margin:4px 0' });
        pdBtns.appendChild(btn('⚡ Mở 10 Lần', () => {
            exchangePhucDuyen(10);
        }));
        let isPdRun = autoPDInterval !== null;
        const btnPdAuto = btn(isPdRun ? '⏹ Dừng' : '🔁 Auto Mở PD', () => {
            if (autoPDInterval) {
                clearInterval(autoPDInterval);
                autoPDInterval = null;
                btnPdAuto.innerText = '🔁 Auto Mở PD';
                btnPdAuto.style.background = '#a6e3a1';
            } else {
                btnPdAuto.innerText = '⏹ Dừng';
                btnPdAuto.style.background = '#f38ba8';
                autoPDInterval = setInterval(() => { clickOpenPhucDuyenOnce(); }, 100);
            }
        }, isPdRun ? 'background:#f38ba8;color:#111;' : 'background:#a6e3a1;color:#111;');
        pdBtns.appendChild(btnPdAuto);
        a.push(pdBtns);

        return a;
    }

    function tabWash() {
        const a = [];
        a.push(hdr('🛠️ Auto Tẩy Luyện Đồ Tốc Độ Cao'));
        a.push(note('🎯 Tự động dừng lại khi trang bị ra dòng:\n[Kỹ năng vốn có: +2]'));

        const btnTayLuyen = el('button', {
            id: 'v-btn-do-tayluyen',
            text: isTayLuyenRunning ? '⏹️ Dừng Tẩy' : '▶️ Bắt Đầu Tẩy',
            css: BCSS + 'width:100%;padding:8px 0;font-weight:bold;font-size:13px;margin-top:6px;background:' + (isTayLuyenRunning ? '#f38ba8;color:#111' : '#a6e3a1;color:#111'),
            on: () => {
                isTayLuyenRunning = !isTayLuyenRunning;
                if (isTayLuyenRunning) {
                    btnTayLuyen.innerText = '⏹️ Dừng Tẩy';
                    btnTayLuyen.style.background = '#f38ba8';
                    tayLuyenInterval = setInterval(checkTargetStatsAndClick, 50);
                } else {
                    stopTayLuyen();
                    btnTayLuyen.innerText = '▶️ Bắt Đầu Tẩy';
                    btnTayLuyen.style.background = '#a6e3a1';
                }
            }
        });
        a.push(btnTayLuyen);
        return a;
    }

    function tabEls() {
        if (C.tab === 'act') return tabAct();
        if (C.tab === 'bag') return tabBag();
        if (C.tab === 'pot') return tabPot();
        if (C.tab === 'speed') return tabSpeed();
        if (C.tab === 'speedhn') return tabHNSpeed();
        if (C.tab === 'event') return tabEvent();
        if (C.tab === 'wash') return tabWash();
        if (C.tab === 'reset') return tabReset();
        return tabAct();
    }

    function stat() {
        if (!box || !SH) return;
        const okSys = !!(X && window.__VLX && X.ev);
        SH.textContent = (okSys ? '🟢 Hệ thống: Ổn định' : '🔴 Hệ thống: Chưa kết nối');
        SH.style.color = okSys ? '#8f8' : '#f66';
        SH.style.whiteSpace = 'pre-wrap';
        if (!okSys) {
            const detail = M.file
                ? ('g.js: đã bắt | ' + (M.how || 'đang nạp') + '\n' + (M.why.ns || 'chưa kiểm tra Ns') + '\n' + (M.why.insert || M.why.build || 'chưa chèn API'))
                : (M.why.late || M.why.fetch || 'Chưa bắt được file g.js');
            SH.textContent += '\n' + detail;
        }
    }

    /* ===== 7. ĐIỀU KHIỂN UI MENU DỌC & NÚT BÀN TAY ===== */
    function toggleMenu() {
        menuOpen = !menuOpen;
        if (!menuDock) return;
        if (menuOpen) {
            positionDockMenu();
            menuDock.style.display = 'flex';
        } else {
            menuDock.style.display = 'none';
        }
    }

    function positionDockMenu() {
        if (!handBtn || !menuDock) return;
        const rect = handBtn.getBoundingClientRect();
        const leftPos = (rect.left + 58);
        const windowWidth = window.innerWidth;
        if (leftPos + 150 > windowWidth) {
            menuDock.style.left = (rect.left - 158) + 'px';
        } else {
            menuDock.style.left = leftPos + 'px';
        }
        menuDock.style.top = rect.top + 'px';
    }
    // ===== CẬP NHẬT GITHUB TÍCH HỢP (không cần Bootstrap riêng) =====
    // Bộ tải GitHub nằm ngay trong script.user.js, không mở trang GitHub.
    const VLM_UPDATE_VERSION = '6.1';
    let vlmUpdateBusy = false;

    // Giao tiếp với bộ cập nhật ở userscript manager qua DOM event.
    // Cách này hoạt động cả khi unsafeWindow và window nằm ở isolated world khác nhau.
    let vlmUpdaterRequestSeq = 0;
    function vlmRequestUpdater(action) {
        return new Promise((resolve, reject) => {
            const requestId = 'vlm-' + Date.now() + '-' + (++vlmUpdaterRequestSeq);
            let settled = false;
            const cleanup = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timeoutId);
                document.removeEventListener('vlmod:updater:response', onResponse);
            };
            const timeoutId = setTimeout(() => {
                cleanup();
                reject(new Error('Không nhận được phản hồi từ bộ cập nhật All-in-One. Hãy cài file script.user.js v5.8 duy nhất trong Stay/Tampermonkey, tắt Auto cũ và tải lại game.'));
            }, 30000);
            const onResponse = event => {
                const data = event && event.detail;
                if (!data || data.requestId !== requestId) return;
                cleanup();
                if (!data.ok) reject(new Error(data.error || 'Bộ cập nhật không xử lý được yêu cầu.'));
                else resolve(data.result);
            };
            document.addEventListener('vlmod:updater:response', onResponse);
            try {
                document.dispatchEvent(new CustomEvent('vlmod:updater:request', {
                    detail: { requestId, action, currentVersion: VLM_UPDATE_VERSION }
                }));
            } catch (error) {
                cleanup();
                reject(error);
            }
        });
    }

    async function vlmRunUpdater(button) {
        if (vlmUpdateBusy) return;
        vlmUpdateBusy = true;
        const oldText = button ? button.textContent : '';
        if (button) {
            button.disabled = true;
            button.textContent = '⏳ ĐANG TẢI BẢN MỚI...';
        }
        try {
            const result = await vlmRequestUpdater('update');
            if (result && result.updated) {
                if (button) button.textContent = '✅ ĐÃ LƯU v' + result.version + ' · ĐANG TẢI LẠI';
                // Userscript All-in-One tự tải lại game sau khi lưu; không mở GitHub.
                return;
            }
            const latest = result && result.version ? result.version : 'không rõ';
            if (button) button.textContent = '✅ ĐÃ LÀ BẢN MỚI NHẤT';
            alert('Auto hiện tại: v' + VLM_UPDATE_VERSION + '. GitHub: v' + latest + '. Không có bản mới hơn.');
        } catch (err) {
            if (button) button.textContent = '⚠ LỖI CẬP NHẬT';
            alert('Cập nhật thất bại: ' + (err && err.message ? err.message : err));
        } finally {
            setTimeout(() => {
                if (button && button.isConnected) {
                    button.disabled = false;
                    button.textContent = oldText || 'Cập nhật';
                }
                vlmUpdateBusy = false;
            }, 5000);
        }
    }

    // Thông báo cập nhật tự động: không dùng alert, có thể đóng và chỉ hiện lại khi có phiên bản mới hơn.
    const VLM_UPDATE_DISMISS_KEY = '__vlm_update_dismissed_version';
    let vlmUpdateNoticeElement = null;

    function vlmShowUpdateNotice(remoteVersion) {
        try {
            if (localStorage.getItem(VLM_UPDATE_DISMISS_KEY) === remoteVersion) return;
        } catch (e) { }

        if (!document.body) return;
        const oldNotice = document.getElementById('vlm-update-notice');
        if (oldNotice) oldNotice.remove();

        const notice = document.createElement('div');
        notice.id = 'vlm-update-notice';
        notice.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;width:min(440px,calc(100vw - 24px));box-sizing:border-box;padding:10px 12px;background:#202b3b;color:#fff;border:1px solid #4b8bd8;border-radius:10px;box-shadow:0 5px 22px rgba(0,0,0,.45);font:13px/1.4 Arial,sans-serif;display:flex;align-items:center;gap:10px;';

        const message = document.createElement('div');
        message.style.cssText = 'flex:1;min-width:0;';
        message.innerHTML = '<b style="color:#9fd0ff">Có bản Auto mới!</b><br><span style="color:#e8edf5">Phiên bản hiện tại: v' + VLM_UPDATE_VERSION + ' · Mới: v' + remoteVersion + '</span>';

        const updateBtn = document.createElement('button');
        updateBtn.type = 'button';
        updateBtn.textContent = 'Cập nhật';
        updateBtn.style.cssText = 'flex:0 0 auto;padding:7px 10px;background:#238636;color:#fff;border:0;border-radius:6px;font-weight:bold;cursor:pointer;';
        updateBtn.onclick = function () {
            vlmRunUpdater(updateBtn);
        };

        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.textContent = '×';
        closeBtn.title = 'Ẩn thông báo phiên bản này';
        closeBtn.style.cssText = 'flex:0 0 auto;width:26px;height:26px;padding:0;background:transparent;color:#cbd5e1;border:0;font-size:22px;line-height:1;cursor:pointer;';
        closeBtn.onclick = function () {
            try { localStorage.setItem(VLM_UPDATE_DISMISS_KEY, remoteVersion); } catch (e) { }
            notice.remove();
            vlmUpdateNoticeElement = null;
        };

        notice.appendChild(message);
        notice.appendChild(updateBtn);
        notice.appendChild(closeBtn);
        document.body.appendChild(notice);
        vlmUpdateNoticeElement = notice;
    }

    async function vlmCheckForUpdateNotice() {
        if (vlmUpdateBusy || !document.body) return;
        vlmUpdateBusy = true;
        try {
            const result = await vlmRequestUpdater('check');
            if (result && result.newer && result.version) {
                vlmShowUpdateNotice(String(result.version));
            }
        } catch (err) {
            console.warn('[Auto] Không kiểm tra được cập nhật:', err && err.message ? err.message : err);
        } finally {
            vlmUpdateBusy = false;
        }
    }

    function openTab(tabId) {
        menuOpen = false;
        menuDock.style.display = 'none';

        if (tabId === 'update') {
            vlmRunUpdater(null);
            return;
        }

        // Mở Ns Mod bằng API của module, không mở nhầm tab Auto Hoài Niệm.
        if (tabId === 'nsmod') {
            handBtn.style.display = 'flex';
            box.style.display = 'none';
            if (typeof window.__vltkOpenPanel === 'function') {
                window.__vltkOpenPanel();
            } else {
                alert('Ns Mod chưa khởi tạo xong. Vui lòng tải lại game và thử lại.');
            }
            return;
        }

        C.tab = tabId;
        save();
        handBtn.style.display = 'none';
        box.style.display = 'block';
        draw();
    }

    function closeBoxUI() {
        box.style.display = 'none';
        handBtn.style.display = 'flex';
        menuDock.style.display = 'none';
        menuOpen = false;
    }

    function draw() {
        if (!box) return;
        box.textContent = ''; INFO = null;

        const titleMap = {
            act: '⚔ HOẠT ĐỘNG', bag: '🎒 QUẢN LÝ TÚI', pot: '⚡ TIỀM NĂNG',
            speed: '⚡ HACK SPEED', speedhn: '🐎 SPEED HN', event: '🎁 EVENT & PHÚC DUYÊN', wash: '🛠️ AUTO TẨY LUYỆN', reset: '🔄 RESET'
        };

        const head = el('div', { css: 'display:flex;justify-content:space-between;align-items:center;cursor:move;user-select:none;font-weight:bold;color:#fc6;margin-bottom:6px;background:#232334;padding:4px 8px;border-radius:5px;' },
            '🖐️ ' + (titleMap[C.tab] || 'AUTO TOOL'), el('button', { text: '✖', css: 'background:#f38ba8;color:#111;border:none;border-radius:4px;width:22px;height:22px;cursor:pointer;font-weight:bold', on: e => { e.stopPropagation(); closeBoxUI(); } }));

        bindDrag(head, box, (left, top) => {
            C.pos = [left, top];
            save();
        });

        box.appendChild(head);

        SH = el('div', { css: 'color:#8f8;margin-bottom:6px;font-size:11px' }); box.appendChild(SH);

        B = el('div'); for (const e of tabEls()) B.appendChild(e); box.appendChild(B);
        stat();
    }

    function bindDrag(dragEl, targetEl, onSave, onEndClick) {
        let startX = 0, startY = 0, moved = false;

        const getClientPos = (e) => {
            if (e.touches && e.touches.length > 0) {
                return { x: e.touches[0].clientX, y: e.touches[0].clientY };
            }
            return { x: e.clientX, y: e.clientY };
        };

        const start = (e) => {
            if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
            const p = getClientPos(e);
            const r = targetEl.getBoundingClientRect();
            startX = p.x;
            startY = p.y;
            const dx = p.x - r.left;
            const dy = p.y - r.top;
            moved = false;

            const move = (ev) => {
                const pos = getClientPos(ev);
                if (Math.hypot(pos.x - startX, pos.y - startY) > 8) {
                    moved = true;
                    targetEl.style.left = Math.max(0, pos.x - dx) + 'px';
                    targetEl.style.top = Math.max(0, pos.y - dy) + 'px';
                    targetEl.style.right = 'auto';
                    if (targetEl === handBtn) positionDockMenu();
                }
            };

            const end = (ev) => {
                document.removeEventListener('mousemove', move);
                document.removeEventListener('mouseup', end);
                document.removeEventListener('touchmove', move);
                document.removeEventListener('touchend', end);

                if (moved) {
                    if (onSave) onSave(targetEl.style.left, targetEl.style.top);
                } else {
                    if (onEndClick) onEndClick(false);
                }
            };

            document.addEventListener('mousemove', move);
            document.addEventListener('mouseup', end);
            document.addEventListener('touchmove', move, { passive: true });
            document.addEventListener('touchend', end);
        };

        dragEl.addEventListener('mousedown', start);
        dragEl.addEventListener('touchstart', start, { passive: true });
    }

    function initUI() {
        if (handBtn || !document.body) return;

        handBtn = el('div', {
            id: 'vlHandBtn',
            css: `position:fixed;top:150px;left:15px;z-index:2147483647;width:48px;height:48px;border-radius:50%;background:#181825;border:2px solid #ffe066;box-shadow:0 4px 15px rgba(0,0,0,0.8);display:flex;align-items:center;justify-content:center;cursor:pointer;user-select:none;touch-action:none;`
        }, el('span', { text: '✋', css: 'font-size:24px;pointer-events:none;filter:drop-shadow(0 2px 3px rgba(0,0,0,0.5));' }));

        if (Array.isArray(C.handPos)) {
            handBtn.style.left = C.handPos[0];
            handBtn.style.top = C.handPos[1];
            handBtn.style.right = 'auto';
        }

        bindDrag(handBtn, handBtn,
            (left, top) => { C.handPos = [left, top]; save(); },
            (hasMoved) => { toggleMenu(); }
        );

        document.body.appendChild(handBtn);

        menuDock = el('div', {
            id: 'vlMenuDock',
            css: `position:fixed;z-index:2147483646;display:none;flex-direction:column;gap:5px;background:#1e1b2e;border:2px solid #ffe066;border-radius:12px;padding:8px;box-shadow:0 4px 15px rgba(0,0,0,0.8);width:150px;`
        });

        MENU_ITEMS.forEach(item => {
            const mBtn = el('button', {
                text: item.title,
                css: `background:#323047;color:#fce085;border:1px solid #4a4768;border-radius:8px;padding:8px 12px;font:bold 12px Arial,sans-serif;cursor:pointer;text-align:left;white-space:nowrap;transition:background 0.2s;`,
                on: (e) => {
                    e.stopPropagation();
                    openTab(item.id);
                }
            });
            mBtn.onmouseover = () => { mBtn.style.background = '#494666'; };
            mBtn.onmouseout = () => { mBtn.style.background = '#323047'; };
            menuDock.appendChild(mBtn);
        });
        document.body.appendChild(menuDock);

        box = el('div', { id: 'vlm8', css: 'position:fixed;top:150px;left:180px;z-index:2147483647;width:300px;max-height:85vh;overflow:auto;background:#181825;color:#eee;font:12px/1.35 Arial,sans-serif;border:2px solid #ffe066;border-radius:10px;padding:10px;box-shadow:0 5px 20px rgba(0,0,0,0.9);display:none;' });
        if (Array.isArray(C.pos)) { box.style.left = C.pos[0]; box.style.top = C.pos[1]; box.style.right = 'auto' }
        document.body.appendChild(box);
        draw();
    }

    whenBody(() => {
        setTimeout(() => { if (!handBtn) initUI(); }, 1000);
        // Kiểm tra sau khi game tải xong, rồi kiểm tra lại mỗi 30 phút.
        setTimeout(vlmCheckForUpdateNotice, 8000);
        setInterval(vlmCheckForUpdateNotice, 30 * 60 * 1000);
    });
})();

/* ===== MODULE Ns MOD (giữ nguyên mã gốc, tách IIFE) ===== */
(function () {
    'use strict';

    const CURRENT_VERSION = "15.4";

    try {
        localStorage.setItem('__vltk_active_script_version', CURRENT_VERSION);
    } catch(e) {}

    if (window.__vltkNsModLoaded) {
        if (typeof window.__vltkDestroyUI === 'function') window.__vltkDestroyUI();
    }
    window.__vltkNsModLoaded = true;

    // Danh sách tra cứu mã thuộc tính mở rộng
    const ATTR_MAP = {
        71: "tấn công chí mạng",
        85: "sinh lực tối đa",
        86: "sinh lực tối đa",
        88: "phục hồi sinh lực nữa giây",
        89: "nội lực",
        93: "thể lực",
        97: "sức mạnh",
        99: "sinh khí",
        101: "Lực Bảo Thạch",
        103: "kháng lôi",
        105: "kháng băng",
        108: "thời gian trúng độc",
        110: "thời gian choáng",
        113: "thời gian phục hồi",
        114: "kháng tất cả",
        115: "Tốc độ đánh - ngoại công",
        121: "Dao nhọn",
        122: "Hoả Sát - Ngoại Công",
        126: "Sát thương vật lý - ngoại công",
        134: "chuyển hoá sát thương thành nội lực",
        135: "may mắn",
        136: "hút sinh lực",
        137: "hút nội lực",
        139: "kỹ năng vốn có",
        168: "sát thương chiêu hệ kim",
        169: "sát thương chiêu hệ thuỷ",
        170: "sát thương chiêu hệ hoả",
        171: "sát thương chiêu hệ thổ",
        172: "sát thương chiêu hệ mộc",
        173: "đòn chí tử",
        176: "kinh nghiệm nhận được đánh quái"
    };

    // DANH SÁCH GHI CHÚ MẶC ĐỊNH
    const DEFAULT_NOTES = [
        { id: 237, text: "triệt tiêu sát thương", time: "19:20" },
        { id: 226, text: "xác xuất hoá giải sát thương", time: "19:02" },
        { id: 261, text: "tỷ lệ tạo thành choáng", time: "13:06" },
        { id: 243, text: "tăng công kích kỹ năng %", time: "13:05" },
        { id: 102, text: "kháng hoá", time: "11:52" },
        { id: 101, text: "kháng độc", time: "11:51" },
        { id: 130, text: "reborn chuyển sinh", time: "11:09" },
        { id: 131, text: "tower tầng tháp 1", time: "11:08" },
        { id: 132, text: "rw.df phúc duyên", time: "11:06" },
        { id: 97, text: "sức mạnh", time: "18:45" },
        { id: 103, text: "kháng lôi", time: "18:43" },
        { id: 113, text: "thời gian phục hồi", time: "18:43" },
        { id: 88, text: "phục hồi sinh lực nữa giây", time: "18:39" },
        { id: 108, text: "thời gian trúng độc", time: "18:39" },
        { id: 105, text: "kháng băng", time: "18:36" },
        { id: 89, text: "nội lực", time: "18:15" },
        { id: 110, text: "thời gian choáng", time: "18:15" },
        { id: 85, text: "sinh lực tối đa", time: "18:14" },
        { id: 99, text: "sinh khí", time: "18:14" },
        { id: 93, text: "thể lực", time: "18:14" },
        { id: 86, text: "sinh lực tối đa", time: "18:12" },
        { id: 71, text: "tấn công chí mạng", time: "18:11" },
        { id: 134, text: "chuyển hoá sát thương thành nội lực", time: "16:08" },
        { id: 168, text: "sát thương chiêu hệ kim", time: "16:06" },
        { id: 169, text: "sát thương chiêu hệ thuỷ", time: "16:05" },
        { id: 170, text: "sát thương chiêu hệ hoả", time: "16:05" },
        { id: 173, text: "đòn chí tử", time: "16:05" },
        { id: 172, text: "sát thương chiêu hệ mộc", time: "16:04" },
        { id: 171, text: "sát thương chiêu hệ thổ", time: "16:04" },
        { id: 137, text: "hút nội lực", time: "16:02" },
        { id: 176, text: "kinh nghiệm nhận được đánh quái", time: "16:01" },
        { id: 139, text: "kỹ năng vốn có", time: "16:00" },
        { id: 126, text: "sát thương vật lý - Ngoại công", time: "16:00" },
        { id: 115, text: "Tốc độ đánh - Ngoại công", time: "16:00" },
        { id: 135, text: "May mắn", time: "15:59" },
        { id: 136, text: "Hút sinh lực", time: "15:59" },
        { id: 114, text: "Kháng tất cả", time: "15:59" },
        { id: 122, text: "Hoả Sát - Ngoại Công", time: "15:58" }
    ];

    if (!window.__vltkIpPatched) {
        window.__vltkIpPatched = true;
        const FAKE_IP = "103.142.139." + Math.floor(Math.random() * 250 + 1);
        window.__vltkFakeIp = FAKE_IP;
        const origOpen = XMLHttpRequest.prototype.open;
        const origSend = XMLHttpRequest.prototype.send;

        XMLHttpRequest.prototype.open = function () {
            this._url = arguments[1];
            return origOpen.apply(this, arguments);
        };

        XMLHttpRequest.prototype.send = function () {
            try {
                this.setRequestHeader('X-Forwarded-For', FAKE_IP);
                this.setRequestHeader('X-Real-IP', FAKE_IP);
                this.setRequestHeader('Client-IP', FAKE_IP);
            } catch (e) {}
            return origSend.apply(this, arguments);
        };
    }

    const FAKE_IP = window.__vltkFakeIp || "103.142.139.1";

    function patchCode(code) {
        const marker = /\blet\s+e\s*=\s*0\s*;/;
        if (marker.test(code)) {
            return code.replace(marker, match => {
                return match +
                    '\ntry {' +
                    ' window.__vltkGetNs = function(){ try { return (typeof Ns !== "undefined") ? Ns : undefined; } catch(_e) { return undefined; } };' +
                    ' window.Ns = window.__vltkGetNs();' +
                    '} catch (__vltkHookErr) {}' +
                    '\n';
            });
        }
        return code;
    }

    function tryCaptureNs() {
        try {
            if (typeof window.Ns !== 'undefined' && window.Ns !== null) return true;
            if (typeof window.__vltkGetNs === 'function') {
                const ns = window.__vltkGetNs();
                if (ns) { window.Ns = ns; return true; }
            }
        } catch (e) {}
        return false;
    }

    // Bản gộp đã có Auto Hoài Niệm điều khiển việc nạp g.js; không chặn lần hai.
    // Khi chạy riêng lẻ (không có __VLM), vẫn giữ nguyên cơ chế hook g.js của Ns Mod.
    if (!window.__VLM && !window.__vltkHookStarted) {
        window.__vltkHookStarted = true;

        const originalFetch = window.fetch;
        window.fetch = function () {
            const url = arguments[0];
            if (typeof url === 'string' && url.indexOf('g.js') !== -1) {
                return originalFetch.apply(this, arguments).then(res => {
                    return res.text().then(code => {
                        const patched = patchCode(code);
                        return new Response(patched, {
                            status: res.status,
                            statusText: res.statusText,
                            headers: res.headers
                        });
                    });
                });
            }
            return originalFetch.apply(this, arguments);
        };

        const observer = new MutationObserver(function (mutations) {
            mutations.forEach(function (mutation) {
                mutation.addedNodes.forEach(function (node) {
                    if (node.tagName === 'SCRIPT' && node.src && node.src.indexOf('g.js') !== -1) {
                        const scriptUrl = node.src;
                        node.type = 'javascript/blocked';
                        if (node.parentElement) node.parentElement.removeChild(node);

                        originalFetch(scriptUrl)
                            .then(res => res.text())
                            .then(code => {
                                const patchedCode = patchCode(code);
                                const newScript = document.createElement('script');
                                newScript.textContent = patchedCode;
                                (document.head || document.documentElement).appendChild(newScript);
                            })
                            .catch(err => console.error('[Auto Script] Error:', err));
                    }
                });
            });
        });

        observer.observe(document, { childList: true, subtree: true });
    }

    // Luôn kiểm tra biến Ns: trong bản gộp, cầu nối được Auto Hoài Niệm gắn vào g.js.
    if (!window.__vltkNsCaptureTimer) {
        window.__vltkNsCaptureTimer = setInterval(tryCaptureNs, 1000);
        ['touchstart', 'click', 'mousedown'].forEach(evt => {
            window.addEventListener(evt, tryCaptureNs, { passive: true });
        });
    }

    function makeDraggable(element, handle, onClickCallback) {
        let posX = 0, posY = 0, initialX = 0, initialY = 0;
        let isMoved = false;

        handle.style.cursor = 'move';
        handle.style.touchAction = 'none';

        handle.addEventListener('mousedown', dragStart);
        handle.addEventListener('touchstart', dragStart, { passive: false });

        function dragStart(e) {
            isMoved = false;
            if (e.type === 'touchstart') {
                initialX = e.touches[0].clientX - posX;
                initialY = e.touches[0].clientY - posY;
                document.addEventListener('touchmove', drag, { passive: false });
                document.addEventListener('touchend', dragEnd);
            } else {
                initialX = e.clientX - posX;
                initialY = e.clientY - posY;
                document.addEventListener('mousemove', drag);
                document.addEventListener('mouseup', dragEnd);
            }
        }

        function drag(e) {
            const currentX = (e.type === 'touchmove') ? e.touches[0].clientX : e.clientX;
            const currentY = (e.type === 'touchmove') ? e.touches[0].clientY : e.clientY;

            if (Math.abs(currentX - (initialX + posX)) > 6 || Math.abs(currentY - (initialY + posY)) > 6) {
                isMoved = true;
                if (e.cancelable) e.preventDefault();
                posX = currentX - initialX;
                posY = currentY - initialY;
                element.style.transform = `translate3d(${posX}px, ${posY}px, 0)`;
            }
        }

        function dragEnd(e) {
            document.removeEventListener('mousemove', drag);
            document.removeEventListener('mouseup', dragEnd);
            document.removeEventListener('touchmove', drag);
            document.removeEventListener('touchend', dragEnd);

            if (!isMoved && typeof onClickCallback === 'function') {
                if (e.cancelable) e.preventDefault();
                onClickCallback();
            }
        }
    }

    let searchDebounceTimer = null;
    let lastSearchQuery = null;
    let sharedNotesData = [];

    window.__vltkDestroyUI = function () {
        const oldToggle = document.getElementById('vltk-ns-open-wrapper');
        const oldPanel = document.getElementById('vltk-ns-panel');
        if (oldToggle) oldToggle.remove();
        if (oldPanel) oldPanel.remove();
        if (window.__vltkSyncInterval) clearInterval(window.__vltkSyncInterval);
    };

    function updateDatalist() {
        let dl = document.getElementById('vltk-attr-datalist');
        if (!dl) {
            dl = document.createElement('datalist');
            dl.id = 'vltk-attr-datalist';
            document.body.appendChild(dl);
        }
        dl.innerHTML = '';
        sharedNotesData.forEach(item => {
            const opt = document.createElement('option');
            const noteText = item.text || item.name || '';
            opt.value = `${item.id}: ${noteText}`;
            dl.appendChild(opt);
        });
    }

    function parseIdFromInput(inputStr) {
        if (!inputStr) return null;
        let str = String(inputStr).trim();
        if (str.includes(':')) {
            let idPart = str.split(':')[0].trim();
            if (!isNaN(idPart) && idPart !== '') return idPart;
        }
        let found = sharedNotesData.find(n => {
            let noteText = (n.text || n.name || '').toLowerCase();
            return String(n.id) === str || noteText === str.toLowerCase();
        });
        if (found) return String(found.id);
        return null;
    }

    function getSelectedItemObject(targetPath) {
        tryCaptureNs();
        const ns = window.Ns;
        if (!ns || !targetPath) return null;

        if (targetPath.startsWith('inv.')) {
            let idx = parseInt(targetPath.replace('inv.', ''));
            let invList = ns.inv || ns.bag;
            if (invList && invList[idx]) return invList[idx];
        } else if (targetPath.startsWith('eq.')) {
            let slot = targetPath.replace('eq.', '');
            if (ns.eq && ns.eq[slot]) return ns.eq[slot];
        }
        return null;
    }

    function saveNotesToStorage() {
        try {
            localStorage.setItem('__vltk_shared_notes', JSON.stringify(sharedNotesData));
        } catch (e) {}
        updateDatalist();
    }

    // Tự động tạo 100% mã nguồn Userscript hoàn chỉnh nhúng Ghi chú mới nhất
    function generateFullScriptSource() {
        const notesJson = JSON.stringify(sharedNotesData, null, 8);

        return `// ==UserScript==
// @name         Mod trang bị
// @namespace    https://tampermonkey.net/
// @version      ${CURRENT_VERSION}
// @description  v${CURRENT_VERSION}: Mod trang bị & tự động lưu ghi chú.
// @author       Phan Hồng Hà
// @match        https://hoaniemi2003.net/vltk/*
// @match        https://hoainiem2003.net/vltk/*
// @match        https://volamidle.pages.dev/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const CURRENT_VERSION = "${CURRENT_VERSION}";

    try {
        localStorage.setItem('__vltk_active_script_version', CURRENT_VERSION);
    } catch(e) {}

    if (window.__vltkNsModLoaded) {
        if (typeof window.__vltkDestroyUI === 'function') window.__vltkDestroyUI();
    }
    window.__vltkNsModLoaded = true;

    const ATTR_MAP = {
        71: "tấn công chí mạng",
        85: "sinh lực tối đa",
        86: "sinh lực tối đa",
        88: "phục hồi sinh lực nữa giây",
        89: "nội lực",
        93: "thể lực",
        97: "sức mạnh",
        99: "sinh khí",
        101: "Lực Bảo Thạch",
        103: "kháng lôi",
        105: "kháng băng",
        108: "thời gian trúng độc",
        110: "thời gian choáng",
        113: "thời gian phục hồi",
        114: "kháng tất cả",
        115: "Tốc độ đánh - ngoại công",
        121: "Dao nhọn",
        122: "Hoả Sát - Ngoại Công",
        126: "Sát thương vật lý - ngoại công",
        134: "chuyển hoá sát thương thành nội lực",
        135: "may mắn",
        136: "hút sinh lực",
        137: "hút nội lực",
        139: "kỹ năng vốn có",
        168: "sát thương chiêu hệ kim",
        169: "sát thương chiêu hệ thuỷ",
        170: "sát thương chiêu hệ hoả",
        171: "sát thương chiêu hệ thổ",
        172: "sát thương chiêu hệ mộc",
        173: "đòn chí tử",
        176: "kinh nghiệm nhận được đánh quái"
    };

    const DEFAULT_NOTES = ${notesJson};

    if (!window.__vltkIpPatched) {
        window.__vltkIpPatched = true;
        const FAKE_IP = "103.142.139." + Math.floor(Math.random() * 250 + 1);
        window.__vltkFakeIp = FAKE_IP;
        const origOpen = XMLHttpRequest.prototype.open;
        const origSend = XMLHttpRequest.prototype.send;

        XMLHttpRequest.prototype.open = function () {
            this._url = arguments[1];
            return origOpen.apply(this, arguments);
        };

        XMLHttpRequest.prototype.send = function () {
            try {
                this.setRequestHeader('X-Forwarded-For', FAKE_IP);
                this.setRequestHeader('X-Real-IP', FAKE_IP);
                this.setRequestHeader('Client-IP', FAKE_IP);
            } catch (e) {}
            return origSend.apply(this, arguments);
        };
    }

    const FAKE_IP = window.__vltkFakeIp || "103.142.139.1";

    function patchCode(code) {
        const marker = /\blet\s+e\s*=\s*0\s*;/;
        if (marker.test(code)) {
            return code.replace(marker, match => {
                return match +
                    '\ntry {' +
                    ' window.__vltkGetNs = function(){ try { return (typeof Ns !== "undefined") ? Ns : undefined; } catch(_e) { return undefined; } };' +
                    ' window.Ns = window.__vltkGetNs();' +
                    '} catch (__vltkHookErr) {}' +
                    '\\n';
            });
        }
        return code;
    }

    function tryCaptureNs() {
        try {
            if (typeof window.Ns !== 'undefined' && window.Ns !== null) return true;
            if (typeof window.__vltkGetNs === 'function') {
                const ns = window.__vltkGetNs();
                if (ns) { window.Ns = ns; return true; }
            }
        } catch (e) {}
        return false;
    }

    if (!window.__vltkHookStarted) {
        window.__vltkHookStarted = true;

        const originalFetch = window.fetch;
        window.fetch = function () {
            const url = arguments[0];
            if (typeof url === 'string' && url.indexOf('g.js') !== -1) {
                return originalFetch.apply(this, arguments).then(res => {
                    return res.text().then(code => {
                        const patched = patchCode(code);
                        return new Response(patched, {
                            status: res.status,
                            statusText: res.statusText,
                            headers: res.headers
                        });
                    });
                });
            }
            return originalFetch.apply(this, arguments);
        };

        const observer = new MutationObserver(function (mutations) {
            mutations.forEach(function (mutation) {
                mutation.addedNodes.forEach(function (node) {
                    if (node.tagName === 'SCRIPT' && node.src && node.src.indexOf('g.js') !== -1) {
                        const scriptUrl = node.src;
                        node.type = 'javascript/blocked';
                        if (node.parentElement) node.parentElement.removeChild(node);

                        originalFetch(scriptUrl)
                            .then(res => res.text())
                            .then(code => {
                                const patchedCode = patchCode(code);
                                const newScript = document.createElement('script');
                                newScript.textContent = patchedCode;
                                (document.head || document.documentElement).appendChild(newScript);
                            })
                            .catch(err => console.error('[Auto Script] Error:', err));
                    }
                });
            });
        });

        observer.observe(document, { childList: true, subtree: true });

        setInterval(tryCaptureNs, 1000);
        ['touchstart', 'click', 'mousedown'].forEach(evt => {
            window.addEventListener(evt, tryCaptureNs, { passive: true });
        });
    }

    function makeDraggable(element, handle, onClickCallback) {
        let posX = 0, posY = 0, initialX = 0, initialY = 0;
        let isMoved = false;

        handle.style.cursor = 'move';
        handle.style.touchAction = 'none';

        handle.addEventListener('mousedown', dragStart);
        handle.addEventListener('touchstart', dragStart, { passive: false });

        function dragStart(e) {
            isMoved = false;
            if (e.type === 'touchstart') {
                initialX = e.touches[0].clientX - posX;
                initialY = e.touches[0].clientY - posY;
                document.addEventListener('touchmove', drag, { passive: false });
                document.addEventListener('touchend', dragEnd);
            } else {
                initialX = e.clientX - posX;
                initialY = e.clientY - posY;
                document.addEventListener('mousemove', drag);
                document.addEventListener('mouseup', dragEnd);
            }
        }

        function drag(e) {
            const currentX = (e.type === 'touchmove') ? e.touches[0].clientX : e.clientX;
            const currentY = (e.type === 'touchmove') ? e.touches[0].clientY : e.clientY;

            if (Math.abs(currentX - (initialX + posX)) > 6 || Math.abs(currentY - (initialY + posY)) > 6) {
                isMoved = true;
                if (e.cancelable) e.preventDefault();
                posX = currentX - initialX;
                posY = currentY - initialY;
                element.style.transform = \`translate3d(\${posX}px, \${posY}px, 0)\`;
            }
        }

        function dragEnd(e) {
            document.removeEventListener('mousemove', drag);
            document.removeEventListener('mouseup', dragEnd);
            document.removeEventListener('touchmove', drag);
            document.removeEventListener('touchend', dragEnd);

            if (!isMoved && typeof onClickCallback === 'function') {
                if (e.cancelable) e.preventDefault();
                onClickCallback();
            }
        }
    }

    let searchDebounceTimer = null;
    let lastSearchQuery = null;
    let sharedNotesData = [];

    window.__vltkDestroyUI = function () {
        const oldToggle = document.getElementById('vltk-ns-open-wrapper');
        const oldPanel = document.getElementById('vltk-ns-panel');
        if (oldToggle) oldToggle.remove();
        if (oldPanel) oldPanel.remove();
        if (window.__vltkSyncInterval) clearInterval(window.__vltkSyncInterval);
    };

    function updateDatalist() {
        let dl = document.getElementById('vltk-attr-datalist');
        if (!dl) {
            dl = document.createElement('datalist');
            dl.id = 'vltk-attr-datalist';
            document.body.appendChild(dl);
        }
        dl.innerHTML = '';
        sharedNotesData.forEach(item => {
            const opt = document.createElement('option');
            const noteText = item.text || item.name || '';
            opt.value = \`\${item.id}: \${noteText}\`;
            dl.appendChild(opt);
        });
    }

    function parseIdFromInput(inputStr) {
        if (!inputStr) return null;
        let str = String(inputStr).trim();
        if (str.includes(':')) {
            let idPart = str.split(':')[0].trim();
            if (!isNaN(idPart) && idPart !== '') return idPart;
        }
        let found = sharedNotesData.find(n => {
            let noteText = (n.text || n.name || '').toLowerCase();
            return String(n.id) === str || noteText === str.toLowerCase();
        });
        if (found) return String(found.id);
        return null;
    }

    function getSelectedItemObject(targetPath) {
        tryCaptureNs();
        const ns = window.Ns;
        if (!ns || !targetPath) return null;

        if (targetPath.startsWith('inv.')) {
            let idx = parseInt(targetPath.replace('inv.', ''));
            let invList = ns.inv || ns.bag;
            if (invList && invList[idx]) return invList[idx];
        } else if (targetPath.startsWith('eq.')) {
            let slot = targetPath.replace('eq.', '');
            if (ns.eq && ns.eq[slot]) return ns.eq[slot];
        }
        return null;
    }

    function saveNotesToStorage() {
        try {
            localStorage.setItem('__vltk_shared_notes', JSON.stringify(sharedNotesData));
        } catch (e) {}
        updateDatalist();
    }

    function installUI() {
        if (!document.body || document.getElementById('vltk-ns-open-wrapper')) return;

        const toggleContainer = document.createElement('div');
        toggleContainer.id = 'vltk-ns-open-wrapper';
        toggleContainer.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:999999;display:flex;flex-direction:column;align-items:flex-end;user-select:none;touch-action:none;';

        const toggle = document.createElement('button');
        toggle.id = 'vltk-ns-open';
        toggle.innerText = '⚙️ Ns Mod v' + CURRENT_VERSION;
        toggle.style.cssText = 'padding:12px 18px;background:#107c41;color:#fff;border:none;border-radius:20px;font-weight:bold;cursor:pointer;box-shadow:0 4px 10px rgba(0,0,0,0.5);-webkit-tap-highlight-color:transparent;position:relative;';

        toggleContainer.appendChild(toggle);
        document.body.appendChild(toggleContainer);

        let panel = null;

        function togglePanel() {
            if (!panel) {
                panel = buildPanel();
                document.body.appendChild(panel);
            } else {
                panel.style.display = (panel.style.display === 'none') ? 'flex' : 'none';
            }
            if (panel.style.display === 'flex') {
                populateTargetItemDropdown();
                refreshUI(true);
            }
        }

        makeDraggable(toggleContainer, toggle, togglePanel);

        function populateTargetItemDropdown() {
            const drop = document.getElementById('vltk-target-item-select');
            if (!drop) return;
            tryCaptureNs();
            const ns = window.Ns;

            drop.innerHTML = '<option value="">-- Chọn món đồ sẵn có để biến đổi / thêm dòng --</option>';
            if (!ns) return;

            const invList = ns.inv || ns.bag;
            if (Array.isArray(invList)) {
                invList.forEach((item, idx) => {
                    if (item && typeof item === 'object') {
                        let name = item.n || ("Vật phẩm Rương #" + idx);
                        let opt = document.createElement('option');
                        opt.value = \`inv.\${idx}\`;
                        opt.textContent = \`📦 Rương [\${idx}]: \${name} (t:\${item.t ?? '?'}, k:\${item.k ?? '?'})\`;
                        drop.appendChild(opt);
                    }
                });
            }

            if (ns.eq && typeof ns.eq === 'object') {
                for (let slot in ns.eq) {
                    let item = ns.eq[slot];
                    if (item && typeof item === 'object') {
                        let name = item.n || slot;
                        let opt = document.createElement('option');
                        opt.value = \`eq.\${slot}\`;
                        opt.textContent = \`🛡️ Đang mặc [\${slot}]: \${name} (t:\${item.t ?? '?'}, k:\${item.k ?? '?'})\`;
                        drop.appendChild(opt);
                    }
                }
            }
        }

        function buildPanel() {
            const box = document.createElement('div');
            box.id = 'vltk-ns-panel';
            box.style.cssText = 'position:fixed;top:40px;right:10px;width:min(560px, calc(100vw - 20px));height:min(82vh, calc(100vh - 60px));min-height:320px;background:#1e1e1e;color:#fff;border:2px solid #007acc;border-radius:8px;z-index:999999;font-family:monospace;display:flex;flex-direction:column;box-shadow:0 5px 20px rgba(0,0,0,0.6);';

            box.innerHTML =
                \`<div id="vltk-ns-header" style="padding:8px 10px;background:#007acc;font-weight:bold;display:flex;align-items:center;user-select:none;touch-action:none;">
                    <span style="font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">🖐️ Ns Editor v\${CURRENT_VERSION} (\${FAKE_IP})</span>
                    <button id="vltk-ns-close" style="margin-left:auto;background:none;border:none;color:#fff;cursor:pointer;font-size:18px;font-weight:bold;padding:0 4px;line-height:1;touch-action:manipulation;">✖</button>
                </div>

                <div style="display:flex;background:#2d2d2d;border-bottom:1px solid #444;">
                    <button id="tab-ns" style="flex:1;padding:8px 4px;background:#1e1e1e;color:#4ec9b0;border:none;border-bottom:2px solid #4ec9b0;font-weight:bold;font-size:12px;cursor:pointer;">⚙️ Sửa Ns</button>
                    <button id="tab-notes" style="flex:1;padding:8px 4px;background:#2d2d2d;color:#aaa;border:none;font-weight:bold;font-size:12px;cursor:pointer;">📝 Ghi Chú</button>
                </div>

                <div id="view-ns" style="display:flex;flex-direction:column;flex-grow:1;overflow:hidden;">
                    <div id="vltk-ns-status" style="padding:8px 10px;color:#dcdcaa;font-size:12px;border-bottom:1px solid #333;">Đang kiểm tra Ns...</div>

                    <div style="padding:8px 10px;background:#252526;border-bottom:1px solid #333;display:flex;flex-direction:column;gap:6px;">
                        <select id="vltk-target-item-select" style="width:100%;padding:6px 8px;background:#1e1e1e;color:#ffe875;border:1px solid #007acc;border-radius:4px;font-size:12px;font-weight:bold;cursor:pointer;">
                            <option value="">-- Chọn món đồ sẵn có để biến đổi / thêm dòng --</option>
                        </select>

                        <div style="display:flex;gap:6px;align-items:center;">
                            <input type="text" id="vltk-add-item-id" placeholder="k mới (25=Hươu, 0=Kiếm)..." style="flex:1;padding:6px 8px;background:#1e1e1e;color:#ffe875;border:1px solid #007acc;border-radius:4px;font-size:12px;font-weight:bold;">
                            <input type="text" id="vltk-add-item-p" placeholder="p mới (250)..." style="width:110px;padding:6px 8px;background:#1e1e1e;color:#9cdcfe;border:1px solid #007acc;border-radius:4px;font-size:12px;font-weight:bold;">
                        </div>

                        <div style="display:flex;gap:6px;">
                            <button id="vltk-swap-item-btn" style="flex:1;padding:6px 10px;background:#d7ba7d;color:#1e1e1e;border:none;border-radius:4px;font-weight:bold;font-size:11px;cursor:pointer;">🔄 Biến đổi k, p & cưỡi được</button>
                            <button id="vltk-add-base-btn" style="flex:1;padding:6px 10px;background:#00b4d8;color:#000;border:none;border-radius:4px;font-weight:bold;font-size:11px;cursor:pointer;">➕ Thêm dòng Trắng (base)</button>
                            <button id="vltk-add-mag-btn" style="flex:1;padding:6px 10px;background:#3a86ff;color:#fff;border:none;border-radius:4px;font-weight:bold;font-size:11px;cursor:pointer;">✨ Thêm dòng Thuộc tính (mag)</button>
                        </div>
                    </div>

                    <div style="padding:10px;border-bottom:1px solid #333;">
                        <input type="text" id="vltk-ns-search" placeholder="Gõ tên trang bị hoặc thuộc tính (VD: weapon, cuff, gold)..." style="width:100%;padding:8px;background:#2d2d2d;color:#fff;border:1px solid #444;border-radius:4px;box-sizing:border-box;font-size:13px;">
                    </div>
                    <div id="vltk-ns-list" style="padding:10px;overflow-y:auto;overflow-x:hidden;flex-grow:1;touch-action:pan-y;"></div>
                </div>

                <div id="view-notes" style="display:none;flex-direction:column;flex-grow:1;padding:10px;overflow:hidden;">
                    <div style="display:flex;gap:4px;margin-bottom:8px;flex-wrap:wrap;">
                        <input type="text" id="note-search" placeholder="🔍 Tìm ghi chú..." style="flex:1;min-width:120px;padding:6px;background:#2d2d2d;color:#fff;border:1px solid #444;border-radius:4px;font-size:12px;">
                        <button id="note-download-file" style="padding:6px 8px;background:#107c41;color:#fff;border:none;border-radius:4px;font-size:11px;font-weight:bold;cursor:pointer;">📥 Tải file .user.js</button>
                        <button id="note-copy-full-code" style="padding:6px 8px;background:#d7ba7d;color:#1e1e1e;border:none;border-radius:4px;font-size:11px;font-weight:bold;cursor:pointer;">📋 Copy toàn bộ Code</button>
                    </div>
                    <div style="display:flex;gap:6px;margin-bottom:8px;">
                        <input type="number" id="vltk-note-id" placeholder="ID (VD: 114)" style="width:100px;padding:8px;background:#2d2d2d;color:#ffe875;border:1px solid #444;border-radius:4px;font-size:13px;font-weight:bold;">
                        <input type="text" id="vltk-note-text" placeholder="Tên thuộc tính (VD: Kháng tất cả)" style="flex:1;padding:8px;background:#2d2d2d;color:#fff;border:1px solid #444;border-radius:4px;font-size:13px;">
                        <button id="note-add" style="padding:6px 12px;background:#00b4d8;color:#000;border:none;border-radius:4px;font-size:12px;font-weight:bold;cursor:pointer;">➕ Thêm</button>
                    </div>
                    <div id="note-list" style="flex-grow:1;overflow-y:auto;background:#252526;border:1px solid #333;border-radius:4px;padding:8px;">
                        <div style="color:#aaa;text-align:center;padding:10px;">Đang tải ghi chú...</div>
                    </div>
                </div>\`;

            setTimeout(() => {
                makeDraggable(box, document.getElementById('vltk-ns-header'));

                const tabNs = document.getElementById('tab-ns');
                const tabNotes = document.getElementById('tab-notes');
                const viewNs = document.getElementById('view-ns');
                const viewNotes = document.getElementById('view-notes');

                tabNs.onclick = () => {
                    tabNs.style.background = '#1e1e1e';
                    tabNs.style.color = '#4ec9b0';
                    tabNs.style.borderBottom = '2px solid #4ec9b0';
                    tabNotes.style.background = '#2d2d2d';
                    tabNotes.style.color = '#aaa';
                    tabNotes.style.borderBottom = 'none';
                    viewNs.style.display = 'flex';
                    viewNotes.style.display = 'none';
                    populateTargetItemDropdown();
                };

                tabNotes.onclick = () => {
                    tabNotes.style.background = '#1e1e1e';
                    tabNotes.style.color = '#4ec9b0';
                    tabNotes.style.borderBottom = '2px solid #4ec9b0';
                    tabNs.style.background = '#2d2d2d';
                    tabNs.style.color = '#aaa';
                    tabNs.style.borderBottom = 'none';
                    viewNotes.style.display = 'flex';
                    viewNs.style.display = 'none';
                    loadSharedNotes();
                };

                document.getElementById('vltk-ns-close').onclick = () => { box.style.display = 'none'; };

                // 1. Biến đổi k, p & Cưỡi
                document.getElementById('vltk-swap-item-btn').onclick = function () {
                    const selectEl = document.getElementById('vltk-target-item-select');
                    const idInput = document.getElementById('vltk-add-item-id');
                    const pInput = document.getElementById('vltk-add-item-p');

                    const targetPath = (selectEl ? selectEl.value : '').trim();
                    const rawK = (idInput.value || '').trim();
                    const rawP = (pInput.value || '').trim();

                    if (!targetPath) {
                        alert("Vui lòng chọn 1 món đồ sẵn có từ Menu!");
                        return;
                    }
                    if (!rawK) {
                        alert("Vui lòng nhập giá trị k mới!");
                        return;
                    }

                    let itemObj = getSelectedItemObject(targetPath);
                    if (!itemObj) {
                        alert("Không tìm thấy dữ liệu món đồ được chọn!");
                        return;
                    }

                    const valK = isNaN(rawK) ? rawK : Number(rawK);
                    const valP = rawP ? (isNaN(rawP) ? rawP : Number(rawP)) : 250;

                    let isMount = (valK === 25 || valK === 10 || String(valK).toLowerCase().includes('horse'));

                    if (isMount) {
                        itemObj.t = "horse";
                        itemObj.k = valK;
                        itemObj.p = valP;
                        itemObj.d = 10;
                        itemObj.n = "Hươu đốm";
                        itemObj.tm = "huoudom";
                        itemObj.ic = \`img/i/10_\${valP}.png\`;
                        itemObj.s = -1;
                        itemObj.r = 4;
                        itemObj.lock = true;

                        delete itemObj.base;
                        delete itemObj.atk;
                        delete itemObj.minAtk;
                        delete itemObj.maxAtk;

                        itemObj.mag = [
                            { a: 114, n: "Kháng tất cả", p: [50, -1, 6], pre: 1 },
                            { a: 115, n: "Tốc độ", p: [40, -1, 6], pre: 1 },
                            { a: 135, n: "May mắn", p: [30, -1, 6], pre: 1 }
                        ];
                    } else {
                        itemObj.t = "weapon";
                        itemObj.k = valK;
                        itemObj.p = valP;
                        itemObj.ic = \`img/i/g\${valP}.png\`;
                    }

                    try {
                        if (window.Ns && typeof window.Ns.update === 'function') window.Ns.update();
                        if (window.Ns && typeof window.Ns.render === 'function') window.Ns.render();
                    } catch (e) {}

                    alert(\`✅ Đã biến đổi hoàn chỉnh k=\${valK}, p=\${valP}!\`);
                    populateTargetItemDropdown();
                    refreshUI(true);
                };

                // 2. Thêm dòng trắng (base)
                document.getElementById('vltk-add-base-btn').onclick = function () {
                    const selectEl = document.getElementById('vltk-target-item-select');
                    const targetPath = (selectEl ? selectEl.value : '').trim();

                    if (!targetPath) {
                        alert("Vui lòng chọn món đồ từ Menu trước khi thêm dòng!");
                        return;
                    }

                    let itemObj = getSelectedItemObject(targetPath);
                    if (!itemObj) {
                        alert("Không tìm thấy món đồ!");
                        return;
                    }

                    const codeMinStr = prompt("Nhập Mã thuộc tính gốc (Ví dụ: 30 = Né tránh, 28 = Sát thương):", "30");
                    if (codeMinStr === null) return;
                    const codeMin = Number(codeMinStr) || 30;

                    const codeMaxStr = prompt("Nhập Mã ghép cặp (Ví dụ: 31 = Né tránh, 29 = Sát thương):", String(codeMin === 30 ? 31 : 29));
                    if (codeMaxStr === null) return;
                    const codeMax = Number(codeMaxStr) || 31;

                    let val1 = 0, val2 = 0;
                    if (codeMin === 28 || codeMin === 0) {
                        const minAtk = prompt("SÁT THƯƠNG: Nhập Sát thương Tối Thiểu (Min):", "108");
                        if (minAtk === null) return;
                        const maxAtk = prompt("SÁT THƯƠNG: Nhập Sát thương Tối Đa (Max):", "180");
                        if (maxAtk === null) return;
                        val1 = Number(minAtk) || 0;
                        val2 = Number(maxAtk) || 0;

                        itemObj.minAtk = val1;
                        itemObj.maxAtk = val2;
                    } else {
                        const defVal = prompt("NÉ TRÁNH / PHÒNG THỦ: Nhập điểm số (Ví dụ: 250 điểm):", "250");
                        if (defVal === null) return;
                        val1 = Number(defVal) || 0;
                        val2 = val1;

                        delete itemObj.minAtk;
                        delete itemObj.maxAtk;
                    }

                    itemObj.base = [
                        [codeMin, val1, val2],
                        [codeMax, val1, val2]
                    ];

                    try {
                        if (window.Ns && typeof window.Ns.update === 'function') window.Ns.update();
                        if (window.Ns && typeof window.Ns.render === 'function') window.Ns.render();
                    } catch (e) {}

                    alert(\`✅ Đã thêm dòng trắng base chuẩn!\`);
                    refreshUI(true);
                };

                // 3. Thêm dòng thuộc tính (mag) tự động tra tên theo ID
                document.getElementById('vltk-add-mag-btn').onclick = function () {
                    const selectEl = document.getElementById('vltk-target-item-select');
                    const targetPath = (selectEl ? selectEl.value : '').trim();

                    if (!targetPath) {
                        alert("Vui lòng chọn món đồ cần thêm dòng thuộc tính!");
                        return;
                    }

                    let itemObj = getSelectedItemObject(targetPath);
                    if (!itemObj) {
                        alert("Không tìm thấy món đồ!");
                        return;
                    }

                    if (!Array.isArray(itemObj.mag)) {
                        itemObj.mag = [];
                    }

                    const attrCodeStr = prompt("Nhập ID thuộc tính (a) (VD: 126=Sát thương vật lý, 168=Kim Ma, 139=Tông sư, 115=Tốc độ...):", "126");
                    if (attrCodeStr === null) return;
                    const attrCode = Number(attrCodeStr);

                    let autoName = ATTR_MAP[attrCode];
                    if (!autoName) {
                        const foundInNotes = sharedNotesData.find(n => Number(n.id) === attrCode);
                        if (foundInNotes) autoName = foundInNotes.text || foundInNotes.name;
                    }
                    if (!autoName) autoName = "Thuộc tính mới";

                    const attrValStr = prompt("Nhập Giá trị thuộc tính (Phần tử 0 trong mảng p):", "34");
                    if (attrValStr === null) return;
                    const attrVal = Number(attrValStr) || 0;

                    const attrLvlStr = prompt("Nhập Cấp độ thuộc tính (Phần tử 2 trong mảng p):", "6");
                    if (attrLvlStr === null) return;
                    const attrLvl = Number(attrLvlStr) || 6;

                    const preStr = prompt("Kích hoạt dòng (pre): Nhập 1 = Kích hoạt (Sáng), 0 = Dòng ẩn (Tối):", "1");
                    if (preStr === null) return;
                    const preVal = Number(preStr) === 0 ? 0 : 1;

                    const newMagObj = {
                        a: attrCode,
                        n: autoName,
                        p: [attrVal, -1, attrLvl],
                        pre: preVal
                    };

                    itemObj.mag.push(newMagObj);

                    try {
                        if (window.Ns && typeof window.Ns.update === 'function') window.Ns.update();
                        if (window.Ns && typeof window.Ns.render === 'function') window.Ns.render();
                    } catch (e) {}

                    alert(\`✅ Đã thêm dòng mag [\${attrCode}] "\${autoName}" với p: [\${attrVal}, -1, \${attrLvl}], pre: \${preVal}!\`);
                    refreshUI(true);
                };

                document.getElementById('vltk-ns-search').oninput = function () {
                    clearTimeout(searchDebounceTimer);
                    searchDebounceTimer = setTimeout(() => refreshUI(true), 200);
                };

                document.getElementById('note-add').onclick = addSharedNote;
                document.getElementById('note-search').oninput = renderNotesUI;

                document.getElementById('note-download-file').onclick = function () {
                    const fullCode = generateFullScriptSource();
                    const blob = new Blob([fullCode], { type: 'text/javascript;charset=utf-8' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = 'script.user.js';
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    URL.revokeObjectURL(url);
                    alert("📥 Đã tải file script.user.js chứa đầy đủ 100% Code + Ghi Chú mới nhất! Kéo thả file vào Tampermonkey máy mới là cài đặt xong!");
                };

                document.getElementById('note-copy-full-code').onclick = function () {
                    const fullCode = generateFullScriptSource();
                    if (navigator.clipboard && navigator.clipboard.writeText) {
                        navigator.clipboard.writeText(fullCode).then(() => {
                            alert("📋 Đã copy 100% TOÀN BỘ Mã nguồn Script kèm Ghi Chú mới nhất vào Clipboard! Sang máy mới chỉ cần nhấn Ctrl+V duy nhất 1 lần!");
                        }).catch(() => {
                            prompt("Hãy copy toàn bộ mã nguồn dưới đây dán vào Tampermonkey:", fullCode);
                        });
                    } else {
                        prompt("Hãy copy toàn bộ mã nguồn dưới đây dán vào Tampermonkey:", fullCode);
                    }
                };

                loadSharedNotes();

            }, 100);

            return box;
        }

        function loadSharedNotes() {
            const listEl = document.getElementById('note-list');
            if (listEl) listEl.innerHTML = '<div style="color:#aaa;text-align:center;padding:10px;">⏳ Đang tải ghi chú...</div>';

            try {
                const localData = localStorage.getItem('__vltk_shared_notes');
                sharedNotesData = localData ? JSON.parse(localData) : DEFAULT_NOTES;
            } catch (e) {
                sharedNotesData = DEFAULT_NOTES;
            }
            updateDatalist();
            renderNotesUI();
        }

        function addSharedNote() {
            const idInput = document.getElementById('vltk-note-id');
            const textInput = document.getElementById('vltk-note-text');
            const rawId = (idInput ? idInput.value : '').trim();
            const textVal = (textInput ? textInput.value : '').trim();

            if (!rawId || !textVal) {
                alert("Vui lòng nhập đầy đủ cả ID và Tên thuộc tính!");
                return;
            }

            const newNote = {
                id: isNaN(rawId) ? rawId : Number(rawId),
                text: textVal,
                time: new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })
            };

            sharedNotesData.unshift(newNote);
            saveNotesToStorage();

            if (idInput) idInput.value = '';
            if (textInput) textInput.value = '';

            renderNotesUI();
        }

        function renderNotesUI() {
            const listEl = document.getElementById('note-list');
            const searchEl = document.getElementById('note-search');
            if (!listEl) return;

            const query = (searchEl && searchEl.value || '').toLowerCase().trim();
            const filtered = sharedNotesData.filter(n => {
                const strText = (n.text || n.name || '');
                const strId = String(n.id);
                return !query || strText.toLowerCase().includes(query) || strId.includes(query);
            });

            if (filtered.length === 0) {
                listEl.innerHTML = '<div style="color:#888;text-align:center;padding:15px;">Không tìm thấy ghi chú phù hợp</div>';
                return;
            }

            const frag = document.createDocumentFragment();
            filtered.forEach((item) => {
                const div = document.createElement('div');
                div.style.cssText = 'background:#2d2d2d;padding:8px;border-radius:4px;margin-bottom:6px;border-left:3px solid #4ec9b0;font-size:12px;display:flex;justify-content:space-between;align-items:center;gap:8px;';

                const displayText = item.text || item.name || '';

                const contentDiv = document.createElement('div');
                contentDiv.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;';
                contentDiv.innerHTML = \`<span style="color:#ffe875;font-weight:bold;">\${escapeHtml(String(item.id))}: </span>
                                        <span style="color:#dcdcaa;">\${escapeHtml(displayText)}</span>
                                        <span style="color:#666;font-size:10px;margin-left:6px;">🕒 \${item.time || ''}</span>\`;

                const btnGroup = document.createElement('div');
                btnGroup.style.cssText = 'display:flex;gap:4px;flex-shrink:0;';

                const editBtn = document.createElement('button');
                editBtn.textContent = '✏️ Sửa';
                editBtn.style.cssText = 'padding:2px 6px;background:#0e639c;color:#fff;border:none;border-radius:3px;cursor:pointer;font-size:11px;';
                editBtn.onclick = function () {
                    const newIdStr = prompt("Sửa ID thuộc tính:", String(item.id));
                    if (newIdStr === null) return;
                    const newTextStr = prompt("Sửa Tên thuộc tính:", displayText);
                    if (newTextStr === null) return;

                    item.id = isNaN(newIdStr) ? newIdStr.trim() : Number(newIdStr);
                    item.text = newTextStr.trim();
                    item.time = new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });

                    saveNotesToStorage();
                    renderNotesUI();
                };

                const delBtn = document.createElement('button');
                delBtn.textContent = '🗑️ Xóa';
                delBtn.style.cssText = 'padding:2px 6px;background:#a91d22;color:#fff;border:none;border-radius:3px;cursor:pointer;font-size:11px;';
                delBtn.onclick = function () {
                    if (confirm(\`Bạn có chắc muốn xóa ghi chú [\${item.id}: \${displayText}] không?\`)) {
                        const realIdx = sharedNotesData.indexOf(item);
                        if (realIdx !== -1) {
                            sharedNotesData.splice(realIdx, 1);
                            saveNotesToStorage();
                            renderNotesUI();
                        }
                    }
                };

                btnGroup.appendChild(editBtn);
                btnGroup.appendChild(delBtn);

                div.appendChild(contentDiv);
                div.appendChild(btnGroup);
                frag.appendChild(div);
            });

            listEl.innerHTML = '';
            listEl.appendChild(frag);
        }

        function escapeHtml(str) {
            return String(str).replace(/[&<>"']/g, function (m) {
                return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m];
            });
        }

        window.__vltkSyncInterval = setInterval(() => {
            const currentPanel = document.getElementById('vltk-ns-panel');
            if (currentPanel && currentPanel.style.display !== 'none') {
                const active = document.activeElement;
                if (active && currentPanel.contains(active) && /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(active.tagName)) {
                    return;
                }
            }
        }, 5000);

        function refreshUI(force = false) {
            const listContainer = document.getElementById('vltk-ns-list');
            const statusEl = document.getElementById('vltk-ns-status');
            const searchInput = document.getElementById('vltk-ns-search');
            if (!listContainer) return;

            tryCaptureNs();
            const ns = window.Ns;

            if (!ns) {
                if (statusEl) {
                    statusEl.textContent = '⏳ Đang chờ Ns... Bạn di chuyển nhân vật 1 bước nhé!';
                    statusEl.style.color = '#e5c07b';
                }
                return;
            }

            if (statusEl) {
                statusEl.textContent = '✅ Đã kết nối Ns! Chọn món đồ ở Menu để chỉnh sửa.';
                statusEl.style.color = '#4ec9b0';
            }

            const filter = (searchInput && searchInput.value || '').toLowerCase().trim();

            if (!force && filter === lastSearchQuery) return;
            lastSearchQuery = filter;

            const groups = {};
            const visited = new Set();

            function fastWalk(obj, path, depth) {
                if (typeof obj !== 'object' || obj === null || depth > 6) return;
                if (visited.has(obj)) return;
                visited.add(obj);

                const keys = Object.keys(obj);
                for (let i = 0; i < keys.length; i++) {
                    const k = keys[i];
                    if (/(chat|log|mapData|canvas|dom)/i.test(k)) continue;

                    const full = path ? (path + '.' + k) : k;
                    const val = obj[k];
                    const type = typeof val;

                    if (type !== 'object' || val === null) {
                        if (!filter || full.toLowerCase().includes(filter) || String(val).toLowerCase().includes(filter)) {
                            const parts = full.split('.');
                            let groupName = parts.length > 1 ? parts.slice(0, 2).join('.') : 'Thuộc tính chung';

                            if (parts[0] === 'eq' && parts.length > 1) {
                                const equipSlot = ns.eq ? ns.eq[parts[1]] : null;
                                if (equipSlot && equipSlot.n) {
                                    groupName = \`🛡️ [\${parts[1]}] \${equipSlot.n}\`;
                                }
                            }

                            if (!groups[groupName]) groups[groupName] = [];
                            groups[groupName].push({ p: full, v: val, parent: obj, key: k });
                        }
                    } else {
                        fastWalk(val, full, depth + 1);
                    }
                }
            }

            fastWalk(ns, '', 0);

            listContainer.innerHTML = '';
            const groupKeys = Object.keys(groups);

            if (groupKeys.length === 0) {
                listContainer.innerHTML = '<div style="color:#aaa;text-align:center;padding:15px;">Không tìm thấy thuộc tính phù hợp</div>';
                return;
            }

            const fragment = document.createDocumentFragment();

            groupKeys.forEach((gName) => {
                const groupWrapper = document.createElement('div');
                groupWrapper.style.cssText = 'margin-bottom:8px;border:1px solid #444;border-radius:6px;overflow:hidden;background:#252526;';

                const header = document.createElement('div');
                const isAutoExpand = filter.length > 0;
                header.style.cssText = 'padding:8px 10px;background:#2d2d2d;color:#ffe875;font-weight:bold;font-size:12px;cursor:pointer;display:flex;justify-content:space-between;align-items:center;user-select:none;border-bottom:1px solid #333;';
                header.innerHTML = \`<span>\${escapeHtml(gName)} <span style="color:#888;font-size:10px;">(\${groups[gName].length} dòng)</span></span>
                                    <span class="acc-icon" style="color:#4ec9b0;font-size:14px;">\${isAutoExpand ? '▼' : '►'}</span>\`;

                const body = document.createElement('div');
                body.style.cssText = \`padding:6px;display:\${isAutoExpand ? 'block' : 'none'};\`;

                header.onclick = () => {
                    const isHidden = body.style.display === 'none';
                    body.style.display = isHidden ? 'block' : 'none';
                    header.querySelector('.acc-icon').textContent = isHidden ? '▼' : '►';
                };

                groups[gName].forEach(item => {
                    body.appendChild(createRow(item.p, item.v, item.parent, item.key));
                });

                groupWrapper.appendChild(header);
                groupWrapper.appendChild(body);
                fragment.appendChild(groupWrapper);
            });

            listContainer.appendChild(fragment);
        }

        function createRow(p, v, parent, key) {
            const row = document.createElement('div');

            const isMagicAttr = /\.mag\./i.test(p);
            const isWhiteExtraAttr = /\.(extra|opt|base)\./i.test(p);

            let rowBg = '#1e1e1e';
            let rowBorder = 'none';
            let textColor = '#9cdcfe';

            if (isMagicAttr) {
                rowBg = '#3a3000';
                rowBorder = '1px solid #ffd700';
                textColor = '#ffe875';
            } else if (isWhiteExtraAttr) {
                rowBg = '#142534';
                rowBorder = '1px solid #00b4d8';
                textColor = '#ffffff';
            }

            row.style.cssText = \`display:flex;align-items:center;gap:6px;margin-bottom:5px;padding:5px;background:\${rowBg};border:\${rowBorder};border-radius:4px;\`;

            const nameContainer = document.createElement('div');
            nameContainer.style.cssText = 'flex:1 1 45%;min-width:0;display:flex;align-items:center;gap:4px;';

            const editPenBtn = document.createElement('button');
            editPenBtn.type = 'button';
            editPenBtn.textContent = '✏️';
            editPenBtn.title = 'Bấm để sửa tên dòng';
            editPenBtn.style.cssText = 'background:none;border:none;cursor:pointer;font-size:12px;padding:0 2px;flex:0 0 auto;line-height:1;';

            const nameSpan = document.createElement('span');
            nameSpan.textContent = p;
            nameSpan.style.cssText = \`color:\${textColor};word-break:break-all;font-size:11px;font-weight:bold;flex:1 1 auto;min-width:0;\`;

            nameContainer.appendChild(editPenBtn);
            nameContainer.appendChild(nameSpan);

            const valInput = document.createElement('input');
            valInput.type = 'text';
            valInput.value = (v !== undefined && v !== null) ? String(v) : '';
            valInput.setAttribute('list', 'vltk-attr-datalist');
            valInput.setAttribute('data-attr-field', 'true');
            valInput.style.cssText = 'flex:1 1 35%;width:0;min-width:60px;padding:4px 6px;background:#2d2d2d;color:#b5cea8;border:1px solid #555;border-radius:4px;font-size:12px;touch-action:manipulation;';

            const handleAutoExtractId = function () {
                const matchedId = parseIdFromInput(valInput.value);
                if (matchedId !== null) {
                    valInput.value = matchedId;
                }
            };

            valInput.oninput = handleAutoExtractId;
            valInput.onchange = handleAutoExtractId;

            const saveBtn = document.createElement('button');
            saveBtn.type = 'button';
            saveBtn.textContent = 'Lưu';
            saveBtn.style.cssText = 'flex:0 0 auto;padding:4px 8px;background:#0e639c;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:11px;font-weight:bold;touch-action:manipulation;';

            let isEditingName = false;
            let nameInput = null;

            editPenBtn.onclick = function (e) {
                if (e && e.cancelable) e.preventDefault();
                if (!isEditingName) {
                    isEditingName = true;
                    nameInput = document.createElement('input');
                    nameInput.type = 'text';
                    nameInput.value = nameSpan.textContent;
                    nameInput.style.cssText = 'width:100%;padding:4px;background:#1e1e1e;color:#9cdcfe;border:1px solid #007acc;border-radius:4px;font-size:11px;font-weight:bold;';

                    nameContainer.replaceChild(nameInput, nameSpan);
                    editPenBtn.textContent = '🔓';
                    nameInput.focus();
                } else {
                    isEditingName = false;
                    nameSpan.textContent = nameInput.value;
                    nameContainer.replaceChild(nameSpan, nameInput);
                    editPenBtn.textContent = '✏️';
                }
            };

            const saveHandler = function (e) {
                if (e && e.cancelable) e.preventDefault();
                let rawVal = valInput.value;
                let extractedId = parseIdFromInput(rawVal);
                if (extractedId !== null) rawVal = extractedId;

                let newV = (typeof v === 'number') ? Number(rawVal) : (typeof v === 'boolean' ? (rawVal === 'true') : rawVal);

                try {
                    let currentKey = key;
                    if (isEditingName && nameInput) {
                        const newPath = nameInput.value.trim();
                        const parts = newPath.split('.');
                        currentKey = parts[parts.length - 1];
                    }

                    parent[currentKey] = newV;

                    if (currentKey === 'a' && typeof newV === 'number') {
                        let newName = ATTR_MAP[newV];
                        if (!newName) {
                            const foundInNotes = sharedNotesData.find(n => Number(n.id) === newV);
                            if (foundInNotes) newName = foundInNotes.text || foundInNotes.name;
                        }
                        if (newName && parent && parent.hasOwnProperty('n')) {
                            parent['n'] = newName;
                        }
                    }

                    try {
                        Object.defineProperty(parent, currentKey, {
                            value: newV,
                            writable: true,
                            configurable: true,
                            enumerable: true
                        });
                    } catch (_err) {}

                    if (window.Ns && typeof window.Ns.update === 'function') window.Ns.update();
                    if (window.Ns && typeof window.Ns.render === 'function') window.Ns.render();

                    saveBtn.textContent = '✔';
                    saveBtn.style.background = '#107c41';
                    setTimeout(() => {
                        saveBtn.textContent = 'Lưu';
                        saveBtn.style.background = '#0e639c';
                    }, 1200);

                } catch (err) {
                    alert('Lỗi khi lưu giá trị!');
                }
            };

            saveBtn.onclick = saveHandler;

            row.appendChild(nameContainer);
            row.appendChild(valInput);
            row.appendChild(saveBtn);
            return row;
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', installUI);
    } else {
        installUI();
    }
})();`;
    }

    function installUI() {
        if (!document.body) return;

        const integratedMode = !!window.__VLM;
        if (!integratedMode && document.getElementById('vltk-ns-open-wrapper')) return;

        let toggleContainer = null;
        let toggle = null;
        if (!integratedMode) {
            toggleContainer = document.createElement('div');
            toggleContainer.id = 'vltk-ns-open-wrapper';
            toggleContainer.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:999999;display:flex;flex-direction:column;align-items:flex-end;user-select:none;touch-action:none;';

            toggle = document.createElement('button');
            toggle.id = 'vltk-ns-open';
            toggle.innerText = '⚙️ Ns Mod v' + CURRENT_VERSION;
            toggle.style.cssText = 'padding:12px 18px;background:#107c41;color:#fff;border:none;border-radius:20px;font-weight:bold;cursor:pointer;box-shadow:0 4px 10px rgba(0,0,0,0.5);-webkit-tap-highlight-color:transparent;position:relative;';

            toggleContainer.appendChild(toggle);
            document.body.appendChild(toggleContainer);
        }

        let panel = document.getElementById('vltk-ns-panel') || null;
        let nsWaitTimer = null;

        function openPanel() {
            if (!panel || !document.getElementById('vltk-ns-panel')) {
                panel = buildPanel();
                document.body.appendChild(panel);
            }
            panel.style.display = 'flex';
            tryCaptureNs();
            populateTargetItemDropdown();
            refreshUI(true);

            if (nsWaitTimer) clearInterval(nsWaitTimer);
            nsWaitTimer = setInterval(() => {
                if (!panel || panel.style.display === 'none') return;
                if (tryCaptureNs()) {
                    populateTargetItemDropdown();
                    refreshUI(true);
                    clearInterval(nsWaitTimer);
                    nsWaitTimer = null;
                }
            }, 1000);
        }

        function togglePanel() {
            if (!panel || panel.style.display === 'none') openPanel();
            else panel.style.display = 'none';
        }

        if (integratedMode) {
            window.__vltkOpenPanel = openPanel;
            window.__vltkTogglePanel = togglePanel;
        } else {
            makeDraggable(toggleContainer, toggle, togglePanel);
        }

        function populateTargetItemDropdown() {
            const drop = document.getElementById('vltk-target-item-select');
            if (!drop) return;
            tryCaptureNs();
            const ns = window.Ns;

            drop.innerHTML = '<option value="">-- Chọn món đồ sẵn có để biến đổi / thêm dòng --</option>';
            if (!ns) return;

            const invList = ns.inv || ns.bag;
            if (Array.isArray(invList)) {
                invList.forEach((item, idx) => {
                    if (item && typeof item === 'object') {
                        let name = item.n || ("Vật phẩm Rương #" + idx);
                        let opt = document.createElement('option');
                        opt.value = `inv.${idx}`;
                        opt.textContent = `📦 Rương [${idx}]: ${name} (t:${item.t ?? '?'}, k:${item.k ?? '?'})`;
                        drop.appendChild(opt);
                    }
                });
            }

            if (ns.eq && typeof ns.eq === 'object') {
                for (let slot in ns.eq) {
                    let item = ns.eq[slot];
                    if (item && typeof item === 'object') {
                        let name = item.n || slot;
                        let opt = document.createElement('option');
                        opt.value = `eq.${slot}`;
                        opt.textContent = `🛡️ Đang mặc [${slot}]: ${name} (t:${item.t ?? '?'}, k:${item.k ?? '?'})`;
                        drop.appendChild(opt);
                    }
                }
            }
        }

        function buildPanel() {
            const box = document.createElement('div');
            box.id = 'vltk-ns-panel';
            box.style.cssText = 'position:fixed;top:40px;right:10px;width:min(560px, calc(100vw - 20px));height:min(82vh, calc(100vh - 60px));min-height:320px;background:#1e1e1e;color:#fff;border:2px solid #007acc;border-radius:8px;z-index:999999;font-family:monospace;display:flex;flex-direction:column;box-shadow:0 5px 20px rgba(0,0,0,0.6);';

            box.innerHTML =
                `<div id="vltk-ns-header" style="padding:8px 10px;background:#007acc;font-weight:bold;display:flex;align-items:center;user-select:none;touch-action:none;">
                    <span style="font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">🖐️ Ns Editor v${CURRENT_VERSION} (${FAKE_IP})</span>
                    <button id="vltk-ns-close" style="margin-left:auto;background:none;border:none;color:#fff;cursor:pointer;font-size:18px;font-weight:bold;padding:0 4px;line-height:1;touch-action:manipulation;">✖</button>
                </div>

                <div style="display:flex;background:#2d2d2d;border-bottom:1px solid #444;">
                    <button id="tab-ns" style="flex:1;padding:8px 4px;background:#1e1e1e;color:#4ec9b0;border:none;border-bottom:2px solid #4ec9b0;font-weight:bold;font-size:12px;cursor:pointer;">⚙️ Sửa Ns</button>
                    <button id="tab-notes" style="flex:1;padding:8px 4px;background:#2d2d2d;color:#aaa;border:none;font-weight:bold;font-size:12px;cursor:pointer;">📝 Ghi Chú</button>
                </div>

                <div id="view-ns" style="display:flex;flex-direction:column;flex-grow:1;overflow:hidden;">
                    <div id="vltk-ns-status" style="padding:8px 10px;color:#dcdcaa;font-size:12px;border-bottom:1px solid #333;">Đang kiểm tra Ns...</div>

                    <div style="padding:8px 10px;background:#252526;border-bottom:1px solid #333;display:flex;flex-direction:column;gap:6px;">
                        <select id="vltk-target-item-select" style="width:100%;padding:6px 8px;background:#1e1e1e;color:#ffe875;border:1px solid #007acc;border-radius:4px;font-size:12px;font-weight:bold;cursor:pointer;">
                            <option value="">-- Chọn món đồ sẵn có để biến đổi / thêm dòng --</option>
                        </select>

                        <div style="display:flex;gap:6px;align-items:center;">
                            <input type="text" id="vltk-add-item-id" placeholder="k mới (25=Hươu, 0=Kiếm)..." style="flex:1;padding:6px 8px;background:#1e1e1e;color:#ffe875;border:1px solid #007acc;border-radius:4px;font-size:12px;font-weight:bold;">
                            <input type="text" id="vltk-add-item-p" placeholder="p mới (250)..." style="width:110px;padding:6px 8px;background:#1e1e1e;color:#9cdcfe;border:1px solid #007acc;border-radius:4px;font-size:12px;font-weight:bold;">
                        </div>

                        <div style="display:flex;gap:6px;">
                            <button id="vltk-swap-item-btn" style="flex:1;padding:6px 10px;background:#d7ba7d;color:#1e1e1e;border:none;border-radius:4px;font-weight:bold;font-size:11px;cursor:pointer;">🔄 Biến đổi k, p & cưỡi được</button>
                            <button id="vltk-add-base-btn" style="flex:1;padding:6px 10px;background:#00b4d8;color:#000;border:none;border-radius:4px;font-weight:bold;font-size:11px;cursor:pointer;">➕ Thêm dòng Trắng (base)</button>
                            <button id="vltk-add-mag-btn" style="flex:1;padding:6px 10px;background:#3a86ff;color:#fff;border:none;border-radius:4px;font-weight:bold;font-size:11px;cursor:pointer;">✨ Thêm dòng Thuộc tính (mag)</button>
                        </div>
                    </div>

                    <div style="padding:10px;border-bottom:1px solid #333;">
                        <input type="text" id="vltk-ns-search" placeholder="Gõ tên trang bị hoặc thuộc tính (VD: weapon, cuff, gold)..." style="width:100%;padding:8px;background:#2d2d2d;color:#fff;border:1px solid #444;border-radius:4px;box-sizing:border-box;font-size:13px;">
                    </div>
                    <div id="vltk-ns-list" style="padding:10px;overflow-y:auto;overflow-x:hidden;flex-grow:1;touch-action:pan-y;"></div>
                </div>

                <div id="view-notes" style="display:none;flex-direction:column;flex-grow:1;padding:10px;overflow:hidden;">
                    <div style="display:flex;gap:4px;margin-bottom:8px;flex-wrap:wrap;">
                        <input type="text" id="note-search" placeholder="🔍 Tìm ghi chú..." style="flex:1;min-width:120px;padding:6px;background:#2d2d2d;color:#fff;border:1px solid #444;border-radius:4px;font-size:12px;">
                        <button id="note-download-file" style="padding:6px 8px;background:#107c41;color:#fff;border:none;border-radius:4px;font-size:11px;font-weight:bold;cursor:pointer;">📥 Tải file .user.js</button>
                        <button id="note-copy-full-code" style="padding:6px 8px;background:#d7ba7d;color:#1e1e1e;border:none;border-radius:4px;font-size:11px;font-weight:bold;cursor:pointer;">📋 Copy toàn bộ Code</button>
                    </div>
                    <div style="display:flex;gap:6px;margin-bottom:8px;">
                        <input type="number" id="vltk-note-id" placeholder="ID (VD: 114)" style="width:100px;padding:8px;background:#2d2d2d;color:#ffe875;border:1px solid #444;border-radius:4px;font-size:13px;font-weight:bold;">
                        <input type="text" id="vltk-note-text" placeholder="Tên thuộc tính (VD: Kháng tất cả)" style="flex:1;padding:8px;background:#2d2d2d;color:#fff;border:1px solid #444;border-radius:4px;font-size:13px;">
                        <button id="note-add" style="padding:6px 12px;background:#00b4d8;color:#000;border:none;border-radius:4px;font-size:12px;font-weight:bold;cursor:pointer;">➕ Thêm</button>
                    </div>
                    <div id="note-list" style="flex-grow:1;overflow-y:auto;background:#252526;border:1px solid #333;border-radius:4px;padding:8px;">
                        <div style="color:#aaa;text-align:center;padding:10px;">Đang tải ghi chú...</div>
                    </div>
                </div>`;

            setTimeout(() => {
                makeDraggable(box, document.getElementById('vltk-ns-header'));

                const tabNs = document.getElementById('tab-ns');
                const tabNotes = document.getElementById('tab-notes');
                const viewNs = document.getElementById('view-ns');
                const viewNotes = document.getElementById('view-notes');

                tabNs.onclick = () => {
                    tabNs.style.background = '#1e1e1e';
                    tabNs.style.color = '#4ec9b0';
                    tabNs.style.borderBottom = '2px solid #4ec9b0';
                    tabNotes.style.background = '#2d2d2d';
                    tabNotes.style.color = '#aaa';
                    tabNotes.style.borderBottom = 'none';
                    viewNs.style.display = 'flex';
                    viewNotes.style.display = 'none';
                    populateTargetItemDropdown();
                };

                tabNotes.onclick = () => {
                    tabNotes.style.background = '#1e1e1e';
                    tabNotes.style.color = '#4ec9b0';
                    tabNotes.style.borderBottom = '2px solid #4ec9b0';
                    tabNs.style.background = '#2d2d2d';
                    tabNs.style.color = '#aaa';
                    tabNs.style.borderBottom = 'none';
                    viewNotes.style.display = 'flex';
                    viewNs.style.display = 'none';
                    loadSharedNotes();
                };

                document.getElementById('vltk-ns-close').onclick = () => { box.style.display = 'none'; };

                // 1. Biến đổi k, p & Cưỡi
                document.getElementById('vltk-swap-item-btn').onclick = function () {
                    const selectEl = document.getElementById('vltk-target-item-select');
                    const idInput = document.getElementById('vltk-add-item-id');
                    const pInput = document.getElementById('vltk-add-item-p');

                    const targetPath = (selectEl ? selectEl.value : '').trim();
                    const rawK = (idInput.value || '').trim();
                    const rawP = (pInput.value || '').trim();

                    if (!targetPath) {
                        alert("Vui lòng chọn 1 món đồ sẵn có từ Menu!");
                        return;
                    }
                    if (!rawK) {
                        alert("Vui lòng nhập giá trị k mới!");
                        return;
                    }

                    let itemObj = getSelectedItemObject(targetPath);
                    if (!itemObj) {
                        alert("Không tìm thấy dữ liệu món đồ được chọn!");
                        return;
                    }

                    const valK = isNaN(rawK) ? rawK : Number(rawK);
                    const valP = rawP ? (isNaN(rawP) ? rawP : Number(rawP)) : 250;

                    let isMount = (valK === 25 || valK === 10 || String(valK).toLowerCase().includes('horse'));

                    if (isMount) {
                        itemObj.t = "horse";
                        itemObj.k = valK;
                        itemObj.p = valP;
                        itemObj.d = 10;
                        itemObj.n = "Hươu đốm";
                        itemObj.tm = "huoudom";
                        itemObj.ic = `img/i/10_${valP}.png`;
                        itemObj.s = -1;
                        itemObj.r = 4;
                        itemObj.lock = true;

                        delete itemObj.base;
                        delete itemObj.atk;
                        delete itemObj.minAtk;
                        delete itemObj.maxAtk;

                        itemObj.mag = [
                            { a: 114, n: "Kháng tất cả", p: [50, -1, 6], pre: 1 },
                            { a: 115, n: "Tốc độ", p: [40, -1, 6], pre: 1 },
                            { a: 135, n: "May mắn", p: [30, -1, 6], pre: 1 }
                        ];
                    } else {
                        itemObj.t = "weapon";
                        itemObj.k = valK;
                        itemObj.p = valP;
                        itemObj.ic = `img/i/g${valP}.png`;
                    }

                    try {
                        if (window.Ns && typeof window.Ns.update === 'function') window.Ns.update();
                        if (window.Ns && typeof window.Ns.render === 'function') window.Ns.render();
                    } catch (e) {}

                    alert(`✅ Đã biến đổi hoàn chỉnh k=${valK}, p=${valP}!`);
                    populateTargetItemDropdown();
                    refreshUI(true);
                };

                // 2. Thêm dòng trắng (base)
                document.getElementById('vltk-add-base-btn').onclick = function () {
                    const selectEl = document.getElementById('vltk-target-item-select');
                    const targetPath = (selectEl ? selectEl.value : '').trim();

                    if (!targetPath) {
                        alert("Vui lòng chọn món đồ từ Menu trước khi thêm dòng!");
                        return;
                    }

                    let itemObj = getSelectedItemObject(targetPath);
                    if (!itemObj) {
                        alert("Không tìm thấy món đồ!");
                        return;
                    }

                    const codeMinStr = prompt("Nhập Mã thuộc tính gốc (Ví dụ: 30 = Né tránh, 28 = Sát thương):", "30");
                    if (codeMinStr === null) return;
                    const codeMin = Number(codeMinStr) || 30;

                    const codeMaxStr = prompt("Nhập Mã ghép cặp (Ví dụ: 31 = Né tránh, 29 = Sát thương):", String(codeMin === 30 ? 31 : 29));
                    if (codeMaxStr === null) return;
                    const codeMax = Number(codeMaxStr) || 31;

                    let val1 = 0, val2 = 0;
                    if (codeMin === 28 || codeMin === 0) {
                        const minAtk = prompt("SÁT THƯƠNG: Nhập Sát thương Tối Thiểu (Min):", "108");
                        if (minAtk === null) return;
                        const maxAtk = prompt("SÁT THƯƠNG: Nhập Sát thương Tối Đa (Max):", "180");
                        if (maxAtk === null) return;
                        val1 = Number(minAtk) || 0;
                        val2 = Number(maxAtk) || 0;

                        itemObj.minAtk = val1;
                        itemObj.maxAtk = val2;
                    } else {
                        const defVal = prompt("NÉ TRÁNH / PHÒNG THỦ: Nhập điểm số (Ví dụ: 250 điểm):", "250");
                        if (defVal === null) return;
                        val1 = Number(defVal) || 0;
                        val2 = val1;

                        delete itemObj.minAtk;
                        delete itemObj.maxAtk;
                    }

                    itemObj.base = [
                        [codeMin, val1, val2],
                        [codeMax, val1, val2]
                    ];

                    try {
                        if (window.Ns && typeof window.Ns.update === 'function') window.Ns.update();
                        if (window.Ns && typeof window.Ns.render === 'function') window.Ns.render();
                    } catch (e) {}

                    alert(`✅ Đã thêm dòng trắng base chuẩn!`);
                    refreshUI(true);
                };

                // 3. Thêm dòng thuộc tính (mag) tự động tra tên theo ID
                document.getElementById('vltk-add-mag-btn').onclick = function () {
                    const selectEl = document.getElementById('vltk-target-item-select');
                    const targetPath = (selectEl ? selectEl.value : '').trim();

                    if (!targetPath) {
                        alert("Vui lòng chọn món đồ cần thêm dòng thuộc tính!");
                        return;
                    }

                    let itemObj = getSelectedItemObject(targetPath);
                    if (!itemObj) {
                        alert("Không tìm thấy món đồ!");
                        return;
                    }

                    if (!Array.isArray(itemObj.mag)) {
                        itemObj.mag = [];
                    }

                    const attrCodeStr = prompt("Nhập ID thuộc tính (a) (VD: 126=Sát thương vật lý, 168=Kim Ma, 139=Tông sư, 115=Tốc độ...):", "126");
                    if (attrCodeStr === null) return;
                    const attrCode = Number(attrCodeStr);

                    let autoName = ATTR_MAP[attrCode];
                    if (!autoName) {
                        const foundInNotes = sharedNotesData.find(n => Number(n.id) === attrCode);
                        if (foundInNotes) autoName = foundInNotes.text || foundInNotes.name;
                    }
                    if (!autoName) autoName = "Thuộc tính mới";

                    const attrValStr = prompt("Nhập Giá trị thuộc tính (Phần tử 0 trong mảng p):", "34");
                    if (attrValStr === null) return;
                    const attrVal = Number(attrValStr) || 0;

                    const attrLvlStr = prompt("Nhập Cấp độ thuộc tính (Phần tử 2 trong mảng p):", "6");
                    if (attrLvlStr === null) return;
                    const attrLvl = Number(attrLvlStr) || 6;

                    const preStr = prompt("Kích hoạt dòng (pre): Nhập 1 = Kích hoạt (Sáng), 0 = Dòng ẩn (Tối):", "1");
                    if (preStr === null) return;
                    const preVal = Number(preStr) === 0 ? 0 : 1;

                    const newMagObj = {
                        a: attrCode,
                        n: autoName,
                        p: [attrVal, -1, attrLvl],
                        pre: preVal
                    };

                    itemObj.mag.push(newMagObj);

                    try {
                        if (window.Ns && typeof window.Ns.update === 'function') window.Ns.update();
                        if (window.Ns && typeof window.Ns.render === 'function') window.Ns.render();
                    } catch (e) {}

                    alert(`✅ Đã thêm dòng mag [${attrCode}] "${autoName}" với p: [${attrVal}, -1, ${attrLvl}], pre: ${preVal}!`);
                    refreshUI(true);
                };

                document.getElementById('vltk-ns-search').oninput = function () {
                    clearTimeout(searchDebounceTimer);
                    searchDebounceTimer = setTimeout(() => refreshUI(true), 200);
                };

                document.getElementById('note-add').onclick = addSharedNote;
                document.getElementById('note-search').oninput = renderNotesUI;

                document.getElementById('note-download-file').onclick = function () {
                    const fullCode = generateFullScriptSource();
                    const blob = new Blob([fullCode], { type: 'text/javascript;charset=utf-8' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = 'script.user.js';
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    URL.revokeObjectURL(url);
                    alert("📥 Đã tải file script.user.js chứa đầy đủ 100% Code + Ghi Chú mới nhất! Kéo thả file vào Tampermonkey máy mới là cài đặt xong!");
                };

                document.getElementById('note-copy-full-code').onclick = function () {
                    const fullCode = generateFullScriptSource();
                    if (navigator.clipboard && navigator.clipboard.writeText) {
                        navigator.clipboard.writeText(fullCode).then(() => {
                            alert("📋 Đã copy 100% TOÀN BỘ Mã nguồn Script kèm Ghi Chú mới nhất vào Clipboard! Sang máy mới chỉ cần nhấn Ctrl+V duy nhất 1 lần!");
                        }).catch(() => {
                            prompt("Hãy copy toàn bộ mã nguồn dưới đây dán vào Tampermonkey:", fullCode);
                        });
                    } else {
                        prompt("Hãy copy toàn bộ mã nguồn dưới đây dán vào Tampermonkey:", fullCode);
                    }
                };

                loadSharedNotes();

            }, 100);

            return box;
        }

        function loadSharedNotes() {
            const listEl = document.getElementById('note-list');
            if (listEl) listEl.innerHTML = '<div style="color:#aaa;text-align:center;padding:10px;">⏳ Đang tải ghi chú...</div>';

            try {
                const localData = localStorage.getItem('__vltk_shared_notes');
                sharedNotesData = localData ? JSON.parse(localData) : DEFAULT_NOTES;
            } catch (e) {
                sharedNotesData = DEFAULT_NOTES;
            }
            updateDatalist();
            renderNotesUI();
        }

        function addSharedNote() {
            const idInput = document.getElementById('vltk-note-id');
            const textInput = document.getElementById('vltk-note-text');
            const rawId = (idInput ? idInput.value : '').trim();
            const textVal = (textInput ? textInput.value : '').trim();

            if (!rawId || !textVal) {
                alert("Vui lòng nhập đầy đủ cả ID và Tên thuộc tính!");
                return;
            }

            const newNote = {
                id: isNaN(rawId) ? rawId : Number(rawId),
                text: textVal,
                time: new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })
            };

            sharedNotesData.unshift(newNote);
            saveNotesToStorage();

            if (idInput) idInput.value = '';
            if (textInput) textInput.value = '';

            renderNotesUI();
        }

        function renderNotesUI() {
            const listEl = document.getElementById('note-list');
            const searchEl = document.getElementById('note-search');
            if (!listEl) return;

            const query = (searchEl && searchEl.value || '').toLowerCase().trim();
            const filtered = sharedNotesData.filter(n => {
                const strText = (n.text || n.name || '');
                const strId = String(n.id);
                return !query || strText.toLowerCase().includes(query) || strId.includes(query);
            });

            if (filtered.length === 0) {
                listEl.innerHTML = '<div style="color:#888;text-align:center;padding:15px;">Không tìm thấy ghi chú phù hợp</div>';
                return;
            }

            const frag = document.createDocumentFragment();
            filtered.forEach((item) => {
                const div = document.createElement('div');
                div.style.cssText = 'background:#2d2d2d;padding:8px;border-radius:4px;margin-bottom:6px;border-left:3px solid #4ec9b0;font-size:12px;display:flex;justify-content:space-between;align-items:center;gap:8px;';

                const displayText = item.text || item.name || '';

                const contentDiv = document.createElement('div');
                contentDiv.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;';
                contentDiv.innerHTML = `<span style="color:#ffe875;font-weight:bold;">${escapeHtml(String(item.id))}: </span>
                                        <span style="color:#dcdcaa;">${escapeHtml(displayText)}</span>
                                        <span style="color:#666;font-size:10px;margin-left:6px;">🕒 ${item.time || ''}</span>`;

                const btnGroup = document.createElement('div');
                btnGroup.style.cssText = 'display:flex;gap:4px;flex-shrink:0;';

                const editBtn = document.createElement('button');
                editBtn.textContent = '✏️ Sửa';
                editBtn.style.cssText = 'padding:2px 6px;background:#0e639c;color:#fff;border:none;border-radius:3px;cursor:pointer;font-size:11px;';
                editBtn.onclick = function () {
                    const newIdStr = prompt("Sửa ID thuộc tính:", String(item.id));
                    if (newIdStr === null) return;
                    const newTextStr = prompt("Sửa Tên thuộc tính:", displayText);
                    if (newTextStr === null) return;

                    item.id = isNaN(newIdStr) ? newIdStr.trim() : Number(newIdStr);
                    item.text = newTextStr.trim();
                    item.time = new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });

                    saveNotesToStorage();
                    renderNotesUI();
                };

                const delBtn = document.createElement('button');
                delBtn.textContent = '🗑️ Xóa';
                delBtn.style.cssText = 'padding:2px 6px;background:#a91d22;color:#fff;border:none;border-radius:3px;cursor:pointer;font-size:11px;';
                delBtn.onclick = function () {
                    if (confirm(`Bạn có chắc muốn xóa ghi chú [${item.id}: ${displayText}] không?`)) {
                        const realIdx = sharedNotesData.indexOf(item);
                        if (realIdx !== -1) {
                            sharedNotesData.splice(realIdx, 1);
                            saveNotesToStorage();
                            renderNotesUI();
                        }
                    }
                };

                btnGroup.appendChild(editBtn);
                btnGroup.appendChild(delBtn);

                div.appendChild(contentDiv);
                div.appendChild(btnGroup);
                frag.appendChild(div);
            });

            listEl.innerHTML = '';
            listEl.appendChild(frag);
        }

        function escapeHtml(str) {
            return String(str).replace(/[&<>"']/g, function (m) {
                return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m];
            });
        }

        window.__vltkSyncInterval = setInterval(() => {
            const currentPanel = document.getElementById('vltk-ns-panel');
            if (currentPanel && currentPanel.style.display !== 'none') {
                const active = document.activeElement;
                if (active && currentPanel.contains(active) && /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(active.tagName)) {
                    return;
                }
            }
        }, 5000);

        function refreshUI(force = false) {
            const listContainer = document.getElementById('vltk-ns-list');
            const statusEl = document.getElementById('vltk-ns-status');
            const searchInput = document.getElementById('vltk-ns-search');
            if (!listContainer) return;

            tryCaptureNs();
            const ns = window.Ns;

            if (!ns) {
                if (statusEl) {
                    statusEl.textContent = '⏳ Đang chờ Ns... Bạn di chuyển nhân vật 1 bước nhé!';
                    statusEl.style.color = '#e5c07b';
                }
                return;
            }

            if (statusEl) {
                statusEl.textContent = '✅ Đã kết nối Ns! Chọn món đồ ở Menu để chỉnh sửa.';
                statusEl.style.color = '#4ec9b0';
            }

            const filter = (searchInput && searchInput.value || '').toLowerCase().trim();

            if (!force && filter === lastSearchQuery) return;
            lastSearchQuery = filter;

            const groups = {};
            const visited = new Set();

            function fastWalk(obj, path, depth) {
                if (typeof obj !== 'object' || obj === null || depth > 6) return;
                if (visited.has(obj)) return;
                visited.add(obj);

                const keys = Object.keys(obj);
                for (let i = 0; i < keys.length; i++) {
                    const k = keys[i];
                    if (/(chat|log|mapData|canvas|dom)/i.test(k)) continue;

                    const full = path ? (path + '.' + k) : k;
                    const val = obj[k];
                    const type = typeof val;

                    if (type !== 'object' || val === null) {
                        if (!filter || full.toLowerCase().includes(filter) || String(val).toLowerCase().includes(filter)) {
                            const parts = full.split('.');
                            let groupName = parts.length > 1 ? parts.slice(0, 2).join('.') : 'Thuộc tính chung';

                            if (parts[0] === 'eq' && parts.length > 1) {
                                const equipSlot = ns.eq ? ns.eq[parts[1]] : null;
                                if (equipSlot && equipSlot.n) {
                                    groupName = `🛡️ [${parts[1]}] ${equipSlot.n}`;
                                }
                            }

                            if (!groups[groupName]) groups[groupName] = [];
                            groups[groupName].push({ p: full, v: val, parent: obj, key: k });
                        }
                    } else {
                        fastWalk(val, full, depth + 1);
                    }
                }
            }

            fastWalk(ns, '', 0);

            listContainer.innerHTML = '';
            const groupKeys = Object.keys(groups);

            if (groupKeys.length === 0) {
                listContainer.innerHTML = '<div style="color:#aaa;text-align:center;padding:15px;">Không tìm thấy thuộc tính phù hợp</div>';
                return;
            }

            const fragment = document.createDocumentFragment();

            groupKeys.forEach((gName) => {
                const groupWrapper = document.createElement('div');
                groupWrapper.style.cssText = 'margin-bottom:8px;border:1px solid #444;border-radius:6px;overflow:hidden;background:#252526;';

                const header = document.createElement('div');
                const isAutoExpand = filter.length > 0;
                header.style.cssText = 'padding:8px 10px;background:#2d2d2d;color:#ffe875;font-weight:bold;font-size:12px;cursor:pointer;display:flex;justify-content:space-between;align-items:center;user-select:none;border-bottom:1px solid #333;';
                header.innerHTML = `<span>${escapeHtml(gName)} <span style="color:#888;font-size:10px;">(${groups[gName].length} dòng)</span></span>
                                    <span class="acc-icon" style="color:#4ec9b0;font-size:14px;">${isAutoExpand ? '▼' : '►'}</span>`;

                const body = document.createElement('div');
                body.style.cssText = `padding:6px;display:${isAutoExpand ? 'block' : 'none'};`;

                header.onclick = () => {
                    const isHidden = body.style.display === 'none';
                    body.style.display = isHidden ? 'block' : 'none';
                    header.querySelector('.acc-icon').textContent = isHidden ? '▼' : '►';
                };

                groups[gName].forEach(item => {
                    body.appendChild(createRow(item.p, item.v, item.parent, item.key));
                });

                groupWrapper.appendChild(header);
                groupWrapper.appendChild(body);
                fragment.appendChild(groupWrapper);
            });

            listContainer.appendChild(fragment);
        }

        function createRow(p, v, parent, key) {
            const row = document.createElement('div');

            const isMagicAttr = /\.mag\./i.test(p);
            const isWhiteExtraAttr = /\.(extra|opt|base)\./i.test(p);

            let rowBg = '#1e1e1e';
            let rowBorder = 'none';
            let textColor = '#9cdcfe';

            if (isMagicAttr) {
                rowBg = '#3a3000';
                rowBorder = '1px solid #ffd700';
                textColor = '#ffe875';
            } else if (isWhiteExtraAttr) {
                rowBg = '#142534';
                rowBorder = '1px solid #00b4d8';
                textColor = '#ffffff';
            }

            row.style.cssText = `display:flex;align-items:center;gap:6px;margin-bottom:5px;padding:5px;background:${rowBg};border:${rowBorder};border-radius:4px;`;

            const nameContainer = document.createElement('div');
            nameContainer.style.cssText = 'flex:1 1 45%;min-width:0;display:flex;align-items:center;gap:4px;';

            const editPenBtn = document.createElement('button');
            editPenBtn.type = 'button';
            editPenBtn.textContent = '✏️';
            editPenBtn.title = 'Bấm để sửa tên dòng';
            editPenBtn.style.cssText = 'background:none;border:none;cursor:pointer;font-size:12px;padding:0 2px;flex:0 0 auto;line-height:1;';

            const nameSpan = document.createElement('span');
            nameSpan.textContent = p;
            nameSpan.style.cssText = `color:${textColor};word-break:break-all;font-size:11px;font-weight:bold;flex:1 1 auto;min-width:0;`;

            nameContainer.appendChild(editPenBtn);
            nameContainer.appendChild(nameSpan);

            const valInput = document.createElement('input');
            valInput.type = 'text';
            valInput.value = (v !== undefined && v !== null) ? String(v) : '';
            valInput.setAttribute('list', 'vltk-attr-datalist');
            valInput.setAttribute('data-attr-field', 'true');
            valInput.style.cssText = 'flex:1 1 35%;width:0;min-width:60px;padding:4px 6px;background:#2d2d2d;color:#b5cea8;border:1px solid #555;border-radius:4px;font-size:12px;touch-action:manipulation;';

            const handleAutoExtractId = function () {
                const matchedId = parseIdFromInput(valInput.value);
                if (matchedId !== null) {
                    valInput.value = matchedId;
                }
            };

            valInput.oninput = handleAutoExtractId;
            valInput.onchange = handleAutoExtractId;

            const saveBtn = document.createElement('button');
            saveBtn.type = 'button';
            saveBtn.textContent = 'Lưu';
            saveBtn.style.cssText = 'flex:0 0 auto;padding:4px 8px;background:#0e639c;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:11px;font-weight:bold;touch-action:manipulation;';

            let isEditingName = false;
            let nameInput = null;

            editPenBtn.onclick = function (e) {
                if (e && e.cancelable) e.preventDefault();
                if (!isEditingName) {
                    isEditingName = true;
                    nameInput = document.createElement('input');
                    nameInput.type = 'text';
                    nameInput.value = nameSpan.textContent;
                    nameInput.style.cssText = 'width:100%;padding:4px;background:#1e1e1e;color:#9cdcfe;border:1px solid #007acc;border-radius:4px;font-size:11px;font-weight:bold;';

                    nameContainer.replaceChild(nameInput, nameSpan);
                    editPenBtn.textContent = '🔓';
                    nameInput.focus();
                } else {
                    isEditingName = false;
                    nameSpan.textContent = nameInput.value;
                    nameContainer.replaceChild(nameSpan, nameInput);
                    editPenBtn.textContent = '✏️';
                }
            };

            const saveHandler = function (e) {
                if (e && e.cancelable) e.preventDefault();
                let rawVal = valInput.value;
                let extractedId = parseIdFromInput(rawVal);
                if (extractedId !== null) rawVal = extractedId;

                let newV = (typeof v === 'number') ? Number(rawVal) : (typeof v === 'boolean' ? (rawVal === 'true') : rawVal);

                try {
                    let currentKey = key;
                    if (isEditingName && nameInput) {
                        const newPath = nameInput.value.trim();
                        const parts = newPath.split('.');
                        currentKey = parts[parts.length - 1];
                    }

                    parent[currentKey] = newV;

                    if (currentKey === 'a' && typeof newV === 'number') {
                        let newName = ATTR_MAP[newV];
                        if (!newName) {
                            const foundInNotes = sharedNotesData.find(n => Number(n.id) === newV);
                            if (foundInNotes) newName = foundInNotes.text || foundInNotes.name;
                        }
                        if (newName && parent && parent.hasOwnProperty('n')) {
                            parent['n'] = newName;
                        }
                    }

                    try {
                        Object.defineProperty(parent, currentKey, {
                            value: newV,
                            writable: true,
                            configurable: true,
                            enumerable: true
                        });
                    } catch (_err) {}

                    if (window.Ns && typeof window.Ns.update === 'function') window.Ns.update();
                    if (window.Ns && typeof window.Ns.render === 'function') window.Ns.render();

                    saveBtn.textContent = '✔';
                    saveBtn.style.background = '#107c41';
                    setTimeout(() => {
                        saveBtn.textContent = 'Lưu';
                        saveBtn.style.background = '#0e639c';
                    }, 1200);

                } catch (err) {
                    alert('Lỗi khi lưu giá trị!');
                }
            };

            saveBtn.onclick = saveHandler;

            row.appendChild(nameContainer);
            row.appendChild(valInput);
            row.appendChild(saveBtn);
            return row;
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', installUI);
    } else {
        installUI();
    }
})();
