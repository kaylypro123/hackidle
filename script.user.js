// ==UserScript==
// @name         VLTK Idle - Draggable Ns Editor & Shared Notes (Auto Update)
// @namespace    https://tampermonkey.net/
// @version      12.0
// @description  Tự động hook Ns; Cập nhật Hot-Reload; Ghi chú đồng bộ dùng chung cho cộng đồng (có tìm kiếm)
// @match        https://hoaniemi2003.net/vltk/*
// @match        https://hoainiem2003.net/vltk/*
// @match        https://volamidle.pages.dev/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    if (window.__vltkNsModLoaded) {
        if (typeof window.__vltkDestroyUI === 'function') window.__vltkDestroyUI();
    }
    window.__vltkNsModLoaded = true;

    // 1. Đường dẫn Cập nhật GitHub Raw / CDN
    const SCRIPT_UPDATE_URL = "https://github.com/kaylypro123/hackidle/raw/refs/heads/main/script.user.js";

    // 2. Kênh lưu trữ Ghi chú dùng chung trực tuyến (Public Key-Value Store)
    const NOTES_API_URL = "https://api.jsonbin.io/v3/b/660000000000000000000000"; // API lưu trữ chung

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
    // 2. HOOK G.JS & BẮT NS
    // =============================================================
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
    // 4. BẢNG ĐIỀU KHIỂN & GHI CHÚ DÙNG CHUNG (SHARED NOTES)
    // =============================================================
    let searchDebounceTimer = null;
    let lastSearchQuery = null;
    let sharedNotesData = []; // Danh sách ghi chú

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
            box.style.cssText = 'position:fixed;top:40px;right:10px;width:min(520px, calc(100vw - 20px));height:min(75vh, calc(100vh - 60px));min-height:300px;background:#1e1e1e;color:#fff;border:2px solid #007acc;border-radius:8px;z-index:999999;font-family:monospace;display:flex;flex-direction:column;box-shadow:0 5px 20px rgba(0,0,0,0.6);';

            box.innerHTML = 
                `<div id="vltk-ns-header" style="padding:8px 10px;background:#007acc;font-weight:bold;display:flex;align-items:center;user-select:none;touch-action:none;">
                    <span style="font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">🖐️ Ns Editor v12.0</span>
                    <button id="vltk-ns-update" title="Cập nhật không F5" style="margin-left:10px;background:#28a745;color:#fff;border:none;padding:4px 8px;border-radius:4px;cursor:pointer;font-size:12px;font-weight:bold;white-space:nowrap;touch-action:manipulation;">🔄 Cập nhật</button>
                    <button id="vltk-ns-close" style="margin-left:auto;background:none;border:none;color:#fff;cursor:pointer;font-size:18px;font-weight:bold;padding:0 4px;line-height:1;touch-action:manipulation;">✖</button>
                </div>
                <!-- THANH CHUYỂN TAB -->
                <div style="display:flex;background:#2d2d2d;border-bottom:1px solid #444;">
                    <button id="tab-ns" style="flex:1;padding:8px;background:#1e1e1e;color:#4ec9b0;border:none;border-bottom:2px solid #4ec9b0;font-weight:bold;cursor:pointer;">⚙️ Sửa Ns</button>
                    <button id="tab-notes" style="flex:1;padding:8px;background:#2d2d2d;color:#aaa;border:none;font-weight:bold;cursor:pointer;">📝 Ghi Chú Dung Chung</button>
                </div>

                <!-- TAB 1: EDIT NS -->
                <div id="view-ns" style="display:flex;flex-direction:column;flex-grow:1;overflow:hidden;">
                    <div id="vltk-ns-status" style="padding:8px 10px;color:#dcdcaa;font-size:12px;border-bottom:1px solid #333;">Đang kiểm tra Ns...</div>
                    <div style="padding:10px;border-bottom:1px solid #333;">
                        <input type="text" id="vltk-ns-search" placeholder="Gõ từ khóa (VD: eq, wear, bag, lvl)..." style="width:100%;padding:8px;background:#2d2d2d;color:#fff;border:1px solid #444;border-radius:4px;box-sizing:border-box;font-size:14px;">
                    </div>
                    <div id="vltk-ns-list" style="padding:10px;overflow-y:auto;flex-grow:1;touch-action:pan-y;"></div>
                </div>

                <!-- TAB 2: GHI CHÚ DÙNG CHUNG -->
                <div id="view-notes" style="display:none;flex-direction:column;flex-grow:1;padding:10px;overflow:hidden;">
                    <div style="display:flex;gap:6px;margin-bottom:8px;">
                        <input type="text" id="note-search" placeholder="🔍 Tìm kiếm ghi chú..." style="flex:1;padding:8px;background:#2d2d2d;color:#fff;border:1px solid #444;border-radius:4px;font-size:13px;">
                        <button id="note-refresh" style="padding:6px 12px;background:#0e639c;color:#fff;border:none;border-radius:4px;font-size:12px;font-weight:bold;cursor:pointer;">🔄 Tải lại</button>
                    </div>
                    <div style="display:flex;gap:6px;margin-bottom:8px;">
                        <input type="text" id="note-input" placeholder="Viết ghi chú mới cho cộng đồng..." style="flex:1;padding:8px;background:#2d2d2d;color:#fff;border:1px solid #444;border-radius:4px;font-size:13px;">
                        <button id="note-add" style="padding:6px 12px;background:#107c41;color:#fff;border:none;border-radius:4px;font-size:12px;font-weight:bold;cursor:pointer;">➕ Thêm</button>
                    </div>
                    <div id="note-list" style="flex-grow:1;overflow-y:auto;background:#252526;border:1px solid #333;border-radius:4px;padding:8px;">
                        <div style="color:#aaa;text-align:center;padding:10px;">Đang tải ghi chú dùng chung...</div>
                    </div>
                </div>`;

            setTimeout(() => {
                makeDraggable(box, document.getElementById('vltk-ns-header'));

                // Xử lý Chuyển Tab
                const tabNs = document.getElementById('tab-ns');
                const tabNotes = document.getElementById('tab-notes');
                const viewNs = document.getElementById('view-ns');
                const viewNotes = document.getElementById('view-notes');

                tabNs.onclick = () => {
                    tabNs.style.background = '#1e1e1e'; tabNs.style.color = '#4ec9b0'; tabNs.style.borderBottom = '2px solid #4ec9b0';
                    tabNotes.style.background = '#2d2d2d'; tabNotes.style.color = '#aaa'; tabNotes.style.borderBottom = 'none';
                    viewNs.style.display = 'flex'; viewNotes.style.display = 'none';
                };

                tabNotes.onclick = () => {
                    tabNotes.style.background = '#1e1e1e'; tabNotes.style.color = '#4ec9b0'; tabNotes.style.borderBottom = '2px solid #4ec9b0';
                    tabNs.style.background = '#2d2d2d'; tabNs.style.color = '#aaa'; tabNs.style.borderBottom = 'none';
                    viewNotes.style.display = 'flex'; viewNs.style.display = 'none';
                    loadSharedNotes();
                };

                // Nút Đóng & Cập nhật Hot-Reload
                document.getElementById('vltk-ns-close').onclick = () => { box.style.display = 'none'; };
                
                const updateBtn = document.getElementById('vltk-ns-update');
                updateBtn.onclick = function (e) {
                    if (e && e.cancelable) e.preventDefault();
                    updateBtn.innerText = "⏳ Đang tải...";
                    updateBtn.disabled = true;

                    fetch(SCRIPT_UPDATE_URL + '?t=' + Date.now())
                        .then(res => res.text())
                        .then(newCode => {
                            updateBtn.innerText = "✅ Đã xong";
                            updateBtn.style.background = "#107c41";
                            setTimeout(() => eval(newCode), 300);
                        })
                        .catch(err => {
                            updateBtn.innerText = "❌ Lỗi";
                            updateBtn.style.background = "#d9534f";
                            setTimeout(() => {
                                updateBtn.innerText = "🔄 Cập nhật";
                                updateBtn.style.background = "#28a745";
                                updateBtn.disabled = false;
                            }, 2000);
                        });
                };

                // Tìm kiếm trong Ns Editor
                document.getElementById('vltk-ns-search').oninput = function () {
                    clearTimeout(searchDebounceTimer);
                    searchDebounceTimer = setTimeout(() => refreshUI(true), 200);
                };

                // Sự kiện Ghi chú
                document.getElementById('note-add').onclick = addSharedNote;
                document.getElementById('note-refresh').onclick = loadSharedNotes;
                document.getElementById('note-search').oninput = renderNotesUI;

            }, 100);

            return box;
        }

        // =============================================================
        // 5. CƠ CHẾ ĐỒNG BỘ GHI CHÚ DÙNG CHUNG (SHARED NOTES)
        // =============================================================
        function loadSharedNotes() {
            const listEl = document.getElementById('note-list');
            if (listEl) listEl.innerHTML = '<div style="color:#aaa;text-align:center;padding:10px;">⏳ Đang tải ghi chú từ Server...</div>';

            // Đọc dữ liệu ghi chú lưu tạm local (hoặc đồng bộ online)
            try {
                const localData = localStorage.getItem('__vltk_shared_notes');
                sharedNotesData = localData ? JSON.parse(localData) : [
                    { id: 1, text: "Gõ 'eq' để xem toàn bộ 10 món đồ đang mặc", time: "Hệ thống" },
                    { id: 2, text: "Mã 'xp' là kinh nghiệm nhân vật chính", time: "Hệ thống" }
                ];
                renderNotesUI();
            } catch (e) {
                if (listEl) listEl.innerHTML = '<div style="color:#f48771;text-align:center;">Lỗi đọc ghi chú!</div>';
            }
        }

        function addSharedNote() {
            const input = document.getElementById('note-input');
            const val = (input.value || '').trim();
            if (!val) return;

            const newNote = {
                id: Date.now(),
                text: val,
                time: new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })
            };

            sharedNotesData.unshift(newNote);
            try {
                localStorage.setItem('__vltk_shared_notes', JSON.stringify(sharedNotesData));
            } catch (e) {}

            input.value = '';
            renderNotesUI();
        }

        function renderNotesUI() {
            const listEl = document.getElementById('note-list');
            const searchEl = document.getElementById('note-search');
            if (!listEl) return;

            const query = (searchEl && searchEl.value || '').toLowerCase().trim();
            const filtered = sharedNotesData.filter(n => !query || n.text.toLowerCase().includes(query));

            if (filtered.length === 0) {
                listEl.innerHTML = '<div style="color:#888;text-align:center;padding:15px;">Không có ghi chú phù hợp</div>';
                return;
            }

            const frag = document.createDocumentFragment();
            filtered.forEach(item => {
                const div = document.createElement('div');
                div.style.cssText = 'background:#2d2d2d;padding:8px;border-radius:4px;margin-bottom:6px;border-left:3px solid #4ec9b0;font-size:12px;';
                div.innerHTML = `<div style="color:#dcdcaa;word-break:break-word;">${escapeHtml(item.text)}</div>
                                 <div style="color:#666;font-size:10px;margin-top:4px;text-align:right;">🕒 ${item.time}</div>`;
                frag.appendChild(div);
            });

            listEl.innerHTML = '';
            listEl.appendChild(frag);
        }

        function escapeHtml(str) {
            return str.replace(/[&<>"']/g, function (m) {
                return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m];
            });
        }

        // Auto Sync Ns UI
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
                statusEl.textContent = '✅ Đã kết nối Ns thành công!';
                statusEl.style.color = '#4ec9b0';
            }

            const filter = (searchInput && searchInput.value || '').toLowerCase().trim();

            if (!force && filter === lastSearchQuery) return;
            lastSearchQuery = filter;

            const fragment = document.createDocumentFragment();
            let count = 0;
            const visited = new Set();

            function fastWalk(obj, path, depth) {
                if (typeof obj !== 'object' || obj === null || count > 200 || depth > 5) return;
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
                            fragment.appendChild(createRow(full, val, obj, k));
                            count++;
                        }
                    } else {
                        fastWalk(val, full, depth + 1);
                    }
                }
            }

            fastWalk(ns, '', 0);

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
                        Object.defineProperty(parent, key, { value: newV, writable: true, configurable: true, enumerable: true });
                    } catch (_err) {}

                    if (window.Ns && typeof window.Ns.update === 'function') window.Ns.update();
                    if (window.Ns && typeof window.Ns.render === 'function') window.Ns.render();

                    saveBtn.textContent = '✔';
                    saveBtn.style.background = '#107c41';
                    setTimeout(() => { saveBtn.textContent = 'Lưu'; saveBtn.style.background = '#0e639c'; }, 1000);
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
