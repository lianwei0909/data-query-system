/* ═══════════════════════════════════════════════════════════════
   common.js — 数据转换工具公共代码库
   被 index.html / converter-approve.html / converter-reject.html / converter-import.html 共享
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
    // ── Excel 解析库就绪：主页按需加载 xlsx（window.loadXlsx），独立打开子页面时 <head> 已同步加载 ──
    function ensureXlsx() {
        if (typeof XLSX !== 'undefined') return Promise.resolve(XLSX);
        if (typeof window !== 'undefined' && typeof window.loadXlsx === 'function') return window.loadXlsx();
        return Promise.reject(new Error('Excel 解析库未加载'));
    }

    // ── 文本解码：优先 UTF-8（含 BOM），不是合法 UTF-8 时按 GBK 解码（中文 Windows 版 Excel 另存的 CSV 多为 GBK） ──
    function decodeText(buf) {
        var bytes = new Uint8Array(buf);
        if (typeof TextDecoder === 'undefined') return String.fromCharCode.apply(null, bytes);
        try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
        catch (e) {
            try { return new TextDecoder('gbk').decode(bytes); }
            catch (e2) { return new TextDecoder('utf-8').decode(bytes); }
        }
    }

    // ── 本地日期 YYYY-MM-DD（toISOString 是 UTC，北京时间 0~8 点会变成前一天） ──
    function localDateStr(d) {
        d = d || new Date();
        return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    }

    // ═══════════ 班表日期列：统一成带年份的 YYYY-MM-DD ═══════════
    // 支持：2026-11-21 / 2026/11/21 / 2026年11月21日 / 11月21日 / 11月21号
    function parseDateKey(key) {
        var s = String(key == null ? '' : key).trim(), m;
        if ((m = s.match(/^(\d{4})\s*[-\/.年]\s*(\d{1,2})\s*[-\/.月]\s*(\d{1,2})\s*[日号]?$/))) return { y: +m[1], m: +m[2], d: +m[3] };
        if ((m = s.match(/^(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?$/))) return { y: null, m: +m[1], d: +m[2] };
        return null;
    }
    function ymdKey(y, m, d) { return y + '-' + pad2(m) + '-' + pad2(d); }
    function isYmdKey(k) { return /^\d{4}-\d{2}-\d{2}$/.test(String(k)); }

    // 给没有年份的日期列推断年份：按列顺序遇到月份回绕（12 月 → 1 月）年份 +1；
    // 起始年份取「让这段日期的中点离参考日期最近」的那一年（默认参考日期 = 今天）。
    // 返回 { 原列名: 'YYYY-MM-DD' }，非日期列不出现在结果里。
    function inferDateKeys(keys, refDate) {
        refDate = refDate || new Date();
        var out = {}, seq = [];
        keys.forEach(function (k) {
            var p = parseDateKey(k);
            if (!p || p.m < 1 || p.m > 12 || p.d < 1 || p.d > 31) return;
            if (p.y) out[k] = ymdKey(p.y, p.m, p.d);
            else seq.push({ k: k, m: p.m, d: p.d });
        });
        if (!seq.length) return out;
        var off = 0, offs = [0];
        for (var i = 1; i < seq.length; i++) {
            if (seq[i].m < seq[i - 1].m - 6) off++;          // 12 → 1：跨年
            offs.push(off);
        }
        var mid = Math.floor(seq.length / 2), best = null;
        for (var y = refDate.getFullYear() - 1; y <= refDate.getFullYear() + 1; y++) {
            var t = new Date(y + offs[mid], seq[mid].m - 1, seq[mid].d).getTime();
            var dist = Math.abs(t - refDate.getTime());
            if (!best || dist < best.dist) best = { y: y, dist: dist };
        }
        seq.forEach(function (s, j) { out[s.k] = ymdKey(best.y + offs[j], s.m, s.d); });
        return out;
    }
    // 把一组班表行的日期列名改写成 YYYY-MM-DD（旧数据迁移、导入时统一调用）
    function normalizeShiftRows(rows, refDate) {
        if (!Array.isArray(rows) || !rows.length) return { rows: rows || [], changed: false };
        var all = {};
        rows.forEach(function (r) { if (r && typeof r === 'object') Object.keys(r).forEach(function (k) { all[k] = 1; }); });
        var keys = Object.keys(all);
        var map = inferDateKeys(keys, refDate), changed = false;
        keys.forEach(function (k) { if (map[k] && map[k] !== k) changed = true; });
        if (!changed) return { rows: rows, changed: false };
        var out = rows.map(function (r) {
            if (!r || typeof r !== 'object') return r;
            var n = {};
            Object.keys(r).forEach(function (k) {
                var nk = map[k] || k;
                if (n[nk] === undefined || String(n[nk]).trim() === '') n[nk] = r[k];
            });
            return n;
        });
        return { rows: out, changed: true };
    }
    // 班表行的「人」标识：英文名优先，其次中文名、企业名（用于多次导入合并）
    function shiftRowKey(r) {
        if (!r || typeof r !== 'object') return '';
        var keys = Object.keys(r), pick = function (re) {
            for (var i = 0; i < keys.length; i++) if (re.test(keys[i])) { var v = String(r[keys[i]] || '').trim(); if (v) return v; }
            return '';
        };
        return (pick(/英文/) || pick(/中文|姓名/) || pick(/企业/)).toLowerCase();
    }
    // 合并新旧班表：同一个人按日期合并（同一天以新导入为准），旧数据里的其他日期、其他人保留
    function mergeShiftRows(oldRows, newRows) {
        var out = [], idx = {};
        (oldRows || []).forEach(function (r) {
            var k = shiftRowKey(r);
            if (!k) return;                       // 没有姓名的旧行（表尾说明等）以新导入为准
            idx[k] = out.length; out.push(Object.assign({}, r));
        });
        (newRows || []).forEach(function (r) {
            var k = shiftRowKey(r);
            if (k && idx[k] !== undefined) {
                var cur = out[idx[k]];
                Object.keys(r).forEach(function (f) {
                    var v = r[f];
                    if (isYmdKey(f)) { if (String(v == null ? '' : v).trim() !== '') cur[f] = v; }
                    else if (String(v == null ? '' : v).trim() !== '') cur[f] = v;
                });
            } else {
                if (k) idx[k] = out.length;
                out.push(Object.assign({}, r));
            }
        });
        return out;
    }
    // 一组行里的日期范围（用于导入提示）
    function shiftDateRange(rows) {
        var ks = {};
        (rows || []).forEach(function (r) { if (r) Object.keys(r).forEach(function (k) { if (isYmdKey(k)) ks[k] = 1; }); });
        var list = Object.keys(ks).sort();
        return list.length ? { from: list[0], to: list[list.length - 1], days: list.length } : null;
    }

    function readFile(file, callback) {
        var ext = file.name.split('.').pop().toLowerCase();
        if (!['csv', 'xlsx', 'xls'].includes(ext)) {
            callback(new Error('请上传 CSV 或 Excel 文件'), null, ext);
            return;
        }
        if (ext !== 'csv' && typeof XLSX === 'undefined') {
            // 主页按需加载 xlsx：网络慢时用户可能在库下载完成前就选了文件
            ensureXlsx().then(function () { readFile(file, callback); },
                function () { callback(new Error('Excel 解析库加载失败，请检查网络后重试'), null, ext); });
            return;
        }
        var reader = new FileReader();
        reader.onload = function(ev) {
            var data;
            try {
                if (ext === 'csv') {
                    data = parseCSV(decodeText(ev.target.result));
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
        reader.readAsArrayBuffer(file);   // CSV 也按二进制读，交给 decodeText 识别 UTF-8 / GBK
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
    // 全站共用一个提示框 #dc-toast 和一个加载层 #dc-loader：挂在 <body> 直下，样式注入 <head>。
    // 子页面嵌入主页、或在模块之间切换时，样式不会随子页面一起被卸载，所以不会残留成无样式文字、也不会挤歪布局。
    // 隐藏时 opacity:0 + visibility:hidden，不靠位移藏到屏幕外，因此不会露出半截。
    function ensureUiStyle() {
        if (typeof document === 'undefined' || document.getElementById('dc-ui-style')) return;
        var st = document.createElement('style');
        st.id = 'dc-ui-style';
        st.textContent =
            '#dc-toast{position:fixed;top:24px;right:24px;z-index:2147483000;max-width:min(520px,calc(100vw - 48px));padding:14px 24px;border-radius:12px;' +
            'font-size:14px;font-weight:600;line-height:1.5;white-space:pre-wrap;word-break:break-word;color:#e5e7eb;background:rgba(24,26,33,.95);' +
            'border:1px solid rgba(255,255,255,.14);box-shadow:0 10px 30px rgba(0,0,0,.35);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);' +
            'opacity:0;visibility:hidden;transform:translateX(24px);pointer-events:none;' +
            'transition:opacity .25s ease,transform .3s cubic-bezier(.16,1,.3,1),visibility 0s linear .3s}' +
            '#dc-toast.show{opacity:1;visibility:visible;transform:none;transition:opacity .25s ease,transform .3s cubic-bezier(.16,1,.3,1),visibility 0s}' +
            '#dc-toast.success{background:rgba(6,60,46,.95);border-color:rgba(16,185,129,.6);color:#a7f3d0}' +
            '#dc-toast.error{background:rgba(70,18,18,.95);border-color:rgba(239,68,68,.6);color:#fecaca}' +
            '#dc-toast.info{background:rgba(18,38,78,.95);border-color:rgba(59,130,246,.6);color:#bfdbfe}' +
            '#dc-loader{display:none;position:fixed;inset:0;z-index:2147482000;background:rgba(5,10,30,.85);justify-content:center;align-items:center;flex-direction:column}' +
            '#dc-loader.active{display:flex}' +
            '#dc-loader .dc-spinner{width:60px;height:60px;border:4px solid rgba(168,85,247,.3);border-top-color:#a855f7;border-radius:50%;animation:dcSpin 1s linear infinite}' +
            '#dc-loader .dc-loader-text{margin-top:25px;font-size:1.2em;color:rgba(255,255,255,.85);letter-spacing:1px}' +
            '@keyframes dcSpin{to{transform:rotate(360deg)}}' +
            // 各页面自带的旧提示框 / 加载层不再使用，统一隐藏，避免嵌入主页后样式丢失露出来
            '#notification,#loader{display:none!important}';
        (document.head || document.documentElement).appendChild(st);
    }
    function bodyChild(id, build) {
        ensureUiStyle();
        var el = document.getElementById(id);
        if (!el) { el = document.createElement('div'); el.id = id; if (build) build(el); }
        if (el.parentNode !== document.body) document.body.appendChild(el);
        return el;
    }
    function getToastEl() {
        return bodyChild('dc-toast', function (el) { el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite'); });
    }
    function getLoaderEl() {
        return bodyChild('dc-loader', function (el) {
            el.innerHTML = '<div class="dc-spinner"></div><div class="dc-loader-text">处理中...</div>';
        });
    }

    var _notifTimer = null;
    function showNotification(msg, type) {
        type = type || 'success';
        if (typeof document === 'undefined' || !document.body) return;
        var el = getToastEl();
        if (_notifTimer) { clearTimeout(_notifTimer); _notifTimer = null; }
        el.classList.remove('show');
        el.textContent = msg;
        el.className = type;
        void el.offsetWidth; // 强制重排，保证连续提示也能重新播放动画
        el.classList.add('show');
        _notifTimer = setTimeout(function () {
            el.classList.remove('show');
            _notifTimer = null;
        }, type === 'error' ? 4500 : 2800);
    }

    // ── Loading 控制 ──
    function showLoader(text) {
        if (typeof document === 'undefined' || !document.body) return;
        var el = getLoaderEl();
        var lt = el.querySelector('.dc-loader-text');
        if (lt) lt.textContent = text || '处理中...';
        el.classList.add('active');
    }

    function hideLoader() {
        if (typeof document === 'undefined') return;
        var el = document.getElementById('dc-loader');
        if (el) el.classList.remove('active');
    }

    return {
        VERSION: 4,   // 提示框/加载层新版标记，scheduler.js 据此判断是否可用
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
        ensureXlsx: ensureXlsx,
        decodeText: decodeText,
        localDateStr: localDateStr,
        parseDateKey: parseDateKey,
        ymdKey: ymdKey,
        isYmdKey: isYmdKey,
        inferDateKeys: inferDateKeys,
        normalizeShiftRows: normalizeShiftRows,
        shiftRowKey: shiftRowKey,
        mergeShiftRows: mergeShiftRows,
        shiftDateRange: shiftDateRange,
        createPagination: createPagination,
        exportToExcel: exportToExcel,
        renderStats: renderStats,
        showNotification: showNotification,
        showLoader: showLoader,
        hideLoader: hideLoader
    };
})();
