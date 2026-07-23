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

    // ── 从 JSON 格式字符串中搜索 "key":"value" 提取值（不依赖 JSON.parse） ──
    function extractFromStr(str, key) {
        if (!str) return null;

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

            // 情况1：引号包裹 "value"
            if (rest[valStart] === '"') {
                var endIdx = rest.indexOf('"', valStart + 1);
                var v1 = endIdx === -1 ? null : rest.slice(valStart + 1, endIdx).trim();
                if (v1) v1 = v1.replace(/[\n\r\t]+/g, ' ').trim();
                return v1 || null;
            }
            // 情况2：转义引号 \"value\"
            if (rest[valStart] === '\\' && rest[valStart + 1] === '"') {
                var escEnd = rest.indexOf('\\"', valStart + 2);
                var v2 = escEnd === -1 ? null : rest.slice(valStart + 2, escEnd).trim();
                if (v2) v2 = v2.replace(/[\n\r\t]+/g, ' ').trim();
                return v2 || null;
            }
            // 情况3：纯值（截断到分隔符）
            var valEnd = rest.length;
            for (var k = valStart; k < rest.length; k++) {
                if (rest[k] === ';' || rest[k] === ',' || rest[k] === '}' ||
                    rest[k] === '\n' || rest[k] === '\r' || rest[k] === ' ') {
                    valEnd = k; break;
                }
            }
            var val = rest.slice(valStart, valEnd).trim();
            // 清理多余换行符和不可见字符
            val = val.replace(/[\n\r\t]+/g, ' ').trim();
            return val || null;
        }

        return doExtract(str, '"') || doExtract(str, '\\"');
    }

    // ── 时间格式化 ──
    // keepTime=true 保留 HH:mm:ss，false 只保留 YYYY/M/D
    function formatTimeStamp(ts, keepTime = false) {
        if (!ts) return '';
        ts = String(ts).replace(/\t/g, ' ').trim();

        // Excel 序列号
        if (/^\d+(\.\d+)?$/.test(ts) && ts.indexOf('/') === -1 && ts.indexOf('-') === -1) {
            var d = new Date((parseFloat(ts) - 25569) * 86400 * 1000);
            if (isNaN(d)) return ts;
            if (keepTime) {
                return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate() +
                    ' ' + String(d.getHours()).padStart(2, '0') + ':' +
                    String(d.getMinutes()).padStart(2, '0') + ':' +
                    String(d.getSeconds()).padStart(2, '0');
            }
            return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate();
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
    function readFile(file, callback) {
        var ext = file.name.split('.').pop().toLowerCase();
        if (!['csv', 'xlsx', 'xls'].includes(ext)) {
            callback(new Error('请上传 CSV 或 Excel 文件'), null, ext);
            return;
        }
        var reader = new FileReader();
        reader.onload = function(ev) {
            try {
                var data;
                if (ext === 'csv') {
                    data = parseCSV(ev.target.result);
                } else {
                    var wb = XLSX.read(ev.target.result, { type: 'array' });
                    var ws = wb.Sheets[wb.SheetNames[0]];
                    data = XLSX.utils.sheet_to_json(ws);
                }
                callback(null, data, ext);
            } catch (err) {
                callback(err, null, ext);
            }
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

    // ── 通知（需要页面有 #notification 元素） ──
    var _notifTimer = null;
    function showNotification(msg, type) {
        type = type || 'success';
        var el = document.getElementById('notification');
        if (!el) return;
        // 清除上一次定时器
        if (_notifTimer) { clearTimeout(_notifTimer); _notifTimer = null; }
        // 先隐藏（移除 show class，inline transform 确保归位）
        el.classList.remove('show');
        el.style.transform = 'translateX(120%)';
        el.style.transition = 'none';
        void el.offsetWidth; // 强制重排
        // 重置内联样式，让 CSS class 接管动画
        el.style.transform = '';
        el.style.transition = '';
        el.textContent = msg;
        el.className = 'notification ' + type;
        // 下一帧显示（确保浏览器已处理重置）
        requestAnimationFrame(function() {
            el.classList.add('show');
        });
        _notifTimer = setTimeout(function() {
            el.classList.remove('show');
            _notifTimer = null;
        }, 2800);
    }

    // ── Loading 控制 ──
    function showLoader(text) {
        var loader = document.getElementById('loader');
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
