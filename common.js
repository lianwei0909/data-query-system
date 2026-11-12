/* ═══════════════════════════════════════════════════════════════
   common.js — 数据转换工具公共代码库
   被 converter-approve.html / converter-reject.html / converter-music.html 共享
   ═══════════════════════════════════════════════════════════════ */

var DC = (function() {
    'use strict';

    var PAGE_SIZE = 20;

    // ── 调试开关 ──
    var DEBUG = false;
    function log() { if (DEBUG) console.log.apply(console, arguments); }

    // ── HTML 转义（防 XSS） ──
    function escapeHtml(str) {
        if (str === null || str === undefined) return '';
        str = String(str);
        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // ── CSV 解析器（逐字符状态机，正确处理引号内换行和逗号） ──
    function parseCSV(text) {
        if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // 去 BOM
        text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

        var rows = [];
        var currentRow = [];
        var currentField = '';
        var inQuotes = false;
        var i = 0;

        while (i <= text.length) {
            if (i === text.length) {
                if (currentField || currentRow.length > 0) {
                    currentRow.push(currentField);
                    if (currentRow.some(function(f) { return f && f.trim(); })) rows.push(currentRow);
                }
                break;
            }
            var ch = text[i];
            if (inQuotes) {
                if (ch === '"') {
                    if (i + 1 < text.length && text[i + 1] === '"') {
                        currentField += '"'; i += 2; continue;
                    } else { inQuotes = false; i++; continue; }
                } else { currentField += ch; i++; continue; }
            } else {
                if (ch === '"') { inQuotes = true; i++; continue; }
                else if (ch === ',') { currentRow.push(currentField); currentField = ''; i++; continue; }
                else if (ch === '\n') {
                    currentRow.push(currentField); currentField = '';
                    if (currentRow.some(function(f) { return f && f.trim(); })) rows.push(currentRow);
                    currentRow = []; i++; continue;
                } else { currentField += ch; i++; continue; }
            }
        }

        if (rows.length < 2) return [];

        var headers = rows[0].map(function(h) {
            var s = h || '';
            if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
            return s.trim();
        });

        var result = [];
        for (var ri = 1; ri < rows.length; ri++) {
            var vals = rows[ri];
            var obj = {};
            headers.forEach(function(h, j) {
                obj[h] = (vals[j] || '').replace(/\t/g, ' ').trim();
            });
            result.push(obj);
        }
        log('[CSV] 解析完成：', result.length, '行，列名：', headers);
        return result;
    }

    // ── JSON 转义序列还原：\" → "，\\ → \，\/ → /，\n → 换行 等 ──
    // 同时去除源数据中残留的孤立反斜杠（如 \" 未被正确解析时的多余 \）
    function decodeJsonEscapes(s) {
        if (s == null) return '';
        return String(s).replace(/\\(.)/g, function(_, c) {
            switch (c) {
                case 'n':  return '\n';
                case 'r':  return '\r';
                case 't':  return '\t';
                case '"':  return '"';
                case '\\': return '\\';
                case '/':  return '/';
                default:   return c; // 未知转义：去掉反斜杠，保留后面的字符
            }
        });
    }

    // ── 转义感知的值扫描：从 valStart 起，正确处理 \" 转义引号与 \\ 转义 ──
    // 支持三种形态：普通引号 "value"、转义引号 \"value\"、无引号纯值
    function scanValue(rest, valStart) {
        if (rest[valStart] === '"') {
            // 普通引号，逐个字符扫描，遇 \ 时连同其后字符一并保留（不当作结束）
            var i = valStart + 1, buf = '';
            while (i < rest.length) {
                var c = rest[i];
                if (c === '\\') { buf += c + (rest[i + 1] || ''); i += 2; continue; }
                if (c === '"') { return buf; }
                buf += c; i++;
            }
            return buf;
        }
        if (rest[valStart] === '\\' && rest[valStart + 1] === '"') {
            // 转义引号 \"value\"（双编码 JSON 常见形态）
            var j = valStart + 2, b2 = '';
            while (j < rest.length) {
                if (rest[j] === '\\' && rest[j + 1] === '"') { return b2; }
                b2 += rest[j]; j++;
            }
            return b2;
        }
        // 无引号纯值：截断到分隔符
        var k = valStart, b3 = '';
        while (k < rest.length && ' \n\r\t;,}'.indexOf(rest[k]) === -1) { b3 += rest[k]; k++; }
        return b3;
    }

    // ── 从 JSON 格式字符串中搜索 "key":"value" 提取值 ──
    function extractFromStr(str, key) {
        if (!str) return null;

        // 优先：整段是合法 JSON 时直接解析（最常见、最干净，无残留反斜杠）
        try {
            var parsed = JSON.parse(str);
            if (parsed && typeof parsed === 'object' && key in parsed && parsed[key] != null) {
                return String(parsed[key]).replace(/[\n\r\t]+/g, ' ').trim() || null;
            }
        } catch (e) { /* 不是合法 JSON，走下面的字符串扫描 */ }

        // 回退：转义感知的字符串扫描（兼容 JSON 片段 / 非标准 JSON）
        function doExtract(s, quoteStyle) {
            var keyWithQuote = quoteStyle + key + quoteStyle;
            var idx = s.indexOf(keyWithQuote);
            if (idx === -1) return null;

            var rest = s.slice(idx + keyWithQuote.length);
            var colonIdx = -1;
            for (var j = 0; j < rest.length; j++) {
                if (rest[j] === ':' || rest[j] === ';') { colonIdx = j; break; }
            }
            if (colonIdx === -1) return null;

            rest = rest.slice(colonIdx + 1);
            var valStart = 0;
            while (valStart < rest.length && (rest[valStart] === ' ' || rest[valStart] === '\t')) valStart++;
            if (valStart >= rest.length) return null;

            var raw = scanValue(rest, valStart).replace(/[\n\r\t]+/g, ' ').trim();
            return raw ? decodeJsonEscapes(raw) : null;
        }

        return doExtract(str, '"') || doExtract(str, '\\"');
    }

    // ── 时间格式化 ──
    // keepTime=true 保留 HH:mm:ss，false 只保留 YYYY/M/D
    // Excel 序列号是「本地时间、无时区」的天数：整数部分 = 日期，小数部分 = 一天中的时刻。
    // 原来用 UTC 毫秒数 new Date() 再按本地时间读，北京时间会整体偏 +8 小时（晚上 20 点变成次日）。
    function excelSerialToParts(serial) {
        var n = parseFloat(serial);
        if (!isFinite(n)) return null;
        var days = Math.floor(n);
        var secs = Math.round((n - days) * 86400);
        if (secs >= 86400) { days += 1; secs -= 86400; }
        // 25569 = 1970-01-01；用 UTC 构造再用 UTC 读，全程不经过本地时区
        var d = new Date((days - 25569) * 86400000);
        if (isNaN(d)) return null;
        return {
            y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(),
            hh: Math.floor(secs / 3600), mm: Math.floor((secs % 3600) / 60), ss: secs % 60
        };
    }
    function pad2(n) { return (n < 10 ? '0' : '') + n; }
    function formatTimeStamp(ts, keepTime) {
        keepTime = !!keepTime;
        if (ts === null || ts === undefined || ts === '') return '';
        if (ts instanceof Date) {
            if (isNaN(ts)) return '';
            var base = ts.getFullYear() + '/' + (ts.getMonth() + 1) + '/' + ts.getDate();
            return keepTime ? base + ' ' + pad2(ts.getHours()) + ':' + pad2(ts.getMinutes()) + ':' + pad2(ts.getSeconds()) : base;
        }
        ts = String(ts).replace(/\t/g, ' ').trim();

        // Excel 序列号（如 46191.8333）
        if (/^\d+(\.\d+)?$/.test(ts) && ts.length <= 12) {
            var p = excelSerialToParts(ts);
            if (!p) return ts;
            var r0 = p.y + '/' + p.m + '/' + p.d;
            return keepTime ? r0 + ' ' + pad2(p.hh) + ':' + pad2(p.mm) + ':' + pad2(p.ss) : r0;
        }

        // 日期字符串 "2026-06-18 10:53:41" 或 "2026/06/18"
        var m = ts.match(/^(\d{4})[/\-](\d{1,2})[/\-](\d{1,2})/);
        if (m) {
            var result = m[1] + '/' + parseInt(m[2]) + '/' + parseInt(m[3]);
            if (keepTime) {
                var after = ts.slice(m[0].length).trim();
                var tm = after.match(/^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/);
                if (tm) {
                    result += ' ' + tm[1].padStart(2, '0') + ':' + tm[2].padStart(2, '0') +
                        ':' + (tm[3] || '00').padStart(2, '0');
                }
            }
            return result;
        }
        return ts;
    }

    // ── 拖拽上传初始化 ──
    function setupDragDrop(element, onDrop) {
        if (typeof element === 'string') element = document.getElementById(element);

        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(function(eventName) {
            element.addEventListener(eventName, function(e) {
                e.preventDefault();
                e.stopPropagation();
            }, false);
        });
        element.addEventListener('dragenter', function() { element.classList.add('drag-over'); });
        element.addEventListener('dragover', function(e) {
            e.dataTransfer.dropEffect = 'copy';
            element.classList.add('drag-over');
        });
        element.addEventListener('dragleave', function(e) {
            if (!element.contains(e.relatedTarget)) element.classList.remove('drag-over');
        });
        element.addEventListener('drop', function(e) {
            e.preventDefault();
            e.stopPropagation();
            element.classList.remove('drag-over');
            if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                onDrop(e.dataTransfer.files[0]);
            }
        });
    }

    // ── 文件读取（自动判断 CSV / Excel） ──
    // 读出的每个单元格统一转成字符串（数字型 TimeStamp 等不会再因 .trim() 报错）；
    // 解析与回调分开 try：回调内部的异常不会被误报为「文件解析失败」并导致回调执行两次
    function stringifyRow(row) {
        var o = {};
        Object.keys(row).forEach(function(k) {
            var v = row[k];
            if (v === null || v === undefined) o[k] = '';
            else if (v instanceof Date) o[k] = formatTimeStamp(v, true);
            else o[k] = String(v);
        });
        return o;
    }
    function readFile(file, callback) {
        var ext = file.name.split('.').pop().toLowerCase();
        if (!['csv', 'xlsx', 'xls'].includes(ext)) {
            callback(new Error('请上传 CSV 或 Excel 文件'), null, ext);
            return;
        }
        var reader = new FileReader();
        reader.onload = function(ev) {
            var data;
            try {
                if (ext === 'csv') {
                    data = parseCSV(ev.target.result);
                } else {
                    var wb = XLSX.read(ev.target.result, { type: 'array' });
                    var ws = wb.Sheets[wb.SheetNames[0]];
                    data = XLSX.utils.sheet_to_json(ws, { defval: '' }).map(stringifyRow);
                }
            } catch (err) {
                callback(err, null, ext);
                return;
            }
            callback(null, data, ext);
        };
        reader.onerror = function() {
            callback(new Error('文件读取失败'), null, ext);
        };
        ext === 'csv' ? reader.readAsText(file, 'UTF-8') : reader.readAsArrayBuffer(file);
    }

    // ── 分页表格渲染（XSS 安全） ──
    function createPagination(data, columns, options) {
        options = options || {};
        var pageSize = options.pageSize || PAGE_SIZE;
        var currentPage = 1;
        var bodyEl = typeof options.bodyEl === 'string' ? document.getElementById(options.bodyEl) : options.bodyEl;
        var infoEl = options.infoEl ? (typeof options.infoEl === 'string' ? document.getElementById(options.infoEl) : options.infoEl) : null;
        var prevBtn = options.prevBtn ? (typeof options.prevBtn === 'string' ? document.getElementById(options.prevBtn) : options.prevBtn) : null;
        var nextBtn = options.nextBtn ? (typeof options.nextBtn === 'string' ? document.getElementById(options.nextBtn) : options.nextBtn) : null;
        var wrapperEl = options.wrapperEl ? (typeof options.wrapperEl === 'string' ? document.getElementById(options.wrapperEl) : options.wrapperEl) : null;
        var maxCellLen = options.maxCellLen || 50;

        function totalPages() { return Math.ceil(data.length / pageSize) || 1; }

        function renderPage() {
            var start = (currentPage - 1) * pageSize;
            var end = start + pageSize;
            var pageData = data.slice(start, end);

            bodyEl.innerHTML = pageData.map(function(row) {
                return '<tr>' + columns.map(function(col) {
                    if (col === '' || col === null) return '<td></td>';
                    var val = row[col] || '';
                    var displayVal = String(val).length > maxCellLen ? String(val).substring(0, maxCellLen) + '...' : String(val);
                    // ✅ XSS 安全：两个位置都转义
                    return '<td title="' + escapeHtml(val) + '">' + escapeHtml(displayVal) + '</td>';
                }).join('') + '</tr>';
            }).join('');

            var tp = totalPages();
            if (infoEl) infoEl.textContent = '第 ' + currentPage + ' / ' + tp + ' 页　（共 ' + data.length + ' 条）';
            if (prevBtn) prevBtn.disabled = currentPage <= 1;
            if (nextBtn) nextBtn.disabled = currentPage >= tp;
            if (wrapperEl) wrapperEl.style.display = data.length > pageSize ? '' : 'none';
        }

        function changePage(delta) {
            var tp = totalPages();
            currentPage = Math.max(1, Math.min(tp, currentPage + delta));
            renderPage();
        }

        function setData(newData) {
            data = newData;
            currentPage = 1;
            renderPage();
        }

        return {
            render: renderPage,
            changePage: changePage,
            setData: setData
        };
    }

    // ── 文本清洗：去除多余换行符、制表符、字面量 \n 等 ──
    function cleanText(val) {
        if (val == null) return '';
        var s = String(val);
        // 去真正的换行/制表
        s = s.replace(/[\n\r\t]+/g, ' ').trim();
        // 去字面量反斜杠-n / 反斜杠-r / 反斜杠-t（源数据中常见的转义残留）
        s = s.replace(/\\n/g, ' ').replace(/\\r/g, ' ').replace(/\\t/g, ' ').trim();
        // 去多余空格
        s = s.replace(/\s{2,}/g, ' ').trim();
        return s;
    }

    // ── Excel 导出 ──
    // data: 对象数组，columns: 输出列名数组，fileName: 文件名
    function exportToExcel(data, columns, fileName) {
        var aoa = [];
        aoa.push(columns.slice());
        data.forEach(function(row) {
            aoa.push(columns.map(function(col) {
                return col === '' || col === null ? '' : cleanText(row[col] || '');
            }));
        });

        var ws = XLSX.utils.aoa_to_sheet(aoa);

        // 设置列宽
        ws['!cols'] = columns.map(function(col) {
            if (!col) return { wch: 10 };
            var maxLen = col.length;
            data.forEach(function(row) {
                var v = String(row[col] || '');
                if (v.length > maxLen) maxLen = Math.min(v.length, 60);
            });
            return { wch: Math.max(maxLen + 4, 12) };
        });

        var wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
        XLSX.writeFile(wb, fileName);
    }

    // ── 统计卡片渲染 ──
    function renderStats(statsEl, cards) {
        statsEl = typeof statsEl === 'string' ? document.getElementById(statsEl) : statsEl;
        statsEl.innerHTML = cards.map(function(c) {
            return '<div class="stat-card' + (c.error ? ' stat-error' : '') + '" style="display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;">' +
                '<div class="stat-number" style="text-align:center;">' + c.value + '</div>' +
                '<div class="stat-label" style="text-align:center;">' + escapeHtml(c.label) + '</div>' +
                '</div>';
        }).join('');
    }

    // ── 通知 / 加载层 ──
    // 子页面嵌入主页时（index.html 只取 <body> 内容），#notification / #loader 及其样式可能缺失。
    // 这里找不到就自动创建并挂到 <body> 直下（避免被带 transform 的父容器影响 fixed 定位），并注入兜底样式。
    var _uiStyleInjected = false;
    function ensureUiStyle() {
        if (_uiStyleInjected || typeof document === 'undefined') return;
        _uiStyleInjected = true;
        if (document.getElementById('dc-ui-style')) return;
        var st = document.createElement('style');
        st.id = 'dc-ui-style';
        st.textContent =
            '.dc-notify{position:fixed;top:30px;right:30px;padding:16px 30px;border-radius:14px;font-size:1em;font-weight:600;z-index:100000;' +
            'transform:translateX(130%);transition:transform .4s cubic-bezier(.16,1,.3,1);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);max-width:520px;word-break:break-all;color:#fff}' +
            '.dc-notify.show{transform:translateX(0)}' +
            '.dc-notify.success{background:rgba(16,185,129,.25);border:1px solid rgba(16,185,129,.55);color:#6ee7b7}' +
            '.dc-notify.error{background:rgba(239,68,68,.25);border:1px solid rgba(239,68,68,.55);color:#fca5a5}' +
            '.dc-notify.info{background:rgba(59,130,246,.25);border:1px solid rgba(59,130,246,.55);color:#93c5fd}' +
            '.dc-loader{display:none;position:fixed;inset:0;background:rgba(5,10,30,.85);z-index:99999;justify-content:center;align-items:center;flex-direction:column}' +
            '.dc-loader.active{display:flex}' +
            '.dc-loader .spinner{width:60px;height:60px;border:4px solid rgba(168,85,247,.3);border-top-color:#a855f7;border-radius:50%;animation:dcSpin 1s linear infinite}' +
            '.dc-loader .loader-text{margin-top:25px;font-size:1.2em;color:rgba(255,255,255,.8);letter-spacing:1px}' +
            '@keyframes dcSpin{to{transform:rotate(360deg)}}';
        (document.head || document.body).appendChild(st);
    }
    function liftToBody(el) {
        if (el && el.parentNode !== document.body) document.body.appendChild(el);
        return el;
    }
    function getNotifyEl() {
        ensureUiStyle();
        var list = document.querySelectorAll('#notification');
        var el = list.length ? list[list.length - 1] : null;
        for (var i = 0; i < list.length - 1; i++) { if (list[i].parentNode) list[i].parentNode.removeChild(list[i]); }
        if (!el) { el = document.createElement('div'); el.id = 'notification'; }
        return liftToBody(el);
    }
    function getLoaderEl() {
        ensureUiStyle();
        var el = document.getElementById('loader');
        if (!el) {
            el = document.createElement('div');
            el.id = 'loader';
            el.className = 'loader';
            el.innerHTML = '<div class="spinner"></div><div class="loader-text" id="loaderText">处理中...</div>';
        }
        el.classList.add('dc-loader');
        return liftToBody(el);
    }

    var _notifTimer = null;
    function showNotification(msg, type) {
        type = type || 'success';
        if (typeof document === 'undefined') return;
        var el = getNotifyEl();
        // 清除上一次定时器
        if (_notifTimer) { clearTimeout(_notifTimer); _notifTimer = null; }
        // 先隐藏（移除 show class，inline transform 确保归位）
        el.classList.remove('show');
        el.style.transform = 'translateX(130%)';
        el.style.transition = 'none';
        void el.offsetWidth; // 强制重排
        // 重置内联样式，让 CSS class 接管动画
        el.style.transform = '';
        el.style.transition = '';
        el.textContent = msg;
        el.className = 'notification dc-notify ' + type;
        // 下一帧显示（确保浏览器已处理重置）
        requestAnimationFrame(function() {
            el.classList.add('show');
        });
        _notifTimer = setTimeout(function() {
            el.classList.remove('show');
            _notifTimer = null;
        }, type === 'error' ? 4500 : 2800);
    }

    // ── Loading 控制 ──
    function showLoader(text) {
        var loader = getLoaderEl();
        if (loader) {
            loader.classList.add('active');
            var lt = document.getElementById('loaderText');
            if (lt && text) lt.textContent = text;
        }
    }

    function hideLoader() {
        var loader = document.getElementById('loader');
        if (loader) loader.classList.remove('active');
    }

    return {
        PAGE_SIZE: PAGE_SIZE,
        DEBUG: DEBUG,
        log: log,
        escapeHtml: escapeHtml,
        parseCSV: parseCSV,
        extractFromStr: extractFromStr,
        formatTimeStamp: formatTimeStamp,
        excelSerialToParts: excelSerialToParts,
        setupDragDrop: setupDragDrop,
        readFile: readFile,
        createPagination: createPagination,
        exportToExcel: exportToExcel,
        renderStats: renderStats,
        showNotification: showNotification,
        showLoader: showLoader,
        hideLoader: hideLoader
    };
})();
