// ==UserScript==
// @name         VLTK Idle - Draggable Ns Editor (All Equipment Unlocked)
// @namespace    https://tampermonkey.net/
// @version      10.6
// @description  Tự động hook Ns; quét triệt để 100% trang bị đang mặc và trong túi
// @match        https://hoaniemi2003.net/vltk/*
// @match        https://hoainiem2003.net/vltk/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    if (window.__vltkNsModLoaded) {
        if (typeof window.__vltkDestroyUI === 'function') window.__vltkDestroyUI();
    }
    window.__vltkNsModLoaded = true;

    const SCRIPT_UPDATE_URL = "https://cdn.jsdelivr.net/gh/kaylypro1323/hackidle@main/script.user.js";

    // =============================================================
    // 1. TỰ ĐỘNG FAKE IP CLIENT
    // =============================================================
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

    // =============================================================
    // 2. HOOK G.JS & TỰ ĐỘNG BẮT LẠI NS
    // =============================================================
    function tryCaptureNsDirectly() {
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

        const observer = new MutationObserver(function (mutations) {
            mutations.forEach(function (mutation) {
                mutation.addedNodes.forEach(function (node) {
                    if (node.tagName === 'SCRIPT' && node.src && node.src.indexOf('g.js') !== -1) {
                        const scriptUrl = node.src;
                        node.type = 'javascript/blocked';
                        if (node.parentElement) node.parentElement.removeChild(node);

                        fetch(scriptUrl)
                            .then(res => res.text())
                            .then(code => {
                                const marker = /\blet\s+e\s*=\s*0\s*;/;
                                let patchedCode = code;

                                if (marker.test(code)) {
                                    patchedCode = code.replace(marker, match => {
                                        return match +
                                            '\ntry {' +
                                            ' window.__vltkGetNs = function(){ try { return (typeof Ns !== "undefined") ? Ns : undefined; } catch(_e) { return undefined; } };' +
                                            ' var __vltkNsNow = window.__vltkGetNs();' +
                                            ' if (__vltkNsNow !== undefined && __vltkNsNow !== null) window.Ns = __vltkNsNow;' +
                                            '} catch (__vltkHookErr) {}' +
                                            '\n';
                                    });
                                }

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

        setInterval(function () {
            tryCaptureNsDirectly();
        }, 1500);
    }

    // =============================================================
    // 3. KÉO THẢ TÁCH BIỆT TAP / DRAG FOR MOBILE
    // =============================================================
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

    // =============================================================
    // 4. UI VÀ THUẬT TOÁN QUÉT SÂU KHÔNG BỎ SÓT TRANG BỊ
    // =============================================================
    let searchDebounceTimer = null;
    let lastSearchQuery = null;

    window.__vltkDestroyUI = function () {
        const oldToggle = document.getElementById('vltk-ns-open');
        const oldPanel = document.getElementById('vltk-ns-panel');
        if (oldToggle) oldToggle.remove();
        if (oldPanel) oldPanel.remove();
        if (window.__vltkSyncInterval) clearInterval(window.__vltkSyncInterval);
    };

    function installUI() {
        if (!document.body || document.getElementById('vltk-ns-open')) return;

        const toggle = document.createElement('button');
        toggle.id = 'vltk-ns-open';
        toggle.innerText = '⚙️ Ns Mod';
        toggle.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:999999;padding:12px 18px;background:#107c41;color:#fff;border:none;border-radius:20px;font-weight:bold;cursor:pointer;box-shadow:0 4px 10px rgba(0,0,0,0.5);user-select:none;touch-action:none;-webkit-tap-highlight-color:transparent;';
        document.body.appendChild(toggle);

        let panel = null;

        function togglePanel() {
            if (!panel) {
                panel = buildPanel();
                document.body.appendChild(panel);
            } else {
                panel.style.display = (panel.style.display === 'none') ? 'flex' : 'none';
            }
            if (panel.style.display === 'flex') refreshUI(true);
        }

        makeDraggable(toggle, toggle, togglePanel);

        function buildPanel() {
            const box = document.createElement('div');
            box.id = 'vltk-ns-panel';
            box.style.cssText = 'position:fixed;top:40px;right:10px;width:min(520px, calc(100vw - 20px));height:min(70vh, calc(100vh - 60px));min-height:260px;background:#1e1e1e;color:#fff;border:2px solid #007acc;border-radius:8px;z-index:999999;font-family:monospace;display:flex;flex-direction:column;box-shadow:0 5px 20px rgba(0,0,0,0.6);';

            box.innerHTML = 
                `<div id="vltk-ns-header" style="padding:8px 10px;background:#007acc;font-weight:bold;display:flex;align-items:center;user-select:none;touch-action:none;">
                    <span style="font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">🖐️ Ns Editor (${FAKE_IP})</span>
                    <button id="vltk-ns-update" title="Cập nhật không F5" style="margin-left:10px;background:#28a745;color:#fff;border:none;padding:4px 8px;border-radius:4px;cursor:pointer;font-size:12px;font-weight:bold;white-space:nowrap;touch-action:manipulation;">🔄 Cập nhật</button>
                    <button id="vltk-ns-close" style="margin-left:auto;background:none;border:none;color:#fff;cursor:pointer;font-size:18px;font-weight:bold;padding:0 4px;line-height:1;touch-action:manipulation;">✖</button>
                </div>
                <div id="vltk-ns-status" style="padding:8px 10px;color:#dcdcaa;font-size:12px;border-bottom:1px solid #333;">Đang kiểm tra biến Ns...</div>
                <div style="padding:10px;border-bottom:1px solid #333;">
                    <input type="text" id="vltk-ns-search" placeholder="Nhập từ khóa (VD: eq, wear, bag, str)..." style="width:100%;padding:8px;background:#2d2d2d;color:#fff;border:1px solid #444;border-radius:4px;box-sizing:border-box;font-size:14px;">
                </div>
                <div id="vltk-ns-list" style="padding:10px;overflow-y:auto;overflow-x:hidden;flex-grow:1;touch-action:pan-y;"></div>`;

            setTimeout(() => {
                makeDraggable(box, document.getElementById('vltk-ns-header'));

                const closeBtn = document.getElementById('vltk-ns-close');
                closeBtn.onclick = () => { box.style.display = 'none'; };
                closeBtn.ontouchend = (e) => { e.preventDefault(); box.style.display = 'none'; };

                const updateBtn = document.getElementById('vltk-ns-update');
                const handleUpdate = function (e) {
                    if (e && e.cancelable) e.preventDefault();
                    
                    updateBtn.innerText = "⏳ Đang tải...";
                    updateBtn.disabled = true;

                    fetch(SCRIPT_UPDATE_URL + '?t=' + Date.now())
                        .then(res => {
                            if (!res.ok) throw new Error("HTTP " + res.status);
                            return res.text();
                        })
                        .then(newCode => {
                            updateBtn.innerText = "✅ Đã xong";
                            updateBtn.style.background = "#107c41";
                            setTimeout(() => {
                                try {
                                    eval(newCode);
                                } catch (err) {
                                    alert("Lỗi thực thi code mới: " + err.message);
                                }
                            }, 300);
                        })
                        .catch(err => {
                            updateBtn.innerText = "❌ Lỗi";
                            updateBtn.style.background = "#d9534f";
                            alert("Không thể tải bản cập nhật: " + err.message);
                            setTimeout(() => {
                                updateBtn.innerText = "🔄 Cập nhật";
                                updateBtn.style.background = "#28a745";
                                updateBtn.disabled = false;
                            }, 2000);
                        });
                };

                updateBtn.onclick = handleUpdate;

                document.getElementById('vltk-ns-search').oninput = function () {
                    clearTimeout(searchDebounceTimer);
                    searchDebounceTimer = setTimeout(() => refreshUI(true), 300);
                };
            }, 100);

            return box;
        }

        window.__vltkSyncInterval = setInterval(() => {
            const currentPanel = document.getElementById('vltk-ns-panel');
            if (currentPanel && currentPanel.style.display !== 'none') {
                const active = document.activeElement;
                if (!(active && currentPanel.contains(active) && /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(active.tagName))) {
                    refreshUI(false);
                }
            }
        }, 4000);

        function refreshUI(force = false) {
            const listContainer = document.getElementById('vltk-ns-list');
            const statusEl = document.getElementById('vltk-ns-status');
            const searchInput = document.getElementById('vltk-ns-search');
            if (!listContainer) return;

            tryCaptureNsDirectly();
            const ns = window.Ns;

            if (!ns) {
                if (statusEl) {
                    statusEl.textContent = '⏳ Đang chờ Ns... Hãy di chuyển hoặc chạm vào game!';
                    statusEl.style.color = '#e5c07b';
                }
                return;
            }

            if (statusEl) {
                statusEl.textContent = '✅ Đã kết nối Ns! (Mở bảng Trang Bị trong game để nạp đủ chỉ số)';
                statusEl.style.color = '#4ec9b0';
            }

            const filter = (searchInput && searchInput.value || '').toLowerCase().trim();

            if (!force && filter === lastSearchQuery) return;
            lastSearchQuery = filter;

            const fragment = document.createDocumentFragment();
            let count = 0;

            // Thuật toán walk mở rộng quét cực sâu cho tất cả nhánh đồ
            function walk(obj, path, depth) {
                if (typeof obj !== 'object' || obj === null || count > 250) return;

                const isEquip = /(eq|equip|wear|bag|item|inv|slot|fashion|arm)/i.test(path);
                const maxDepth = isEquip ? 8 : 3;

                if (depth > maxDepth) return;

                const keys = Object.keys(obj);
                for (let i = 0; i < keys.length; i++) {
                    const k = keys[i];
                    const full = path ? (path + '.' + k) : k;
                    const val = obj[k];
                    const type = typeof val;

                    if (type !== 'object' || val === null) {
                        if (!filter || full.toLowerCase().includes(filter) || String(val).toLowerCase().includes(filter)) {
                            fragment.appendChild(createRow(full, val, obj, k));
                            count++;
                        }
                    } else {
                        walk(val, full, depth + 1);
                    }
                }
            }

            walk(ns, '', 0);

            listContainer.innerHTML = '';
            if (count === 0) {
                listContainer.innerHTML = '<div style="color:#aaa;text-align:center;padding:15px;">Không tìm thấy thuộc tính phù hợp</div>';
            } else {
                listContainer.appendChild(fragment);
            }
        }

        function createRow(p, v, parent, key) {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:6px;padding:6px;background:#2d2d2d;border-radius:4px;';

            const nameSpan = document.createElement('span');
            nameSpan.textContent = p;
            nameSpan.style.cssText = 'color:#9cdcfe;flex:1 1 42%;min-width:0;word-break:break-all;font-size:12px;font-weight:bold;';

            const valInput = document.createElement('input');
            valInput.type = (typeof v === 'number') ? 'number' : 'text';
            valInput.value = (v !== undefined && v !== null) ? String(v) : '';
            valInput.style.cssText = 'flex:1 1 34%;width:0;min-width:60px;padding:6px;background:#1e1e1e;color:#b5cea8;border:1px solid #666;border-radius:4px;font-size:14px;touch-action:manipulation;';

            const saveBtn = document.createElement('button');
            saveBtn.type = 'button';
            saveBtn.textContent = 'Lưu';
            saveBtn.style.cssText = 'flex:0 0 auto;padding:6px 10px;background:#0e639c;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:13px;font-weight:bold;touch-action:manipulation;';

            const saveHandler = function (e) {
                if (e && e.cancelable) e.preventDefault();
                let raw = valInput.value;
                let newV = (typeof v === 'number') ? Number(raw) : (typeof v === 'boolean' ? (raw === 'true') : raw);

                try {
                    parent[key] = newV;

                    try {
                        Object.defineProperty(parent, key, {
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
                    }, 1000);
                } catch (err) {
                    alert('Lỗi khi lưu giá trị!');
                }
            };

            saveBtn.onclick = saveHandler;

            row.appendChild(nameSpan);
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
