// ==UserScript==
// @name         VLTK Idle - Draggable Ns Editor v13.1 (Enhanced Server Item Scanner)
// @namespace    https://tampermonkey.net/
// @version      13.1
// @description  v13.1: Quét sâu toàn bộ biến window/g.js để truy tìm bảng ID vật phẩm Server & Gom nhóm Accordion
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

    const UPDATE_ENDPOINTS = [
        "https://raw.githubusercontent.com/kaylypro123/hackidle/main/script.user.js",
        "https://cdn.jsdelivr.net/gh/kaylypro123/hackidle@main/script.user.js",
        "https://github.com/kaylypro123/hackidle/raw/refs/heads/main/script.user.js"
    ];

    const ATTR_MAP = {
        114: "kháng tất cả",
        115: "Tốc độ đánh - ngoại công",
        126: "sát thương vật lý - ngoại công",
        135: "may mắn",
        136: "hút sinh lực",
        139: "kỹ năng vốn có"
    };

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
            box.style.cssText = 'position:fixed;top:40px;right:10px;width:min(540px, calc(100vw - 20px));height:min(78vh, calc(100vh - 60px));min-height:320px;background:#1e1e1e;color:#fff;border:2px solid #007acc;border-radius:8px;z-index:999999;font-family:monospace;display:flex;flex-direction:column;box-shadow:0 5px 20px rgba(0,0,0,0.6);';

            box.innerHTML = 
                `<div id="vltk-ns-header" style="padding:8px 10px;background:#007acc;font-weight:bold;display:flex;align-items:center;user-select:none;touch-action:none;">
                    <span style="font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">🖐️ Ns Editor v13.1 (${FAKE_IP})</span>
                    <button id="vltk-ns-update" title="Cập nhật không F5" style="margin-left:10px;background:#28a745;color:#fff;border:none;padding:4px 8px;border-radius:4px;cursor:pointer;font-size:12px;font-weight:bold;white-space:nowrap;touch-action:manipulation;">🔄 Cập nhật</button>
                    <button id="vltk-ns-close" style="margin-left:auto;background:none;border:none;color:#fff;cursor:pointer;font-size:18px;font-weight:bold;padding:0 4px;line-height:1;touch-action:manipulation;">✖</button>
                </div>

                <div style="display:flex;background:#2d2d2d;border-bottom:1px solid #444;">
                    <button id="tab-ns" style="flex:1;padding:8px 4px;background:#1e1e1e;color:#4ec9b0;border:none;border-bottom:2px solid #4ec9b0;font-weight:bold;font-size:12px;cursor:pointer;">⚙️ Sửa Ns</button>
                    <button id="tab-server" style="flex:1;padding:8px 4px;background:#2d2d2d;color:#aaa;border:none;font-weight:bold;font-size:12px;cursor:pointer;">🔍 Quét Server</button>
                    <button id="tab-notes" style="flex:1;padding:8px 4px;background:#2d2d2d;color:#aaa;border:none;font-weight:bold;font-size:12px;cursor:pointer;">📝 Ghi Chú</button>
                </div>

                <div id="view-ns" style="display:flex;flex-direction:column;flex-grow:1;overflow:hidden;">
                    <div id="vltk-ns-status" style="padding:8px 10px;color:#dcdcaa;font-size:12px;border-bottom:1px solid #333;">Đang kiểm tra Ns...</div>
                    <div style="padding:10px;border-bottom:1px solid #333;">
                        <input type="text" id="vltk-ns-search" placeholder="Gõ tên trang bị hoặc thuộc tính (VD: weapon, cuff, gold)..." style="width:100%;padding:8px;background:#2d2d2d;color:#fff;border:1px solid #444;border-radius:4px;box-sizing:border-box;font-size:13px;">
                    </div>
                    <div id="vltk-ns-list" style="padding:10px;overflow-y:auto;overflow-x:hidden;flex-grow:1;touch-action:pan-y;"></div>
                </div>

                <div id="view-server" style="display:none;flex-direction:column;flex-grow:1;overflow:hidden;padding:10px;">
                    <div style="margin-bottom:8px;color:#4ec9b0;font-size:12px;font-weight:bold;">🔎 Đang quét sâu dữ liệu trang bị từ Window & Game Cache...</div>
                    <div style="display:flex;gap:6px;margin-bottom:8px;">
                        <input type="text" id="server-item-search" placeholder="Nhập tên vật phẩm (VD: Hộ Uyển, Kiếm, Nhẫn, Áo)..." style="flex:1;padding:8px;background:#2d2d2d;color:#fff;border:1px solid #444;border-radius:4px;font-size:13px;">
                        <button id="server-item-scan-btn" style="padding:6px 12px;background:#0e639c;color:#fff;border:none;border-radius:4px;font-size:12px;font-weight:bold;cursor:pointer;">Săn ID</button>
                    </div>
                    <div id="server-item-list" style="flex-grow:1;overflow-y:auto;background:#252526;border:1px solid #333;border-radius:4px;padding:8px;">
                        <div style="color:#aaa;text-align:center;padding:15px;">Đang quét... Nhập từ khóa để xem ID vật phẩm mẫu</div>
                    </div>
                </div>

                <div id="view-notes" style="display:none;flex-direction:column;flex-grow:1;padding:10px;overflow:hidden;">
                    <div style="display:flex;gap:6px;margin-bottom:8px;">
                        <input type="text" id="note-search" placeholder="🔍 Tìm kiếm ghi chú..." style="flex:1;padding:8px;background:#2d2d2d;color:#fff;border:1px solid #444;border-radius:4px;font-size:13px;">
                        <button id="note-refresh" style="padding:6px 12px;background:#0e639c;color:#fff;border:none;border-radius:4px;font-size:12px;font-weight:bold;cursor:pointer;">🔄 Tải lại</button>
                    </div>
                    <div style="display:flex;gap:6px;margin-bottom:8px;">
                        <input type="text" id="note-input" placeholder="Viết ghi chú mới..." style="flex:1;padding:8px;background:#2d2d2d;color:#fff;border:1px solid #444;border-radius:4px;font-size:13px;">
                        <button id="note-add" style="padding:6px 12px;background:#107c41;color:#fff;border:none;border-radius:4px;font-size:12px;font-weight:bold;cursor:pointer;">➕ Thêm</button>
                    </div>
                    <div id="note-list" style="flex-grow:1;overflow-y:auto;background:#252526;border:1px solid #333;border-radius:4px;padding:8px;">
                        <div style="color:#aaa;text-align:center;padding:10px;">Đang tải ghi chú...</div>
                    </div>
                </div>`;

            setTimeout(() => {
                makeDraggable(box, document.getElementById('vltk-ns-header'));

                const tabNs = document.getElementById('tab-ns');
                const tabServer = document.getElementById('tab-server');
                const tabNotes = document.getElementById('tab-notes');

                const viewNs = document.getElementById('view-ns');
                const viewServer = document.getElementById('view-server');
                const viewNotes = document.getElementById('view-notes');

                tabNs.onclick = () => {
                    tabNs.style.background = '#1e1e1e'; tabNs.style.color = '#4ec9b0'; tabNs.style.borderBottom = '2px solid #4ec9b0';
                    tabServer.style.background = '#2d2d2d'; tabServer.style.color = '#aaa'; tabServer.style.borderBottom = 'none';
                    tabNotes.style.background = '#2d2d2d'; tabNotes.style.color = '#aaa'; tabNotes.style.borderBottom = 'none';
                    viewNs.style.display = 'flex'; viewServer.style.display = 'none'; viewNotes.style.display = 'none';
                };

                tabServer.onclick = () => {
                    tabServer.style.background = '#1e1e1e'; tabServer.style.color = '#4ec9b0'; tabServer.style.borderBottom = '2px solid #4ec9b0';
                    tabNs.style.background = '#2d2d2d'; tabNs.style.color = '#aaa'; tabNs.style.borderBottom = 'none';
                    tabNotes.style.background = '#2d2d2d'; tabNotes.style.color = '#aaa'; tabNotes.style.borderBottom = 'none';
                    viewServer.style.display = 'flex'; viewNs.style.display = 'none'; viewNotes.style.display = 'none';
                    scanServerItems();
                };

                tabNotes.onclick = () => {
                    tabNotes.style.background = '#1e1e1e'; tabNotes.style.color = '#4ec9b0'; tabNotes.style.borderBottom = '2px solid #4ec9b0';
                    tabNs.style.background = '#2d2d2d'; tabNs.style.color = '#aaa'; tabNs.style.borderBottom = 'none';
                    tabServer.style.background = '#2d2d2d'; tabServer.style.color = '#aaa'; tabServer.style.borderBottom = 'none';
                    viewNotes.style.display = 'flex'; viewNs.style.display = 'none'; viewServer.style.display = 'none';
                    loadSharedNotes();
                };

                document.getElementById('vltk-ns-close').onclick = () => { box.style.display = 'none'; };

                const updateBtn = document.getElementById('vltk-ns-update');
                updateBtn.onclick = function (e) {
                    if (e && e.cancelable) e.preventDefault();
                    updateBtn.innerText = "⏳ Đang tải...";
                    updateBtn.disabled = true;

                    let attemptIndex = 0;
                    function fetchNextEndpoint() {
                        if (attemptIndex >= UPDATE_ENDPOINTS.length) {
                            updateBtn.innerText = "❌ Lỗi";
                            updateBtn.style.background = "#d9534f";
                            setTimeout(() => {
                                updateBtn.innerText = "🔄 Cập nhật";
                                updateBtn.style.background = "#28a745";
                                updateBtn.disabled = false;
                            }, 2000);
                            return;
                        }

                        const targetUrl = UPDATE_ENDPOINTS[attemptIndex] + "?nocache=" + Date.now();
                        fetch(targetUrl, { cache: "no-store" })
                            .then(res => {
                                if (!res.ok) throw new Error("HTTP " + res.status);
                                return res.text();
                            })
                            .then(newCode => {
                                updateBtn.innerText = "✅ Đã xong";
                                updateBtn.style.background = "#107c41";
                                if (typeof window.__vltkDestroyUI === 'function') window.__vltkDestroyUI();
                                setTimeout(() => {
                                    try {
                                        const scriptFn = new Function(newCode);
                                        scriptFn();
                                    } catch (err) {
                                        eval(newCode);
                                    }
                                }, 300);
                            })
                            .catch(() => {
                                attemptIndex++;
                                fetchNextEndpoint();
                            });
                    }
                    fetchNextEndpoint();
                };

                document.getElementById('vltk-ns-search').oninput = function () {
                    clearTimeout(searchDebounceTimer);
                    searchDebounceTimer = setTimeout(() => refreshUI(true), 200);
                };

                document.getElementById('server-item-search').oninput = scanServerItems;
                document.getElementById('server-item-scan-btn').onclick = scanServerItems;

                document.getElementById('note-add').onclick = addSharedNote;
                document.getElementById('note-refresh').onclick = loadSharedNotes;
                document.getElementById('note-search').oninput = renderNotesUI;

            }, 100);

            return box;
        }

        // =============================================================
        // QUÉT TRANG BỊ NÂNG CAO TỪ CẢ WINDOW VÀ NS
        // =============================================================
        function scanServerItems() {
            const listEl = document.getElementById('server-item-list');
            const searchEl = document.getElementById('server-item-search');
            if (!listEl) return;

            const query = (searchEl && searchEl.value || '').toLowerCase().trim();
            const results = [];
            const seenIds = new Set();

            function checkObj(obj, path) {
                if (!obj || typeof obj !== 'object') return;
                for (let k in obj) {
                    try {
                        let item = obj[k];
                        if (item && typeof item === 'object') {
                            let name = item.n || item.name || item.title;
                            let id = item.id || item.k || item.type || k;
                            if (name && typeof name === 'string' && name.length > 1) {
                                const keyId = path + '_' + id + '_' + name;
                                if (!seenIds.has(keyId)) {
                                    if (!query || name.toLowerCase().includes(query) || String(id).includes(query)) {
                                        seenIds.add(keyId);
                                        results.push({ id: id, name: name, path: path });
                                    }
                                }
                            }
                        }
                    } catch (e) {}
                }
            }

            // Quét danh sách biến toàn cục
            Object.keys(window).forEach(wKey => {
                if (/^(Cfg|Item|Equip|Config|JX|JW|JS|JSP|G|Ns)/i.test(wKey)) {
                    checkObj(window[wKey], wKey);
                }
            });

            // Quét trong Ns
            if (window.Ns) {
                checkObj(window.Ns.eq, 'Ns.eq');
                checkObj(window.Ns.inv, 'Ns.inv');
                checkObj(window.Ns.bag, 'Ns.bag');
            }

            if (results.length === 0) {
                listEl.innerHTML = `<div style="color:#aaa;text-align:center;padding:15px;">
                    ${query ? 'Không tìm thấy vật phẩm khớp từ khóa' : 'Nhập từ khóa (VD: Hộ uyển, Kiếm, Nhẫn) để truy tìm ID từ bộ nhớ cache'}
                </div>`;
                return;
            }

            const frag = document.createDocumentFragment();
            results.slice(0, 150).forEach(item => {
                const div = document.createElement('div');
                div.style.cssText = 'background:#2d2d2d;padding:8px;border-radius:4px;margin-bottom:6px;border-left:3px solid #007acc;display:flex;justify-content:space-between;align-items:center;font-size:12px;';
                div.innerHTML = `<div>
                                    <span style="color:#ffe875;font-weight:bold;">${escapeHtml(item.name)}</span>
                                    <span style="color:#666;font-size:10px;margin-left:6px;">[${escapeHtml(item.path)}]</span>
                                 </div>
                                 <div style="background:#1e1e1e;padding:2px 8px;border-radius:4px;color:#9cdcfe;font-weight:bold;font-family:monospace;">ID: ${escapeHtml(String(item.id))}</div>`;
                frag.appendChild(div);
            });

            listEl.innerHTML = '';
            listEl.appendChild(frag);
        }

        function loadSharedNotes() {
            const listEl = document.getElementById('note-list');
            if (listEl) listEl.innerHTML = '<div style="color:#aaa;text-align:center;padding:10px;">⏳ Đang tải ghi chú...</div>';

            try {
                const localData = localStorage.getItem('__vltk_shared_notes');
                sharedNotesData = localData ? JSON.parse(localData) : [
                    { id: 1, text: "📌 ID 114: Kháng tất cả | ID 115: Tốc độ đánh", time: "Hệ thống" },
                    { id: 2, text: "📌 ID 126: Sát thương vật lý | ID 135: May mắn", time: "Hệ thống" },
                    { id: 3, text: "📌 ID 136: Hút sinh lực | ID 139: Kỹ năng vốn có", time: "Hệ thống" }
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
                listEl.innerHTML = '<div style="color:#888;text-align:center;padding:15px;">Không tìm thấy ghi chú phù hợp</div>';
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
                statusEl.textContent = '✅ Đã gom nhóm gọn gàng! Bấm vào tên trang bị để xổ danh sách thuộc tính.';
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
            valInput.type = (typeof v === 'number') ? 'number' : 'text';
            valInput.value = (v !== undefined && v !== null) ? String(v) : '';
            valInput.style.cssText = 'flex:1 1 35%;width:0;min-width:60px;padding:4px 6px;background:#2d2d2d;color:#b5cea8;border:1px solid #555;border-radius:4px;font-size:12px;touch-action:manipulation;';

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
                let newV = (typeof v === 'number') ? Number(rawVal) : (typeof v === 'boolean' ? (rawVal === 'true') : rawVal);

                try {
                    let currentKey = key;
                    if (isEditingName && nameInput) {
                        const newPath = nameInput.value.trim();
                        const parts = newPath.split('.');
                        currentKey = parts[parts.length - 1];
                    }

                    parent[currentKey] = newV;

                    if (currentKey === 'a' && typeof newV === 'number' && ATTR_MAP[newV]) {
                        if (parent && parent.hasOwnProperty('n')) {
                            parent['n'] = ATTR_MAP[newV];
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
                        refreshUI(true);
                    }, 1000);
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
