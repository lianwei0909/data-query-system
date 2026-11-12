/* ═══════════════════════════════════════════════════════════════
   scheduler.js — 智能排班模块（求解器 + 校验 + Excel 导出 + 页面逻辑）
   依赖：全局 XLSX（index.html 已加载 xlsx.full.min.js，实为 xlsx-js-style，支持单元格样式）
   可被 Node 直接 require 做单元测试（DOM 部分自动跳过）
   ═══════════════════════════════════════════════════════════════ */
var SCH = (function () {
    'use strict';

    // ── 常量 ──
    var LEAVE_TYPES = ['年假', '病假', '事假', '产检假', '婚假', '丧假', '调休假', '育儿假', '陪产假', '产假'];
    var NIGHT_SHIFT = '小夜班3';
    var DAY_SHIFT = '白班';
    var SHIFT_TIME = { '白班': '9 - 18', '小夜班3': '15 - 24' };

    // 状态编码：0=休/假  1=白班  2=夜班
    var OFF = 0, DAY = 1, NIGHT = 2;
    // 固定编码：0=自由 1=必休 2=指定白班 3=指定夜班 4=请假 5=上班则白班 6=上班则夜班
    var FIX_FREE = 0, FIX_REST = 1, FIX_DAY = 2, FIX_NIGHT = 3, FIX_LEAVE = 4, FIX_DAY_IF_WORK = 5, FIX_NIGHT_IF_WORK = 6;
    // 7 = 必须上班（白班夜班都行，但不能休）—— 来自「12月31日不休」「25号上班」
    var FIX_WORK = 7;

    var HARD = 1000;
    // 软目标权重。「孤立单休」不是软目标 —— 休息必须连续两天，已按硬约束处理
    var W = {
        longRest: 12, run6: 15, segLen: 8,
        segMix: 2, allNight: 120, allDay: 8,
        nightBias: 4, weekendBal: 5, prefer: 3, sw: 2,
        balanceNight: 30,
        // 「小夜后次日不上白班」降级为重罚软约束：在 7 人规模下它与
        // 「每天≥2 人夜班」互相冲突，硬卡死会导致整个班表无解。
        // 权重给得很高（仅次于硬违规），求解器仍极力避免，但必要时可让步。
        nightToDay: 900
    };

    // nightBias = 往期排班统计出来的「夜班占其出勤的比例」，仅作软目标让夜班分配延续习惯（不是硬规则）
    // 不再预置任何固定需求 / 隐藏偏好：每期的请假、必休、星期规律、班次偏好都以页面上输入的需求为准
    var DEFAULT_PEOPLE = [
        { en: 'kafewu', cn: '吴超', org: 'kafewu(吴超)', prefer: '', active: true, nightBias: 0.37, need: '' },
        { en: 'cuijunfang', cn: '崔俊芳', org: 'cuijunfang(崔俊芳)', prefer: '', active: false, nightBias: 0, need: '' },
        { en: 'nomadshi', cn: '石浩东', org: 'nomadshi (石浩东)', prefer: '', active: true, nightBias: 0.43, need: '' },
        { en: 'anweili', cn: '李安维', org: 'anweili(李安维)', prefer: '', active: true, nightBias: 0.50, need: '' },
        { en: 'hanleywang', cn: '王汉明', org: 'hanleywang(王汉明)', prefer: '', active: true, nightBias: 0.77, need: '' },
        { en: 'ventili', cn: '厉津睿', org: 'ventili(厉津睿)', prefer: '', active: true, nightBias: 0.62, need: '' },
        { en: 'zaklin', cn: '林国宇', org: 'zaklin(林国宇)', prefer: '', active: true, nightBias: 0.77, need: '' }
    ];
    // 旧版本预置给厉津睿 / 林国宇的需求文字；老存档里若还是这句原文，加载时清空一次（见 loadPeople）
    var OLD_DEFAULT_NEED = '周四周五白班，其余夜班';

    // 硬性要求：每天白班≥minDay、夜班≥minNight、同时上班≤maxStaff、每人出勤 targetDays±1、连班≤maxRun、
    //           小夜后次日不上白班（nightToDayHard=true 时）、请假/必休/指定班次。
    // 尽量满足：休息连休两天 —— 优先双休，实在排不开时允许单休，并在校验报告里逐条列出。
    var DEFAULT_RULES = { minDay: 2, minNight: 2, maxStaff: 5, maxRun: 6, targetDays: 21, nightToDayHard: true, v: 2 };

    // ═══════════ 日期工具 ═══════════
    // month = 周期结束月份（1-12），周期 = 上月21号 ~ 本月20号
    function periodDates(year, month) {
        var start = new Date(year, month - 2, 21);
        var end = new Date(year, month - 1, 20);
        var out = [], cur = new Date(start.getTime());
        while (cur.getTime() <= end.getTime()) {
            out.push(new Date(cur.getTime()));
            cur.setDate(cur.getDate() + 1);
        }
        return out;
    }
    function weekdayCn(d) { return ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][d.getDay()]; }
    function isWeekend(d) { var w = d.getDay(); return w === 0 || w === 6; }
    function dayNum(d) { return d.getDate(); }
    function keyOf(d) { return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); }

    // ═══════════ 需求解析 ═══════════
    // 支持 "24" / "10-24" / "2026-10-24"，分隔符 , ， ; ；空格
    function splitTokens(str) {
        if (!str) return [];
        return String(str).split(/[,，;；\s]+/).map(function (s) { return s.trim(); }).filter(function (s) { return s; });
    }
    function tokenToIndex(tok, dates) {
        var m = tok.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/);
        if (m) {
            var y = +m[1], mo = +m[2], dd = +m[3];
            for (var i = 0; i < dates.length; i++) {
                if (dates[i].getFullYear() === y && dates[i].getMonth() + 1 === mo && dates[i].getDate() === dd) return i;
            }
            return -1;
        }
        m = tok.match(/^(\d{1,2})[-\/](\d{1,2})$/);
        if (m) {
            var mo2 = +m[1], dd2 = +m[2];
            for (var j = 0; j < dates.length; j++) {
                if (dates[j].getMonth() + 1 === mo2 && dates[j].getDate() === dd2) return j;
            }
            return -1;
        }
        m = tok.match(/^(\d{1,2})$/);
        if (m) {
            var dd3 = +m[1];
            for (var k = 0; k < dates.length; k++) { if (dates[k].getDate() === dd3) return k; }
            return -1;
        }
        return -1;
    }
    // ═══════════ 需求文字解析 ═══════════
    // 每人一段自然语言需求，例：
    //   「24号年假，8、9号休，15号白班，周四周五白班，其余夜班，尽量少上夜班」
    var LEAVE_WORDS = ['年假', '病假', '事假', '产检假', '产假', '婚假', '丧假', '调休假', '育儿假', '陪产假'];
    var WD_MAP = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 7, '天': 7, '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7 };

    function dedup(arr) {
        var seen = {}, out = [];
        for (var i = 0; i < arr.length; i++) { if (!seen[arr[i]]) { seen[arr[i]] = 1; out.push(arr[i]); } }
        return out;
    }

    // ── 本期日期查找：dates 为本期日期数组（上月21 ~ 本月20，日号在周期内唯一） ──
    function findIdx(dates, y, mo, d) {
        for (var i = 0; i < dates.length; i++) {
            var x = dates[i];
            if (x.getDate() !== d) continue;
            if (mo != null && x.getMonth() + 1 !== mo) continue;
            if (y != null && x.getFullYear() !== y) continue;
            return i;
        }
        return -1;
    }
    // 「a~b 号」能否落在本期（允许跨月：25~3 号 = 本期 25 号到下月 3 号）
    function rangeIdx(dates, a, b) {
        var i = findIdx(dates, null, null, a), j = findIdx(dates, null, null, b);
        return (i >= 0 && j >= 0 && i <= j) ? [i, j] : null;
    }

    // 班次关键词 → off / day / night
    function shiftTypeOf(t) {
        t = String(t || '');
        if (/(夜|晚)/.test(t)) return 'night';
        if (/(白|早|正常)/.test(t)) return 'day';
        if (/(不休|不能休|不要休|别休|不许休|不准休)/.test(t)) return 'work';   // 「不休」= 必须上班，别当成休息
        if (/(休|不上班)/.test(t)) return 'off';
        if (/(上班|出勤|值班|在岗)/.test(t)) return 'work';
        return null;
    }
    // 把一句话切成若干组「星期列表 + 班次」：每组的班次取它后面、下一组星期之前的文字
    function parseWeekdayClauses(seg) {
        var s = String(seg).replace(/周末/g, '周六日').replace(/工作日/g, '周一至五')
            .replace(/(周|星期|礼拜)\s*([1-7])(?!\d)/g, function (_, a, b) { return a + '一二三四五六日'.charAt(+b - 1); });
        var regions = [], pos = 0;
        while (pos < s.length) {
            var idx = s.slice(pos).search(/(周|星期|礼拜)[一二三四五六日天]/);
            if (idx < 0) break;
            var st = pos + idx;
            var m = s.slice(st).match(/^[周星期礼拜一二三四五六日天、,，和与及\/到至~～—\-\s]+/);
            regions.push([st, st + m[0].length]);
            pos = st + m[0].length;
        }
        return regions.map(function (rg, i) {
            var end = i + 1 < regions.length ? regions[i + 1][0] : s.length;
            var tail = s.slice(rg[1], end), rest = null;
            var rm = tail.match(/(其余|其他|其它|剩下|剩余|别的)([\s\S]*)$/);
            if (rm) { rest = shiftTypeOf(rm[2]); tail = tail.slice(0, rm.index); }
            return {
                wds: parseWeekdayList(s.slice(rg[0], rg[1])), type: shiftTypeOf(tail),
                rest: (rest === 'day' || rest === 'night') ? rest : null, text: s.slice(rg[0], end).replace(/[、,，\s]+$/, '')
            };
        }).filter(function (c) { return c.wds.length; });
    }

    // 星期列表：周四周五 / 周四、五 / 周一到周五 / 周六日 / 周末 / 工作日 / 星期天 / 礼拜三 / 周1
    function parseWeekdayList(seg) {
        var s = String(seg).replace(/周末/g, '周六日').replace(/工作日/g, '周一至五')
            .replace(/(周|星期|礼拜)\s*([1-7])(?!\d)/g, function (_, a, b) { return a + '一二三四五六日'.charAt(+b - 1); });
        var start = s.search(/(周|星期|礼拜)[一二三四五六日天]/);
        if (start < 0) return [];
        var region = s.slice(start).match(/^[周星期礼拜一二三四五六日天、,，和与及\/到至~～—\-\s]+/);
        if (!region) return [];
        var body = region[0].replace(/星期|礼拜/g, '周');
        var out = [], prev = null, pendingRange = false, m, re = /([一二三四五六日天])|([到至~～—\-])/g;
        while ((m = re.exec(body))) {
            if (m[2]) { if (prev != null) pendingRange = true; continue; }
            var w = WD_MAP[m[1]];
            if (pendingRange && prev != null) {
                var x = prev;
                while (x !== w) { x = x % 7 + 1; out.push(x); }   // 周一到周五 → 2,3,4,5；周六到周一 → 7,1
                pendingRange = false;
            } else out.push(w);
            prev = w;
        }
        return dedup(out);
    }

    // 从一句话里抽出日期，返回 { days, invalid, notes }
    //   支持：24 / 24号 / 8、9号 / 8-9号 / 8到12号 / 25-3号（跨月）/ 11月25日 / 11月25日-27日 / 11/25 / 10-24（月-日）/ 2026-11-25
    //   传入 dates（本期日期）时，结果统一为本期内的「YYYY-M-D」；落不到本期的进 invalid，供页面提示
    function extractDays(seg, dates) {
        var res = { days: [], invalid: [], notes: [] };
        var s = String(seg).replace(/\d+(\.\d+)?\s*(天|次|人|小时|个)/g, ' ');   // 「2天」「3次」是数量，不是日期
        // 「a-b」后面不跟号/日：可能是「a月b日」也可能是「a~b号」，有本期日期时按能落到本期的那个理解
        s = s.replace(/(^|[^\d\/.年月\-])(\d{1,2})\s*-\s*(\d{1,2})(?![\d号日月])/g, function (all, pre, a, b) {
            var md = a + '月' + b + '日', rg = a + '到' + b + '号';
            if (!dates) return pre + (+a <= 12 && +b > 12 ? md : rg);
            var mdOk = findIdx(dates, null, +a, +b) >= 0, rgOk = rangeIdx(dates, +a, +b) !== null;
            if (mdOk && rgOk) res.notes.push('「' + a + '-' + b + '」按 ' + a + '月' + b + '日 理解，若指 ' + a + '~' + b + ' 号请写成「' + a + '-' + b + '号」');
            return pre + (mdOk || !rgOk ? md : rg);
        });
        var tokens = [], m;
        var re = /(\d{4})\s*[-\/.年]\s*(\d{1,2})\s*[-\/.月]\s*(\d{1,2})\s*[日号]?|(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?|(\d{1,2})\s*[\/.]\s*(\d{1,2})(?!\d)|(\d{3,})|(\d{1,2})\s*[日号]?|([~～至到—\-])/g;
        while ((m = re.exec(s))) {
            if (m[1]) tokens.push({ y: +m[1], mo: +m[2], d: +m[3], raw: m[0].trim() });
            else if (m[4]) tokens.push({ mo: +m[4], d: +m[5], raw: m[0].trim() });
            else if (m[6]) tokens.push({ mo: +m[6], d: +m[7], raw: m[0].trim() });
            else if (m[8]) tokens.push({ skip: true });
            else if (m[9]) tokens.push({ d: +m[9], raw: m[0].trim() });
            else tokens.push({ range: true });
        }
        var out = [];
        var idxOf = function (tk, fallbackMo) {
            if (!dates) return -1;
            var i = findIdx(dates, tk.y == null ? null : tk.y, tk.mo == null ? (fallbackMo == null ? null : fallbackMo) : tk.mo, tk.d);
            if (i < 0 && tk.mo == null && fallbackMo != null) i = findIdx(dates, null, null, tk.d);
            return i;
        };
        var plain = function (tk) { return tk.y ? tk.y + '-' + tk.mo + '-' + tk.d : (tk.mo ? tk.mo + '-' + tk.d : String(tk.d)); };
        for (var i = 0; i < tokens.length; i++) {
            var tk = tokens[i];
            if (tk.skip || tk.range) continue;
            var nx = tokens[i + 1], nx2 = tokens[i + 2];
            if (nx && nx.range && nx2 && !nx2.range && !nx2.skip) {
                // 区间：右端没写月份就沿用左端（11月25日-27日）
                if (dates) {
                    var L = idxOf(tk), R = idxOf(nx2, tk.mo);
                    if (L >= 0 && R >= L) { for (var k = L; k <= R; k++) out.push(keyOf(dates[k])); }
                    else res.invalid.push(tk.raw + '~' + nx2.raw + '（不在本期内）');
                } else if (tk.mo == null && nx2.mo == null) {
                    var a = tk.d, b = nx2.d, q;
                    if (a <= b) { for (q = a; q <= b; q++) out.push(String(q)); }
                    else { for (q = a; q <= 31; q++) out.push(String(q)); for (q = 1; q <= b; q++) out.push(String(q)); }
                } else { out.push(plain(tk)); out.push(plain(nx2)); }
                i += 2;
                continue;
            }
            if (dates) {
                var ix = idxOf(tk);
                if (ix >= 0) out.push(keyOf(dates[ix])); else res.invalid.push(tk.raw + '（不在本期内）');
            } else out.push(plain(tk));
        }
        res.days = dedup(out);
        return res;
    }

    // 天数要求：「上班20天」「出勤19天」「夜班最多10天」「白班至少8天」「尽量夜班不超过10天」
    var KIND_CN = { work: '上班', day: '白班', night: '夜班', total: '上班' };
    var OP_CN = { eq: '=', min: '≥', max: '≤' };
    var BAL_CN = { night: '夜班', day: '白班', weekend: '周末班', work: '出勤' };
    function countOfDays(s) {
        var m = String(s).match(/(上班|出勤|白班|夜班|小夜)\s*(至少|不少于|不低于|最少|最多|不超过|不多于|至多|尽量)?\s*(\d{1,2})\s*天/);
        if (!m) return null;
        var kind = /白班/.test(m[1]) ? 'day' : /夜班|小夜/.test(m[1]) ? 'night' : 'work';
        var w = m[2] || '';
        var op = /至少|不少于|不低于|最少/.test(w) ? 'min' : /最多|不超过|不多于|至多/.test(w) ? 'max' : 'eq';
        return { kind: kind, op: op, n: +m[3], soft: /尽量|最好|希望/.test(s) };
    }

    // ═══════════ 自定义需求（全局，叠加到现有规则上） ═══════════
    // 一段话，按换行 / 分号 / 句号切成若干条，每条可以是：
    //   ① 对全员生效：      「12月31日不休」「周末白班」「上班20天」
    //   ② 指定某人：        「吴超：12月1日-2日年假」「石浩东 尽量少上夜班」
    //   ③ 每日人数规则：    「每天白班至少3人」「12月31日夜班至少3人」「周末上班最多4人」
    // 返回 { global, byName, dayRules, invalid, notes }
    function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
    function keyToIdx(dates, key) {
        var m = String(key).match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
        if (!m) return -1;
        return findIdx(dates, +m[1], +m[2], +m[3]);
    }
    function mergeNeed(a, b) {
        if (!a) return b;
        if (!b) return a;
        var out = {};
        ['leave', 'off', 'fix', 'work', 'weekDay', 'weekNight', 'weekOff', 'weekWork', 'counts', 'balance', 'invalid', 'notes'].forEach(function (k) {
            out[k] = dedup((a[k] || []).concat(b[k] || []));
        });
        out.prefer = b.prefer || a.prefer || '';
        out.target = b.target || a.target || null;
        out.nightAll = !!(a.nightAll || b.nightAll);
        out.dayAll = !!(a.dayAll || b.dayAll);
        return out;
    }
    // 每日人数规则：「每天白班至少3人」「12月31日夜班至少3人」「周末上班最多4人」「工作日白班至少3人」
    function parseDayRule(cl, dates) {
        var m = String(cl).match(/(白班|夜班|小夜|上班|出勤|在岗)\s*(至少|不少于|不低于|最少|最多|不超过|不多于|至多)\s*(\d{1,2})\s*人/);
        if (!m) return null;
        var kind = /白班/.test(m[1]) ? 'day' : /夜班|小夜/.test(m[1]) ? 'night' : 'total';
        var op = /至少|不少于|不低于|最少/.test(m[2]) ? 'min' : 'max';
        var n = +m[3];
        var dayPart = String(cl).replace(m[0], ' ');
        var ex = extractDays(dayPart, dates);
        var idxs = ex.days.map(function (k) { return keyToIdx(dates, k); }).filter(function (i) { return i >= 0; });
        var scope = '';
        if (idxs.length) scope = 'days';
        else if (/周末|双休日|星期六日|周六日/.test(dayPart)) {
            scope = 'weekend';
            idxs = dates.map(function (d, i) { return isWeekend(d) ? i : -1; }).filter(function (i) { return i >= 0; });
        } else if (/工作日/.test(dayPart)) {
            scope = 'workday';
            idxs = dates.map(function (d, i) { return isWeekend(d) ? -1 : i; }).filter(function (i) { return i >= 0; });
        } else if (/(每天|每日|天天|全期|整个周期|所有日期)/.test(dayPart)) {
            scope = 'all';
            idxs = dates.map(function (_, i) { return i; });
        } else if (ex.invalid.length) {
            // 写了日期但落不到本期：不要退化成「全期」，直接报错
            return { rules: [], invalid: ex.invalid };
        } else {
            scope = 'all';
            idxs = dates.map(function (_, i) { return i; });
        }
        return { rules: [{ kind: kind, op: op, n: n, days: dedup(idxs), scope: scope, labels: dedup(idxs).map(function (i) { return (dates[i].getMonth() + 1) + '/' + dates[i].getDate(); }) }], invalid: ex.invalid };
    }
    function parseCustomNeed(text, dates, people) {
        var out = { global: null, byName: {}, dayRules: [], invalid: [], notes: [] };
        if (!text || !String(text).trim()) return out;
        var names = (people || []).map(function (p) { return { cn: p.cn, en: p.en }; });
        var clauses = String(text).split(/[\n\r；;。]+/).map(function (s) { return s.trim(); }).filter(function (s) { return s; });
        clauses.forEach(function (cl) {
            // ① 每日人数规则
            var dr = parseDayRule(cl, dates);
            if (dr) {
                out.dayRules = out.dayRules.concat(dr.rules);
                dr.invalid.forEach(function (x) { out.invalid.push(x); });
                return;
            }
            // ② 指定某人（中文名 / 英文名开头）
            var hit = null;
            for (var i = 0; i < names.length; i++) {
                var n = names[i];
                var re = new RegExp('^\\s*' + escapeRe(n.cn) + '\\s*[:：,，的]?\\s*');
                if (re.test(cl)) { hit = n.cn; cl = cl.replace(re, ''); break; }
                var re2 = new RegExp('^\\s*' + escapeRe(n.en) + '\\s*[:：,，的]?\\s*', 'i');
                if (re2.test(cl)) { hit = n.cn; cl = cl.replace(re2, ''); break; }
            }
            // ③ 去掉「全员 / 所有人 / 大家」这类前缀
            cl = cl.replace(/^\s*(全员|所有人|全体|大家|每个人|每人)\s*[:：,，]?\s*/, '');
            if (!cl) return;
            var n2 = parseNeedText(cl, dates);
            if (hit) out.byName[hit] = mergeNeed(out.byName[hit], n2);
            else out.global = mergeNeed(out.global, n2);
        });
        out.invalid = dedup(out.invalid);
        if (out.global) (out.global.invalid || []).forEach(function (x) { out.invalid.push('全员：' + x); });
        Object.keys(out.byName).forEach(function (k) {
            (out.byName[k].invalid || []).forEach(function (x) { out.invalid.push(k + '：' + x); });
        });
        out.invalid = dedup(out.invalid);
        return out;
    }
    // 把自定义需求翻译成人话，给页面即时核对
    function describeCustom(c) {
        if (!c) return '';
        var parts = [];
        if (c.global) parts.push('全员：' + describeNeed(c.global));
        Object.keys(c.byName || {}).forEach(function (k) { parts.push(k + '：' + describeNeed(c.byName[k])); });
        (c.dayRules || []).forEach(function (r) {
            var scope = r.scope === 'weekend' ? '周末' : r.scope === 'workday' ? '工作日' : r.scope === 'all' ? '每天'
                : (r.days.length > 6 ? '共 ' + r.days.length + ' 天' : (r.labels || []).join('、'));
            parts.push(scope + ' ' + KIND_CN[r.kind] + OP_CN[r.op] + r.n + '人');
        });
        if (c.invalid && c.invalid.length) parts.push('⚠ 未识别：' + c.invalid.join('；'));
        return parts.join(' · ');
    }

    // dates（可选）= 本期日期数组；传入后日期会落到本期具体某天，识别不了 / 不在本期的写进 invalid 提示用户
    function parseNeedText(text, dates) {
        var r = { leave: [], off: [], fix: [], work: [], weekDay: [], weekNight: [], weekOff: [], weekWork: [], prefer: '', target: null, counts: [], balance: [], nightAll: false, dayAll: false, invalid: [], notes: [] };
        if (!text) return r;
        var segs = String(text).split(/[,，。;；\n\r]+/);   // 顿号留给「8、9号休」「周四、五休」这种并列
        for (var i = 0; i < segs.length; i++) {
            var seg = segs[i].trim();
            if (!seg) continue;
            // 班次名里的数字（小夜班3 / 早班2）别当成日期
            var segN = seg.replace(/小夜班\s*3/g, '夜班').replace(/早班\s*2/g, '早班');

            // ①' 均衡类：「将夜班稍微平均一下」「夜班平均分配」「白班均衡一点」「周末班平均」
            // 必须放在星期分支之前，否则「周末班平均」会被当成「周末 + 班次」解析
            if (/(平均|均衡|均分|平摊|分摊|平衡|差不多|一样多)/.test(segN) && /(夜|白|班|周末|出勤)/.test(segN)) {
                // 出勤天数固定时，白班均衡与夜班均衡互为镜像，统一按夜班均衡处理
                var bk = /周末/.test(segN) ? 'weekend' : /夜|白|班|出勤/.test(segN) ? 'night' : 'work';
                r.balance = dedup((r.balance || []).concat([bk]));
                continue;
            }
            // ① 按星期的规律。一句里可以有多组，按「星期 + 后面的班次」逐组识别：
            //   「周六日白班、周一到周五小夜」「周六日白班周一到周五小夜」「周四周五白班其余夜班」「每周四、五休」「周末夜班」
            var clauses = /(周|星期|礼拜|工作日)/.test(segN) ? parseWeekdayClauses(segN) : [];
            if (clauses.length && !/\d/.test(segN.replace(/(周|星期|礼拜)\s*[1-7](?!\d)/g, ''))) {
                clauses.forEach(function (c) {
                    var ty = c.type || (clauses.length === 1 ? shiftTypeOf(segN.replace(/(其余|其他|其它|剩下|剩余|别的)[\s\S]*$/, '')) : null);
                    if (ty === 'off') r.weekOff = dedup(r.weekOff.concat(c.wds));
                    else if (ty === 'night') r.weekNight = dedup(r.weekNight.concat(c.wds));
                    else if (ty === 'day') r.weekDay = dedup(r.weekDay.concat(c.wds));
                    else if (ty === 'work') r.weekWork = dedup(r.weekWork.concat(c.wds));
                    else r.invalid.push(c.text + '（没写明是休息、白班还是夜班）');
                    if (c.rest === 'night') r.nightAll = true; else if (c.rest === 'day') r.dayAll = true;
                });
                continue;
            }
            // ② 「其余夜班 / 其余白班」
            if (/(其余|其他|其它|剩下|剩余|别的)/.test(segN) && /(白|夜|早|正常)/.test(segN)) {
                if (/夜/.test(segN)) r.nightAll = true; else r.dayAll = true;
                continue;
            }
            // ②' 天数要求：「上班20天」「出勤19天」「夜班最多10天」「白班至少8天」「尽量夜班不超过10天」
            var cntN = countOfDays(segN);
            if (cntN) {
                if (cntN.kind === 'work' && cntN.op === 'eq' && !cntN.soft) r.target = cntN.n;
                else r.counts.push(cntN);
                continue;
            }
            // ③ 偏好：「尽量少上夜班」「想上白班」
            if (/(想|希望|尽量|倾向|偏好|最好|优先|少上|多上|不想|避免)/.test(segN) && /(白|夜)/.test(segN)) {
                var neg = /少上|不想|避免|尽量不/.test(segN);
                var wantNight = /夜/.test(segN);
                if (neg) r.prefer = wantNight ? 'day' : 'night';       // 「少上夜班」= 偏白班
                else r.prefer = wantNight ? 'night' : (/白/.test(segN) ? 'day' : '');
                continue;
            }
            // ④ 日期 + 事项
            var type = '';
            for (var k = 0; k < LEAVE_WORDS.length; k++) { if (segN.indexOf(LEAVE_WORDS[k]) >= 0) { type = LEAVE_WORDS[k]; break; } }
            if (!type && /请假/.test(segN)) type = '事假';
            var ex = extractDays(segN, dates);
            r.invalid = r.invalid.concat(ex.invalid);
            r.notes = r.notes.concat(ex.notes);
            var days = ex.days;
            if (!days.length) {
                if (!ex.invalid.length) r.invalid.push(seg + (/\d/.test(segN) ? '（没认出日期）' : '（看不懂这句）'));
                continue;
            }
            if (type) { days.forEach(function (d) { r.leave.push(d + ':' + type); }); continue; }
            // 「12月31日不休」「25号上班」= 当天必须上班（白班夜班都行）；原来「不休」会被误判成休息
            if (/(不休|不能休|不要休|别休|不许休|不准休)/.test(segN) ||
                (/(上班|出勤|值班|在岗)/.test(segN) && !/不上班/.test(segN) && !/(白|夜|早|晚|正常)/.test(segN))) {
                r.work = dedup(r.work.concat(days)); continue;
            }
            if (/(休息|休|不上班)/.test(segN)) { r.off = dedup(r.off.concat(days)); continue; }
            if (/(夜班|小夜|夜|晚班)/.test(segN)) { days.forEach(function (d) { r.fix.push(d + ':小夜班3'); }); continue; }
            if (/(白班|早班|正常班|白)/.test(segN)) { days.forEach(function (d) { r.fix.push(d + ':白班'); }); continue; }
            r.invalid.push(seg + '（没写明是请假、休息、白班还是夜班）');
        }
        // 「其余夜班 / 其余白班」＝ 除已指定班次、已设为每周固定休息以外的所有星期
        var taken = function (w) { return r.weekDay.indexOf(w) >= 0 || r.weekNight.indexOf(w) >= 0 || r.weekOff.indexOf(w) >= 0 || r.weekWork.indexOf(w) >= 0; };
        var w2;
        if (r.nightAll) { for (w2 = 1; w2 <= 7; w2++) if (!taken(w2)) r.weekNight.push(w2); }
        if (r.dayAll) { for (w2 = 1; w2 <= 7; w2++) if (!taken(w2)) r.weekDay.push(w2); }
        r.leave = dedup(r.leave); r.fix = dedup(r.fix);
        r.invalid = dedup(r.invalid.concat(needConflicts(r))); r.notes = dedup(r.notes);
        return r;
    }

    // 同一天既请假/休息又指定班次（或要求上班）、同一星期设了两种安排 → 当场提示（排班时预检也会拦下）
    function needConflicts(r) {
        var out = [];
        var dk = function (s) { return String(s).split(':')[0]; };
        var offAt = {}, fixAt = {};
        r.leave.forEach(function (x) { offAt[dk(x)] = String(x).split(':')[1] || '请假'; });
        r.off.forEach(function (x) { if (!offAt[dk(x)]) offAt[dk(x)] = '休息'; });
        r.fix.forEach(function (x) {
            var k = dk(x), sh = String(x).split(':')[1] === '小夜班3' ? '夜班' : '白班';
            if (offAt[k]) out.push(fmtDayTok(k) + ' 同时填了' + offAt[k] + '和' + sh);
            else if (fixAt[k] && fixAt[k] !== sh) out.push(fmtDayTok(k) + ' 同时指定了白班和夜班');
            fixAt[k] = sh;
        });
        (r.work || []).forEach(function (k) { if (offAt[k]) out.push(fmtDayTok(k) + ' 同时填了' + offAt[k] + '和上班'); });
        var wkName = { weekOff: '休息', weekDay: '白班', weekNight: '夜班', weekWork: '上班' };
        [['weekOff', 'weekDay'], ['weekOff', 'weekNight'], ['weekDay', 'weekNight'], ['weekOff', 'weekWork']].forEach(function (pr) {
            var both = (r[pr[0]] || []).filter(function (w) { return (r[pr[1]] || []).indexOf(w) >= 0; });
            if (both.length) out.push('周' + both.map(cnWeek).join('') + ' 同时设成了' + wkName[pr[0]] + '和' + wkName[pr[1]]);
        });
        return out;
    }

    // 「2026-11-25」→「11/25」，「11-25」→「11/25」，「25」→「25号」
    function fmtDayTok(tok) {
        var m = String(tok).match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
        if (m) return (+m[2]) + '/' + (+m[3]);
        m = String(tok).match(/^(\d{1,2})-(\d{1,2})$/);
        return m ? (+m[1]) + '/' + (+m[2]) : tok + '号';
    }

    function cnWeek(n) { return ['', '一', '二', '三', '四', '五', '六', '日'][parseInt(n, 10)] || ''; }

    // 把解析结果翻译成人话，给用户输入时即时确认
    function describeNeed(n) {
        var fmt = fmtDayTok;
        var withType = function (s) { var p = String(s).split(':'); return fmt(p[0]) + (p[1] ? p[1].replace('小夜班3', '夜班') : ''); };
        var parts = [];
        if (n.leave.length) parts.push('假 ' + n.leave.map(withType).join('、'));
        if (n.off.length) parts.push('休 ' + n.off.map(fmt).join('、'));
        if (n.fix.length) parts.push('指定 ' + n.fix.map(withType).join('、'));
        if (n.work && n.work.length) parts.push('要上班 ' + n.work.map(fmt).join('、'));
        if (n.weekOff && n.weekOff.length) parts.push('每周' + n.weekOff.map(cnWeek).join('') + '休');
        if (n.weekWork && n.weekWork.length) parts.push('每周' + n.weekWork.map(cnWeek).join('') + '上班');
        if (n.weekDay.length) parts.push('周' + n.weekDay.map(cnWeek).join('') + '白班');
        if (n.weekNight.length) parts.push('周' + n.weekNight.map(cnWeek).join('') + '夜班');
        if (n.target) parts.push('上班 ' + n.target + ' 天');
        (n.counts || []).forEach(function (c) { parts.push(KIND_CN[c.kind] + OP_CN[c.op] + c.n + '天' + (c.soft ? '（尽量）' : '')); });
        if (n.prefer) parts.push(n.prefer === 'day' ? '偏白班' : '偏夜班');
        (n.balance || []).forEach(function (b) { parts.push(BAL_CN[b] + '平均分配'); });
        if (n.invalid && n.invalid.length) parts.push('⚠ 未识别：' + n.invalid.join('；'));
        if (n.notes && n.notes.length) parts.push('ℹ ' + n.notes.join('；'));
        return parts.join(' · ');
    }

    // 星期集合：用户输入 1=周一 … 7=周日，转成 JS getDay()（0=周日）
    function parseWeekdays(str) {
        var set = {};
        splitTokens(str).forEach(function (tok) {
            var n = parseInt(tok, 10);
            if (isNaN(n) || n < 1 || n > 7) return;
            set[n % 7] = 1;
        });
        return set;
    }
    // 条目形如 "24" 或 "24:年假"
    function parseEntries(str, dates, needValue) {
        var out = [];
        splitTokens(str).forEach(function (tok) {
            var parts = tok.split(/[:：]/);
            var idx = tokenToIndex(parts[0], dates);
            if (idx < 0) return;
            out.push({ idx: idx, value: needValue ? (parts[1] || '') : '' });
        });
        return out;
    }

    // 把用户输入编译成求解器输入
    // people: [{cn,en,org,prefer,target,leave,off,fix,weekDay,weekNight,weekOff}]  （active 已过滤）
    // opts.heuristic = true：给备用启发式算法用，额外加「派生必休」帮它降低难度（精确求解不需要）
    // opts.needNotes：需求解析阶段的提示，原样带进校验报告
    function buildInput(dates, people, rules, carry, opts) {
        opts = opts || {};
        var P = people.length, T = dates.length;
        var fixed = [], leaveName = [], targets = [], prefers = [], nightBias = [], conflicts = [], countReqs = [], balSet = [];
        var dn = function (i) { return (dates[i].getMonth() + 1) + '/' + dates[i].getDate(); };
        // 自定义需求（全局）：先解析，再按人合并到各自需求上
        var custom = opts.custom || null;
        var customNotes = [];
        if (custom) {
            (custom.invalid || []).forEach(function (x) { customNotes.push('自定义需求未识别：' + x); });
        }
        for (var p = 0; p < P; p++) {
            var fp = new Array(T).fill(FIX_FREE);
            var ln = new Array(T).fill('');
            var pe = people[p];
            // 个人需求 + 自定义需求里点名给这个人的部分 + 全员部分
            var need = parseNeedText(pe.need || '', dates);
            if (custom) {
                if (custom.byName && custom.byName[pe.cn]) need = mergeNeed(need, custom.byName[pe.cn]);
                if (custom.global) need = mergeNeed(need, custom.global);
            }
            var peEff = {
                cn: pe.cn, en: pe.en, org: pe.org,
                leave: need.leave.join(','), off: need.off.join(','), fix: need.fix.join(','),
                work: need.work.join(','),
                weekDay: need.weekDay.join(','), weekNight: need.weekNight.join(','),
                weekOff: need.weekOff.join(','), weekWork: need.weekWork.join(','),
                prefer: need.prefer || '', target: need.target || pe.target,
                counts: need.counts || [], balance: need.balance || []
            };
            parseEntries(peEff.leave, dates, true).forEach(function (e) {
                fp[e.idx] = FIX_LEAVE;
                ln[e.idx] = e.value || '事假';
            });
            // 必休不覆盖请假（否则请假类型会丢）
            parseEntries(peEff.off, dates, false).forEach(function (e) { if (fp[e.idx] !== FIX_LEAVE) fp[e.idx] = FIX_REST; });
            parseEntries(peEff.fix, dates, true).forEach(function (e) {
                var v = String(e.value || '').trim();
                var want = (v.indexOf('夜') >= 0) ? FIX_NIGHT : FIX_DAY;
                var cur = fp[e.idx];
                if (cur === FIX_LEAVE || cur === FIX_REST) {
                    conflicts.push(pe.cn + '：' + dn(e.idx) + ' 同时填了' + (cur === FIX_LEAVE ? ln[e.idx] : '休息') + '和' + (want === FIX_NIGHT ? '夜班' : '白班'));
                    return;
                }
                if (cur !== FIX_FREE && cur !== want) { conflicts.push(pe.cn + '：' + dn(e.idx) + ' 同时指定了白班和夜班'); return; }
                fp[e.idx] = want;
            });
            // 必须上班（白班夜班都行）：与请假/休息冲突时以请假/休息为准并报冲突
            parseEntries(peEff.work, dates, false).forEach(function (e) {
                var cur = fp[e.idx];
                if (cur === FIX_LEAVE || cur === FIX_REST) {
                    conflicts.push(pe.cn + '：' + dn(e.idx) + ' 同时填了' + (cur === FIX_LEAVE ? ln[e.idx] : '休息') + '和上班');
                    return;
                }
                if (cur === FIX_FREE) fp[e.idx] = FIX_WORK;
            });
            // 按星期的规律：每周固定休息（必休）> 上班日固定白/夜；具体日期的要求优先于星期规律
            var wdOff = parseWeekdays(peEff.weekOff), wdDay = parseWeekdays(peEff.weekDay), wdNight = parseWeekdays(peEff.weekNight);
            var wdWork = parseWeekdays(peEff.weekWork);
            for (var w = 0; w < T; w++) {
                if (fp[w] !== FIX_FREE) continue;
                var dow = dates[w].getDay();
                if (wdOff[dow]) fp[w] = FIX_REST;
                else if (wdDay[dow]) fp[w] = FIX_DAY_IF_WORK;
                else if (wdNight[dow]) fp[w] = FIX_NIGHT_IF_WORK;
                else if (wdWork[dow]) fp[w] = FIX_WORK;
            }
            if (opts.heuristic) {
                // 派生必休：某天固定白班，而前一天固定夜班 → 前一天只能休息（否则违反「小夜后不上白班」）
                for (var dv = 1; dv < T; dv++) {
                    if (fp[dv] === FIX_DAY_IF_WORK && fp[dv - 1] === FIX_NIGHT_IF_WORK) fp[dv - 1] = FIX_REST;
                }
                if (fp[0] === FIX_DAY_IF_WORK && carry && carry[p] && carry[p].length && carry[p][carry[p].length - 1] === 2) fp[0] = FIX_REST;
            }

            fixed.push(fp); leaveName.push(ln);
            targets.push(peEff.target || rules.targetDays);
            nightBias.push(typeof pe.nightBias === 'number' ? pe.nightBias : 0.5);
            prefers.push(peEff.prefer || '');
            (peEff.balance || []).forEach(function (b) { if (balSet.indexOf(b) < 0) balSet.push(b); });
            // 天数类要求（白班/夜班/上班 至少/最多 N 天）
            (peEff.counts || []).forEach(function (c) {
                if (c.kind === 'work' && c.op === 'eq' && !c.soft) return;   // 已作为 target
                countReqs.push({ p: p, kind: c.kind, op: c.op, n: c.n, soft: !!c.soft });
            });
        }
        // 依据往期的夜班倾向，给每人算一个目标夜班天数：
        // 先按各自比例分摊，再整体缩放到「每天最低夜班数 × 天数」的总量
        var totalWork = 0, biasSum = 0;
        for (var tb = 0; tb < P; tb++) {
            totalWork += targets[tb];
            biasSum += nightBias[tb] * targets[tb];
        }
        // 夜班总量：先给每天保底 minNight，剩余名额按各人夜班倾向加权分配。
        // 直接用 totalWork - minDay*T 会把夜班推到上限、白班贴死下限，
        // 导致个别天白班跌破 minDay —— 这里取居中目标，给白班留出余量。
        var minTotal = rules.minDay + rules.minNight;
        var biasRatio = totalWork > 0 ? biasSum / totalWork : 0.5;
        var totalNight = Math.max(rules.minNight * T,
            Math.min(totalWork - rules.minDay * T,
                Math.round(rules.minNight * T + (totalWork - minTotal * T) * biasRatio)));
        var scale = biasSum > 0 ? totalNight / biasSum : 0;
        var nightTarget = [];
        for (var tn = 0; tn < P; tn++) nightTarget.push(targets[tn] * nightBias[tn] * scale);
        // 自定义需求「夜班平均一下」：不再按往期习惯加权，改成每人等额分摊夜班总量
        if (balSet.indexOf('night') >= 0) {
            var perNight = totalNight / P;
            for (var bn = 0; bn < P; bn++) nightTarget[bn] = perNight;
        }

        return {
            dates: dates, people: people, rules: rules,
            nightTarget: nightTarget,
            fixed: fixed, leaveName: leaveName, targets: targets,
            prefers: prefers,
            weekend: dates.map(isWeekend),
            carry: carry || null,
            conflicts: conflicts,
            countReqs: countReqs,
            balance: balSet,
            dayRules: (custom && custom.dayRules) ? custom.dayRules : [],
            customNotes: customNotes,
            needNotes: opts.needNotes || []
        };
    }

    // ═══════════ 可行性预检 ═══════════
    // 能直接看出排不了的情况先拦下，并说清楚卡在哪天、哪条规则
    function precheck(input) {
        var T = input.dates.length, P = input.people.length;
        var rules = input.rules;
        var minTotal = rules.minDay + rules.minNight;
        var dn = function (i) { return (input.dates[i].getMonth() + 1) + '/' + input.dates[i].getDate(); };
        var fail = function (msg) { return { ok: false, reason: msg }; };
        if (input.conflicts && input.conflicts.length) {
            return fail('需求自相矛盾：' + input.conflicts.slice(0, 6).join('；') + (input.conflicts.length > 6 ? ' 等 ' + input.conflicts.length + ' 处' : ''));
        }
        if (P < minTotal) return fail('参与排班 ' + P + ' 人，少于每天最低白班 ' + rules.minDay + ' + 夜班 ' + rules.minNight + ' 人');
        if (minTotal > rules.maxStaff) return fail('每天最低白班 ' + rules.minDay + ' + 夜班 ' + rules.minNight + ' 人，已超过「最多同时上班 ' + rules.maxStaff + ' 人」');
        var sumMax = 0, sumMin = 0;
        for (var p = 0; p < P; p++) {
            var leaveCnt = 0, restCnt = 0;
            for (var d = 0; d < T; d++) {
                if (input.fixed[p][d] === FIX_LEAVE) leaveCnt++;
                if (input.fixed[p][d] === FIX_REST) restCnt++;
            }
            var tg = input.targets[p], avail = T - leaveCnt - restCnt;
            if (tg - 1 > avail) {
                return fail(input.people[p].cn + '：需上班 ' + tg + '±1 天，但请假 ' + leaveCnt + ' 天 + 必休 ' + restCnt + ' 天后只剩 ' + avail + ' 天可上班');
            }
            sumMax += Math.min(tg + 1, avail);
            sumMin += Math.max(0, tg - 1);
        }
        if (sumMax < minTotal * T) {
            return fail('全员最多能出勤 ' + sumMax + ' 人次，低于每天最低 ' + minTotal + ' 人 × ' + T + ' 天 = ' + minTotal * T + ' 人次，请减少请假/必休或下调每日最低人数');
        }
        // 自定义每日人数规则会抬高每日最低人数：按天累加后再和总出勤能力比
        var needTotal = 0, needDetail = [];
        for (var dt = 0; dt < T; dt++) {
            var eMin = minTotal, eMax = rules.maxStaff;
            (input.dayRules || []).forEach(function (r) {
                if (r.days.indexOf(dt) < 0) return;
                if (r.op === 'min') {
                    if (r.kind === 'day') eMin = Math.max(eMin, r.n + rules.minNight);
                    else if (r.kind === 'night') eMin = Math.max(eMin, r.n + rules.minDay);
                    else eMin = Math.max(eMin, r.n);
                } else if (r.kind === 'total') eMax = Math.min(eMax, r.n);
            });
            if (eMin > eMax) {
                needDetail.push(dn(dt) + ' 自定义要求每天至少 ' + eMin + ' 人上班，但最多只能 ' + eMax + ' 人');
            }
            needTotal += eMin;
        }
        if (needDetail.length) {
            return fail('自定义需求与现有规则冲突：' + needDetail.slice(0, 4).join('；') + (needDetail.length > 4 ? ' 等 ' + needDetail.length + ' 天' : ''));
        }
        if (sumMax < needTotal) {
            return fail('按自定义需求每天至少 ' + Math.round(needTotal / T) + ' 人上班，全期需 ' + needTotal + ' 人次，但全员最多只能出勤 ' + sumMax +
                ' 人次（每人 ' + rules.targetDays + '±1 天）。请下调每日人数要求，或调高「每人上班天数」');
        }
        if (sumMin > rules.maxStaff * T) {
            return fail('全员至少要出勤 ' + sumMin + ' 人次，超过每天最多 ' + rules.maxStaff + ' 人 × ' + T + ' 天 = ' + rules.maxStaff * T + ' 人次，请下调每人上班天数或调高同时上班上限');
        }
        // 逐日检查能上班 / 能上白班 / 能上夜班的人数（含上期衔接：上期末小夜的人首日不能白班、已连满的人首日不能上班）
        var bad = [];
        for (var t = 0; t < T; t++) {
            var all = 0, dCap = 0, nCap = 0, forced = 0;
            for (var q = 0; q < P; q++) {
                var f = input.fixed[q][t];
                if (f === FIX_REST || f === FIX_LEAVE) continue;
                if (f === FIX_DAY || f === FIX_NIGHT || f === FIX_WORK) forced++;   // 这天必须上班的人
                var c = (input.carry && input.carry[q]) || [];
                if (t === 0 && c.length) {
                    var run = 0; for (var i = c.length - 1; i >= 0 && c[i]; i--) run++;
                    if (run >= rules.maxRun) continue;
                }
                var canDay = !(f === FIX_NIGHT || f === FIX_NIGHT_IF_WORK);
                var canNight = !(f === FIX_DAY || f === FIX_DAY_IF_WORK);
                if (t === 0 && rules.nightToDayHard && c.length && c[c.length - 1] === NIGHT) canDay = false;
                if (!canDay && !canNight) continue;
                all++; if (canDay) dCap++; if (canNight) nCap++;
            }
            if (all < minTotal) bad.push(dn(t) + ' 只有 ' + all + ' 人能上班（每天至少 ' + minTotal + ' 人）');
            else if (dCap < rules.minDay) bad.push(dn(t) + ' 只有 ' + dCap + ' 人能上白班（至少 ' + rules.minDay + ' 人）');
            else if (nCap < rules.minNight) bad.push(dn(t) + ' 只有 ' + nCap + ' 人能上夜班（至少 ' + rules.minNight + ' 人）');
            if (forced > rules.maxStaff) bad.push(dn(t) + ' 有 ' + forced + ' 人被要求必须上班，超过「最多同时上班 ' + rules.maxStaff + ' 人」');
            // 自定义需求里的每日人数规则（叠加在全局规则之上）
            (input.dayRules || []).forEach(function (r) {
                if (r.days.indexOf(t) < 0) return;
                if (r.op === 'min') {
                    if (r.kind === 'day' && dCap < r.n) bad.push(dn(t) + ' 自定义要求白班≥' + r.n + ' 人，但只有 ' + dCap + ' 人能上白班');
                    if (r.kind === 'night' && nCap < r.n) bad.push(dn(t) + ' 自定义要求夜班≥' + r.n + ' 人，但只有 ' + nCap + ' 人能上夜班');
                    if (r.kind === 'total' && all < r.n) bad.push(dn(t) + ' 自定义要求上班≥' + r.n + ' 人，但只有 ' + all + ' 人能上班');
                } else {
                    if (r.kind === 'total' && r.n > rules.maxStaff) bad.push(dn(t) + ' 自定义要求上班≤' + r.n + ' 人，与「最多同时上班 ' + rules.maxStaff + ' 人」冲突');
                }
            });
        }
        if (bad.length) return fail('以下日期人手不够：' + bad.slice(0, 6).join('；') + (bad.length > 6 ? ' 等 ' + bad.length + ' 天' : '') + '。请调整这几天的请假/必休/指定班次');
        return { ok: true, total: sumMin, minTotal: minTotal };
    }

    // ═══════════ 精确求解（HiGHS 混合整数规划） ═══════════
    // 每人每天两个 0/1 变量 d(白班) n(夜班)，都为 0 = 休/假。
    // 硬性要求写成约束；为了「排不开时能说清卡在哪」，每条硬约束带一个罚分极高的松弛变量 ——
    // 解出来松弛变量全为 0 = 全部满足；不为 0 的就是无法满足的那条规则、那一天。
    // 「休息连休两天」按用户要求是「尽量满足」：罚分次之，排不开时允许单休并写进校验报告。
    var MIP = {
        HARD_W: 100000,   // 硬约束松弛罚分（任何软目标加起来都远小于它）
        SOLO_W: 1000,     // 孤立单休罚分（尽量满足）
        stage1Limit: 25,  // 第一阶段：只求满足硬约束 + 尽量双休（秒）
        stage2Limit: 8    // 第二阶段：在第一阶段结果基础上优化班型（秒）
    };
    // HiGHS 每次求解后 wasm 内存只增不减（实测单次 +100~250MB），连续排几次标签页就会被浏览器杀掉。
    // 所以每次排班都新开一个 Web Worker 求解，排完立即 terminate —— 内存整块释放，页面也不会卡死。
    // Node 环境（单元测试）用子进程做同样的事。
    function workerUrl() {
        if (typeof document === 'undefined') return '';
        var s = document.querySelector('script[src*="scheduler.js"]');
        return (s ? s.src.replace(/[^\/]*$/, '') : '') + 'highs-worker.js';
    }
    // 打开一个求解会话：返回 { run(lp, options) -> Promise<result>, close() }
    function openSolver() {
        if (typeof Worker !== 'undefined' && typeof document !== 'undefined') {
            var w;
            try { w = new Worker(workerUrl()); } catch (e) { return Promise.reject(e); }
            var seq = 0, pending = {}, dead = null;
            var failAll = function (err) {
                dead = err;
                Object.keys(pending).forEach(function (k) { pending[k].reject(err); delete pending[k]; });
            };
            w.onmessage = function (ev) {
                var m = ev.data || {}, cb = pending[m.id];
                if (!cb) return;
                delete pending[m.id];
                if (m.error) cb.reject(new Error(m.error)); else cb.resolve(m.result);
            };
            w.onerror = function (ev) { failAll(new Error('求解线程出错：' + ((ev && ev.message) || '未知错误'))); };
            return Promise.resolve({
                run: function (lp, options) {
                    if (dead) return Promise.reject(dead);
                    return new Promise(function (resolve, reject) {
                        var id = ++seq; pending[id] = { resolve: resolve, reject: reject };
                        w.postMessage({ id: id, lp: lp, options: options });
                    });
                },
                close: function () { try { w.terminate(); } catch (e) { } failAll(new Error('求解线程已关闭')); }
            });
        }
        if (typeof require === 'function' && typeof __dirname !== 'undefined') {
            var cp = require('child_process'), path = require('path');
            var child = cp.fork(path.join(__dirname, 'highs-worker.js'), [], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
            var seq2 = 0, pend = {};
            child.on('message', function (m) { var cb = pend[m.id]; if (!cb) return; delete pend[m.id]; if (m.error) cb.reject(new Error(m.error)); else cb.resolve(m.result); });
            child.on('exit', function (code) { Object.keys(pend).forEach(function (k) { pend[k].reject(new Error('求解进程退出 code=' + code)); delete pend[k]; }); });
            return Promise.resolve({
                run: function (lp, options) { return new Promise(function (resolve, reject) { var id = ++seq2; pend[id] = { resolve: resolve, reject: reject }; child.send({ id: id, lp: lp, options: options }); }); },
                close: function () { try { child.kill(); } catch (e) { } }
            });
        }
        return Promise.reject(new Error('当前环境不支持 Web Worker'));
    }
    // 兼容旧调用：预热检测 highs-worker.js / highs.wasm 是否可用（页面加载时调用一次）
    function loadHighs() {
        return openSolver().then(function (s) {
            return s.run('Minimize\n obj: x\nSubject To\n c0: x >= 0\nEnd\n', { output_flag: false }).then(function (r) { s.close(); return r; },
                function (e) { s.close(); throw e; });
        });
    }

    // 构建 CPLEX LP 文本。stage=1 只含硬约束 + 双休；stage=2 加上班型软目标与随机扰动（换个排法）
    function buildMip(input, stage, rand, hint) {
        var T = input.dates.length, P = input.people.length, R = input.rules;
        var obj = [], rows = [], bnd = [], bins = [], meta = {}, rc = 0;
        var dv = function (p, t) { return 'd_' + p + '_' + t; }, nv = function (p, t) { return 'n_' + p + '_' + t; };
        var term = function (c, v) { return (c < 0 ? '- ' + (-c) : '+ ' + c) + ' ' + v; };
        var row = function (terms, rel, rhs) { rows.push(' r' + (rc++) + ': ' + terms.join(' ') + ' ' + rel + ' ' + rhs); };
        var sl = function (name, w, info) { obj.push(term(w, name)); if (info) meta[name] = info; return name; };
        var work = function (p, t, c) { c = c || 1; return [term(c, dv(p, t)), term(c, nv(p, t))]; };
        var isLeave = function (p, t) { return input.fixed[p][t] === FIX_LEAVE; };
        var hardW = MIP.HARD_W, soloW = MIP.SOLO_W;
        var p, t, s, e;
        for (p = 0; p < P; p++) for (t = 0; t < T; t++) {
            bins.push(dv(p, t), nv(p, t));
            row([term(1, dv(p, t)), term(1, nv(p, t))], '<=', 1);
            var f = input.fixed[p][t];
            if (f === FIX_REST || f === FIX_LEAVE) { bnd.push(dv(p, t) + ' = 0', nv(p, t) + ' = 0'); }
            else if (f === FIX_DAY) row([term(1, dv(p, t)), term(1, sl('fx_' + p + '_' + t, hardW, { k: 'fix', p: p, t: t, v: '白班' }))], '>=', 1);
            else if (f === FIX_NIGHT) row([term(1, nv(p, t)), term(1, sl('fx_' + p + '_' + t, hardW, { k: 'fix', p: p, t: t, v: '夜班' }))], '>=', 1);
            else if (f === FIX_DAY_IF_WORK) row([term(1, nv(p, t)), term(-1, sl('fw_' + p + '_' + t, hardW, { k: 'week', p: p, t: t, v: '白班' }))], '<=', 0);
            else if (f === FIX_NIGHT_IF_WORK) row([term(1, dv(p, t)), term(-1, sl('fw_' + p + '_' + t, hardW, { k: 'week', p: p, t: t, v: '夜班' }))], '<=', 0);
            // 必须上班（白班夜班都行，但不能休）
            else if (f === FIX_WORK) row(work(p, t).concat([term(1, sl('wk_' + p + '_' + t, hardW, { k: 'mustWork', p: p, t: t }))]), '>=', 1);
            if (stage === 2) {
                // 随机扰动：每次「生成 / 换个排法」都会得到不同但同样合规的方案
                obj.push(term(+(rand() * 0.8).toFixed(4), dv(p, t)), term(+(rand() * 0.8).toFixed(4), nv(p, t)));
                // 贴近第一阶段结果（轻微），保证第二阶段在有限时间内不退化
                if (hint) {
                    var hv = hint[p][t];
                    if (hv === DAY) obj.push(term(-0.5, dv(p, t))); else if (hv === NIGHT) obj.push(term(-0.5, nv(p, t)));
                }
            }
        }
        for (t = 0; t < T; t++) {
            var D = [], N = [], A = [];
            for (p = 0; p < P; p++) { D.push(term(1, dv(p, t))); N.push(term(1, nv(p, t))); A = A.concat(work(p, t)); }
            row(D.concat([term(1, sl('sD_' + t, hardW, { k: 'minDay', t: t }))]), '>=', R.minDay);
            row(N.concat([term(1, sl('sN_' + t, hardW, { k: 'minNight', t: t }))]), '>=', R.minNight);
            row(A.concat([term(-1, sl('sM_' + t, hardW, { k: 'maxStaff', t: t }))]), '<=', R.maxStaff);
            // 自定义需求里的每日人数规则（叠加在全局规则之上）
            (input.dayRules || []).forEach(function (dr, di) {
                if (dr.days.indexOf(t) < 0) return;
                var info = { k: 'dayRule', t: t, kind: dr.kind, op: dr.op, n: dr.n };
                if (dr.op === 'min') {
                    var terms = dr.kind === 'day' ? D : dr.kind === 'night' ? N : A;
                    row(terms.concat([term(1, sl('cd_' + di + '_' + t, hardW, info))]), '>=', dr.n);
                } else {
                    var terms2 = dr.kind === 'day' ? D : dr.kind === 'night' ? N : A;
                    row(terms2.concat([term(-1, sl('cd_' + di + '_' + t, hardW, info))]), '<=', dr.n);
                }
            });
        }
        for (p = 0; p < P; p++) {
            var tg = input.targets[p], WK = [];
            for (t = 0; t < T; t++) WK = WK.concat(work(p, t));
            row(WK.concat([term(1, sl('wL_' + p, hardW, { k: 'workLow', p: p }))]), '>=', tg - 1);
            row(WK.concat([term(-1, sl('wH_' + p, hardW, { k: 'workHigh', p: p }))]), '<=', tg + 1);
            var c = (input.carry && input.carry[p]) || [];
            var run = 0; for (var ci = c.length - 1; ci >= 0 && c[ci]; ci--) run++;
            // 连班上限：任意连续 maxRun+1 天至少休 1 天（上期尾段已连 run 天的，从首日起算）
            for (s = 0; s + R.maxRun < T; s++) {
                e = []; for (t = s; t <= s + R.maxRun; t++) e = e.concat(work(p, t));
                row(e.concat([term(-1, sl('rn_' + p + '_' + s, hardW, { k: 'maxRun', p: p, t: s }))]), '<=', R.maxRun);
            }
            if (run > 0) {
                var lim = Math.max(0, R.maxRun - run);
                e = []; for (t = 0; t <= lim && t < T; t++) e = e.concat(work(p, t));
                row(e.concat([term(-1, sl('rc_' + p, hardW, { k: 'maxRunCarry', p: p, run: run }))]), '<=', lim);
            }
            // 小夜后次日不上白班（含上期末小夜 → 本期首日）
            var n2dW = R.nightToDayHard ? hardW : W.nightToDay;
            for (t = 0; t + 1 < T; t++) row([term(1, nv(p, t)), term(1, dv(p, t + 1)), term(-1, sl('nd_' + p + '_' + t, n2dW, { k: 'n2d', p: p, t: t, hard: !!R.nightToDayHard }))], '<=', 1);
            if (c.length && c[c.length - 1] === NIGHT) row([term(1, dv(p, 0)), term(-1, sl('ndc_' + p, n2dW, { k: 'n2dCarry', p: p, hard: !!R.nightToDayHard }))], '<=', 0);
            // 休息尽量连休两天：休息日 t 的前一天或后一天至少有一天也在休（请假日不算单休、可以当双休的另一半）
            for (t = 0; t < T; t++) {
                if (isLeave(p, t)) continue;
                var left = t > 0 ? work(p, t - 1) : null, right = t + 1 < T ? work(p, t + 1) : null;
                var leftOff = t === 0 ? (c.length ? c[c.length - 1] === OFF : null) : undefined;
                if (t === 0 && leftOff === null) continue;           // 无上期衔接：首日不判
                if (t === T - 1) continue;                            // 期末最后一天由下期衔接时再判
                var tm = [term(-1, dv(p, t)), term(-1, nv(p, t))];
                var rhs = 0;
                if (t === 0) {
                    if (leftOff) continue;                            // 上期末已在休，首日休 = 连休
                    tm = tm.concat(right);                            // 首日休 → 次日也得休
                    rhs = 0;
                } else {
                    tm = tm.concat(left, right); rhs = 1;             // 休(=1-w_t) ⇒ w_{t-1}+w_{t+1} ≤ 1
                }
                row(tm.concat([term(-1, sl('so_' + p + '_' + t, soloW, { k: 'solo', p: p, t: t }))]), '<=', rhs);
            }
            // 上期最后一天是单休（前一天在上班）→ 本期首日补成连休
            if (c.length >= 2 && c[c.length - 1] === OFF && c[c.length - 2] !== OFF && !isLeave(p, 0)) {
                row(work(p, 0).concat([term(-1, sl('sc_' + p, soloW, { k: 'soloCarry', p: p }))]), '<=', 0);
            }
            // 天数类要求（白班/夜班/上班 至少/最多 N 天）：硬性要求，排不开时进校验报告
            (input.countReqs || []).forEach(function (cr, ci) {
                if (cr.p !== p) return;
                var terms = [];
                for (var ct = 0; ct < T; ct++) {
                    if (cr.kind === 'day') terms.push(term(1, dv(p, ct)));
                    else if (cr.kind === 'night') terms.push(term(1, nv(p, ct)));
                    else terms = terms.concat(work(p, ct));
                }
                var info = { k: 'count', p: p, kind: cr.kind, op: cr.op, n: cr.n, soft: cr.soft };
                var wgt = cr.soft ? W.prefer * 4 : hardW;
                if (cr.op === 'min') row(terms.concat([term(1, sl('cq_' + ci, wgt, info))]), '>=', cr.n);
                else if (cr.op === 'max') row(terms.concat([term(-1, sl('cq_' + ci, wgt, info))]), '<=', cr.n);
                else row(terms.concat([term(-1, sl('cqL_' + ci, wgt, info)), term(1, sl('cqH_' + ci, wgt, info))]), '=', cr.n);
            });
            // 自定义需求「夜班平均一下」：每人夜班数限制在均值 ±1 天内（排不开时进校验报告）
            if ((input.balance || []).indexOf('night') >= 0) {
                var NB = []; for (t = 0; t < T; t++) NB.push(term(1, nv(p, t)));
                var avgN = input.nightTarget[p] || 0;
                var loN = Math.max(0, Math.floor(avgN) - 1), hiN = Math.ceil(avgN) + 1;
                row(NB.concat([term(1, sl('nbL_' + p, hardW, { k: 'balNight', p: p, lo: loN, hi: hiN }))]), '>=', loN);
                row(NB.concat([term(-1, sl('nbH_' + p, hardW, { k: 'balNight', p: p, lo: loN, hi: hiN }))]), '<=', hiN);
            }
            if (stage === 2) {
                // ── 班型软目标（与原算法口径一致） ──
                // 连休 3 天以上轻罚
                for (t = 1; t + 1 < T; t++) {
                    if (isLeave(p, t - 1) || isLeave(p, t) || isLeave(p, t + 1)) continue;
                    row(work(p, t - 1).concat(work(p, t), work(p, t + 1), [term(1, sl('lr_' + p + '_' + t, W.longRest))]), '>=', 1);
                }
                // 连上满 maxRun 天轻罚
                for (s = 0; s + R.maxRun <= T; s++) {
                    e = []; for (t = s; t < s + R.maxRun; t++) e = e.concat(work(p, t));
                    row(e.concat([term(-1, sl('r6_' + p + '_' + s, W.run6))]), '<=', R.maxRun - 1);
                }
                // 白 → 夜 切换轻罚（夜 → 白 已是硬约束）
                for (t = 0; t + 1 < T; t++) row([term(1, dv(p, t)), term(1, nv(p, t + 1)), term(-1, sl('sw_' + p + '_' + t, W.sw))], '<=', 1);
                // 班次偏好
                var pref = input.prefers[p];
                for (t = 0; t < T; t++) { if (pref === 'day') obj.push(term(W.prefer, nv(p, t))); else if (pref === 'night') obj.push(term(W.prefer, dv(p, t))); }
                // 出勤贴近目标天数
                row(WK.concat([term(-1, sl('dP_' + p, 30)), term(1, sl('dM_' + p, 30))]), '=', tg);
                // 夜班数贴近往期习惯
                if (input.nightTarget && input.nightTarget[p]) {
                    var NN = []; for (t = 0; t < T; t++) NN.push(term(1, nv(p, t)));
                    row(NN.concat([term(-1, sl('nP_' + p, W.nightBias)), term(1, sl('nM_' + p, W.nightBias))]), '=', input.nightTarget[p].toFixed(3));
                }
                // 周末班均衡
                var WE = []; for (t = 0; t < T; t++) if (input.weekend[t]) WE = WE.concat(work(p, t));
                if (WE.length) { row(WE.concat([term(-1, 'wemax')]), '<=', 0); row(WE.concat([term(-1, 'wemin')]), '>=', 0); }
            }
        }
        if (stage === 2) obj.push(term(W.weekendBal, 'wemax'), term(-W.weekendBal, 'wemin'));
        var wrap = function (arr) { var o = []; for (var i = 0; i < arr.length; i += 12) o.push(arr.slice(i, i + 12).join(' ')); return o.join('\n   '); };
        var lp = 'Minimize\n obj: ' + (obj.length ? wrap(obj) : '0 ' + dv(0, 0)) + '\nSubject To\n' +
            rows.map(function (r) {
                var m = r.match(/^ (r\d+): (.*) (<=|>=|=) (\S+)$/);
                return ' ' + m[1] + ': ' + wrap(m[2].split(/ (?=[+-] )/)) + ' ' + m[3] + ' ' + m[4];
            }).join('\n') +
            '\nBounds\n' + bnd.map(function (b) { return ' ' + b; }).join('\n') + (stage === 2 ? '\n wemin free' : '') +
            '\nBinary\n ' + wrap(bins) + '\nEnd\n';
        return { lp: lp, meta: meta };
    }

    // 把 HiGHS 结果还原成班表矩阵 a[p][t]：0 休 / 1 白 / 2 夜
    function readMip(input, res) {
        var T = input.dates.length, P = input.people.length, a = [];
        var val = function (n) { var c = res.Columns[n]; return c ? c.Primal : 0; };
        for (var p = 0; p < P; p++) {
            var r = [];
            for (var t = 0; t < T; t++) r.push(val('d_' + p + '_' + t) > 0.5 ? DAY : (val('n_' + p + '_' + t) > 0.5 ? NIGHT : OFF));
            a.push(r);
        }
        return a;
    }

    // 松弛变量 → 人话：卡在哪天、哪条规则
    function explainMip(input, res, meta) {
        var hard = [], solo = [];
        var dn = function (t) { return (input.dates[t].getMonth() + 1) + '/' + input.dates[t].getDate(); };
        var nm = function (p) { return input.people[p].cn; };
        var R = input.rules;
        Object.keys(meta).forEach(function (k) {
            var c = res.Columns[k]; if (!c || c.Primal < 0.5) return;
            var m = meta[k], amt = Math.round(c.Primal);
            switch (m.k) {
                case 'minDay': hard.push(dn(m.t) + ' 白班差 ' + amt + ' 人（至少 ' + R.minDay + ' 人）'); break;
                case 'minNight': hard.push(dn(m.t) + ' 夜班差 ' + amt + ' 人（至少 ' + R.minNight + ' 人）'); break;
                case 'maxStaff': hard.push(dn(m.t) + ' 上班人数超出上限 ' + amt + ' 人（最多 ' + R.maxStaff + ' 人）'); break;
                case 'workLow': hard.push(nm(m.p) + ' 出勤比目标少 ' + amt + ' 天以上（目标 ' + input.targets[m.p] + '±1）'); break;
                case 'workHigh': hard.push(nm(m.p) + ' 出勤比目标多 ' + amt + ' 天以上（目标 ' + input.targets[m.p] + '±1）'); break;
                case 'maxRun': hard.push(nm(m.p) + ' ' + dn(m.t) + ' 起连班超过 ' + R.maxRun + ' 天'); break;
                case 'maxRunCarry': hard.push(nm(m.p) + ' 上期末已连上 ' + m.run + ' 天，接到本期后连班超过 ' + R.maxRun + ' 天'); break;
                case 'n2d': if (m.hard) hard.push(nm(m.p) + ' ' + dn(m.t) + ' 小夜 → 次日白班'); break;
                case 'n2dCarry': if (m.hard) hard.push(nm(m.p) + ' 上期末小夜 → ' + dn(0) + ' 白班'); break;
                case 'fix': hard.push(nm(m.p) + ' ' + dn(m.t) + ' 未能按要求上' + m.v); break;
                case 'mustWork': hard.push(nm(m.p) + ' ' + dn(m.t) + ' 要求上班，但被排成休息'); break;
                case 'dayRule': hard.push(dn(m.t) + ' 自定义要求' + KIND_CN[m.kind] + OP_CN[m.op] + m.n + '人，实际差 ' + amt + ' 人'); break;
                case 'count': hard.push(nm(m.p) + ' 自定义要求' + KIND_CN[m.kind] + OP_CN[m.op] + m.n + '天，实际差 ' + amt + ' 天'); break;
                case 'balNight': hard.push(nm(m.p) + ' 夜班未能平均（要求 ' + m.lo + '~' + m.hi + ' 天）'); break;
                case 'week': hard.push(nm(m.p) + ' ' + dn(m.t) + '（周' + '日一二三四五六'.charAt(input.dates[m.t].getDay()) + '）应上' + m.v); break;
                case 'solo': solo.push(nm(m.p) + ' ' + dn(m.t)); break;
                case 'soloCarry': solo.push(nm(m.p) + ' 上期末单休，' + dn(0) + ' 未能补休'); break;
            }
        });
        return { hard: hard, solo: solo };
    }

    // 异步精确求解。返回 { ok, a, reason, engine, hardIssues, soloIssues, status, ms }
    function solveExact(input, opts) {
        opts = opts || {};
        var chk = precheck(input);
        if (!chk.ok) return Promise.resolve({ ok: false, reason: chk.reason, engine: 'precheck' });
        var seed = opts.seed != null ? opts.seed : Math.floor(Math.random() * 1e6);
        var rand = makeRand(seed + 1);
        var lim1 = opts.stage1Limit || MIP.stage1Limit, lim2 = opts.stage2Limit != null ? opts.stage2Limit : MIP.stage2Limit;
        var t0 = Date.now();
        return openSolver().then(function (solver) {
            var done = function (v) { solver.close(); return v; };
            var fail = function (e) { solver.close(); throw e; };
            // 第一阶段：硬约束 + 尽量双休（mip_abs_gap 宽松：找到「全部满足」的解即可停）
            var m1 = buildMip(input, 1, rand);
            return solver.run(m1.lp, { output_flag: false, time_limit: lim1, mip_abs_gap: MIP.SOLO_W * 0.9, random_seed: seed % 2147483647 }).then(function (r1) {
                if (!r1 || !r1.Columns || !Object.keys(r1.Columns).length) throw new Error('求解器未返回结果（' + (r1 && r1.Status) + '）');
                var a = readMip(input, r1), ex = explainMip(input, r1, m1.meta), status = r1.Status;
                var finish = function () {
                    return {
                        ok: ex.hard.length === 0, a: a, engine: 'highs', status: status, ms: Date.now() - t0,
                        hardIssues: ex.hard, soloIssues: ex.solo,
                        reason: ex.hard.length ? '以下要求无法同时满足：' + ex.hard.slice(0, 8).join('；') + (ex.hard.length > 8 ? ' 等 ' + ex.hard.length + ' 项' : '') : ''
                    };
                };
                if (ex.hard.length || lim2 <= 0) return finish();
                // 第二阶段：在全部满足的前提下优化班型（单休数不允许变多）；失败就用第一阶段结果
                var m2 = buildMip(input, 2, rand, a);
                return solver.run(m2.lp, { output_flag: false, time_limit: lim2, mip_rel_gap: 0.02, random_seed: (seed * 7 + 3) % 2147483647 }).then(function (r2) {
                    if (r2 && r2.Columns && Object.keys(r2.Columns).length) {
                        var ex2 = explainMip(input, r2, m2.meta);
                        if (!ex2.hard.length && ex2.solo.length <= ex.solo.length) { a = readMip(input, r2); ex = ex2; status = r2.Status; }
                    }
                    return finish();
                }, function () { return finish(); });
            }).then(done, fail);
        });
    }

    // ═══════════ 求解器（备用：启发式，HiGHS 加载失败时使用） ═══════════
    function makeRand(seed) {
        var s = seed || 12345;
        return function () { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    }

    function State(input, rand) {
        this.in = input;
        this.T = input.dates.length;
        this.P = input.people.length;
        this.rules = input.rules;
        this.minDay = this.rules.minDay; this.minNight = this.rules.minNight;
        this.maxStaff = this.rules.maxStaff; this.maxRun = this.rules.maxRun;
        this.minTotal = this.minDay + this.minNight;
        this.rand = rand;
        this.a = [];
        for (var p = 0; p < this.P; p++) this.a.push(new Array(this.T).fill(OFF));
        // 上期衔接
        this.runBefore = []; this.prevNight = []; this.prevOff = [];
        for (var q = 0; q < this.P; q++) {
            var pv = (input.carry && input.carry[q]) ? input.carry[q] : [];
            var run = 0;
            for (var i = pv.length - 1; i >= 0; i--) { if (pv[i]) run++; else break; }
            this.runBefore.push(run);
            this.prevNight.push(pv.length ? pv[pv.length - 1] === NIGHT : false);
            this.prevOff.push(pv.length ? pv[pv.length - 1] === OFF : true);
        }
        this.pc = new Array(this.P).fill(0);
        this.dc = new Array(this.T).fill(0);
        this.nightCnt = new Array(this.P).fill(0);
        this.weCnt = new Array(this.P).fill(0);
        // 禁忌表：刚改过的格子短时间内不许改回，防止修复器来回震荡
        this.tabu = [];
        for (var t = 0; t < this.P; t++) this.tabu.push(new Array(this.T).fill(0));
        this.step = 0;
        this.tabuLen = 6;
    }

    // 改格子并记录禁忌
    State.prototype.setCell = function (p, d, v) {
        this.a[p][d] = v;
        this.tabu[p][d] = this.step + this.tabuLen;
    };
    State.prototype.free = function (p, d) { return this.step >= this.tabu[p][d]; };

    // 锁定格（不可改动）：必休 / 请假 / 指定班次。
    // 5、6（上班时固定白/夜）不算锁定——仍可把那天改成休息，只是上班时必须是指定的班次
    State.prototype.isLocked = function (p, d) {
        var f = this.in.fixed[p][d];
        return f >= FIX_REST && f <= FIX_LEAVE;
    };

    State.prototype.applyFixed = function () {
        for (var p = 0; p < this.P; p++) {
            for (var d = 0; d < this.T; d++) {
                var f = this.in.fixed[p][d];
                if (f === FIX_REST || f === FIX_LEAVE) this.a[p][d] = OFF;
                else if (f === FIX_DAY) this.a[p][d] = DAY;
                else if (f === FIX_NIGHT) this.a[p][d] = NIGHT;
                else if (f === FIX_WORK && this.a[p][d] === OFF) this.a[p][d] = DAY;
            }
        }
    };

    State.prototype.personCost = function (p) {
        var a = this.a[p], T = this.T, hard = 0, soft = 0, work = 0, night = 0, we = 0;
        for (var i = 0; i < T; i++) {
            var v = a[i];
            if (v) {
                work++;
                if (v === NIGHT) night++;
                if (this.in.weekend[i]) we++;
            }
        }
        // 出勤天数：允许 ±1 天浮动（软惩罚），超出的才算硬违规 ——
        // 硬卡死在 21 天会把「必须双休」逼成无解，留一点弹性换取休息成双
        var diff = work - this.in.targets[p];
        if (Math.abs(diff) > 1) hard += (Math.abs(diff) - 1) * HARD;
        soft += Math.abs(diff) * 30;
        // 连班（跨周期衔接）
        var run = this.runBefore[p];
        for (var k = 0; k < T; k++) {
            if (a[k]) {
                run++;
                if (run > this.maxRun) hard += HARD;
                else if (run === this.maxRun) soft += W.run6;
            } else run = 0;
        }
        // 小夜 → 次日不能白班（默认重罚软约束；rules.nightToDayHard=true 时恢复硬约束）
        var n2dHard = !!(this.in.rules && this.in.rules.nightToDayHard);
        if (this.prevNight[p] && a[0] === DAY) { if (n2dHard) hard += HARD; else soft += W.nightToDay; }
        for (var j = 1; j < T; j++) {
            if (a[j - 1] === NIGHT && a[j] === DAY) { if (n2dHard) hard += HARD; else soft += W.nightToDay; }
        }
        // 按星期固定班次（上班日必须是指定的白/夜）—— 这是明确的个人要求，违约代价给得更高
        for (var wf = 0; wf < T; wf++) {
            var fw = this.in.fixed[p][wf];
            if (fw === FIX_DAY_IF_WORK && a[wf] === NIGHT) hard += HARD * 3;
            else if (fw === FIX_NIGHT_IF_WORK && a[wf] === DAY) hard += HARD * 3;
            else if (fw === FIX_WORK && a[wf] === OFF) hard += HARD * 3;   // 必须上班却排了休息
        }
        // 工作段：长度贴近 5，且段内白夜混合（5 天段理想 3白2夜），整段全夜重罚
        var i0 = 0;
        while (i0 < T) {
            if (!a[i0]) { i0++; continue; }
            var s0 = i0, segNight = 0;
            while (i0 < T && a[i0]) { if (a[i0] === NIGHT) segNight++; i0++; }
            if (s0 > 0 && i0 < T) {
                var segLen = i0 - s0;
                soft += Math.abs(segLen - 5) * W.segLen;
                if (segNight === segLen) soft += W.allNight;
                else if (segNight === 0) soft += W.allDay;
                soft += Math.abs(segNight - Math.round(segLen * 2 / 5)) * W.segMix;
            }
        }
        // 休息形态：孤立单休 = 硬约束（必须双休）；连续休 3 天以上只是轻微扣分
        for (var m = 0; m < T; m++) {
            if (a[m] !== OFF) continue;
            if (this.in.fixed[p][m] === FIX_LEAVE) continue; // 请假日不参与双休判定（与 validate 口径一致）
            var left = m > 0 ? (a[m - 1] === OFF ? 1 : 0) : (this.prevOff[p] ? 1 : 0);
            var right = m < T - 1 ? (a[m + 1] === OFF ? 1 : 0) : 1; // 周期边界不算孤立
            if (!left && !right) hard += HARD;
            else if (left && right) soft += W.longRest;
        }
        // 班次偏好 + 往期夜班习惯（让夜班分配延续每个人的历史比例）
        var pref = this.in.prefers[p];
        if (pref === 'day') soft += night * W.prefer;
        else if (pref === 'night') soft += (work - night) * W.prefer;
        var nt = this.in.nightTarget ? this.in.nightTarget[p] : 0;
        if (nt) {
            if ((this.in.balance || []).indexOf('night') >= 0) {
                var loB = Math.max(0, Math.floor(nt) - 1), hiB = Math.ceil(nt) + 1;
                if (night < loB) hard += (loB - night) * HARD;
                if (night > hiB) hard += (night - hiB) * HARD;
            } else soft += Math.abs(night - nt) * W.nightBias;
        }
        // 白/夜来回切换
        for (var n = 0; n < T - 1; n++) { if (a[n] && a[n + 1] && a[n] !== a[n + 1]) soft += W.sw; }

        this.nightCnt[p] = night; this.weCnt[p] = we;
        return hard + soft;
    };

    State.prototype.dayCost = function (d) {
        var day = 0, night = 0;
        for (var p = 0; p < this.P; p++) {
            var v = this.a[p][d];
            if (v === DAY) day++; else if (v === NIGHT) night++;
        }
        var tot = day + night, hard = 0;
        if (tot < this.minTotal) hard += (this.minTotal - tot) * HARD;
        if (tot > this.maxStaff) hard += (tot - this.maxStaff) * HARD;
        if (day < this.minDay) hard += (this.minDay - day) * HARD;
        if (night < this.minNight) hard += (this.minNight - night) * HARD;
        // 自定义需求里的每日人数规则
        var drs = this.in.dayRules || [];
        for (var i = 0; i < drs.length; i++) {
            var r = drs[i];
            if (r.days.indexOf(d) < 0) continue;
            var act = r.kind === 'day' ? day : r.kind === 'night' ? night : tot;
            if (r.op === 'min' && act < r.n) hard += (r.n - act) * HARD;
            if (r.op === 'max' && act > r.n) hard += (act - r.n) * HARD;
        }
        return hard;
    };

    State.prototype.balanceCost = function () {
        var wmx = -Infinity, wmn = Infinity;
        for (var p = 0; p < this.P; p++) {
            if (this.weCnt[p] > wmx) wmx = this.weCnt[p];
            if (this.weCnt[p] < wmn) wmn = this.weCnt[p];
        }
        return (wmx - wmn) * W.weekendBal;
    };

    State.prototype.refresh = function () {
        for (var p = 0; p < this.P; p++) this.pc[p] = this.personCost(p);
        for (var d = 0; d < this.T; d++) this.dc[d] = this.dayCost(d);
    };

    State.prototype.score = function () {
        var hard = 0, soft = 0, s = 0;
        for (var p = 0; p < this.P; p++) s += this.pc[p];
        for (var d = 0; d < this.T; d++) s += this.dc[d];
        s += this.balanceCost();
        // 拆分 hard/soft 仅用于报告（重算一次全量）
        return s;
    };

    State.prototype.fullCost = function () {
        var hard = 0, soft = 0;
        for (var p = 0; p < this.P; p++) {
            var a = this.a[p], work = 0, night = 0, we = 0;
            for (var i = 0; i < this.T; i++) {
                if (a[i]) { work++; if (a[i] === NIGHT) night++; if (this.in.weekend[i]) we++; }
            }
            var diff = work - this.in.targets[p];
            if (Math.abs(diff) > 1) hard += (Math.abs(diff) - 1) * HARD;
            soft += Math.abs(diff) * 30;
            var run = this.runBefore[p];
            for (var k = 0; k < this.T; k++) {
                if (a[k]) { run++; if (run > this.maxRun) hard += HARD; else if (run === this.maxRun) soft += W.run6; }
                else run = 0;
            }
            var n2dHard2 = !!(this.in.rules && this.in.rules.nightToDayHard);
            if (this.prevNight[p] && a[0] === DAY) { if (n2dHard2) hard += HARD; else soft += W.nightToDay; }
            for (var j = 1; j < this.T; j++) {
                if (a[j - 1] === NIGHT && a[j] === DAY) { if (n2dHard2) hard += HARD; else soft += W.nightToDay; }
            }
            for (var wf = 0; wf < this.T; wf++) {
                var fw = this.in.fixed[p][wf];
                if (fw === FIX_DAY_IF_WORK && a[wf] === NIGHT) hard += HARD * 3;
                else if (fw === FIX_NIGHT_IF_WORK && a[wf] === DAY) hard += HARD * 3;
                else if (fw === FIX_WORK && a[wf] === OFF) hard += HARD * 3;
            }
            var i0 = 0;
            while (i0 < this.T) {
                if (!a[i0]) { i0++; continue; }
                var s0 = i0, segNight = 0;
                while (i0 < this.T && a[i0]) { if (a[i0] === NIGHT) segNight++; i0++; }
                if (s0 > 0 && i0 < this.T) {
                    var segLen = i0 - s0;
                    soft += Math.abs(segLen - 5) * W.segLen;
                    if (segNight === segLen) soft += W.allNight;
                    else if (segNight === 0) soft += W.allDay;
                    soft += Math.abs(segNight - Math.round(segLen * 2 / 5)) * W.segMix;
                }
            }
            for (var m = 0; m < this.T; m++) {
                if (a[m] !== OFF) continue;
                if (this.in.fixed[p][m] === FIX_LEAVE) continue; // 请假日不参与双休判定（与 validate 口径一致）
                var left = m > 0 ? (a[m - 1] === OFF ? 1 : 0) : (this.prevOff[p] ? 1 : 0);
                var right = m < this.T - 1 ? (a[m + 1] === OFF ? 1 : 0) : 1;
                if (!left && !right) hard += HARD; else if (left && right) soft += W.longRest;
            }
            var pref = this.in.prefers[p];
            if (pref === 'day') soft += night * W.prefer; else if (pref === 'night') soft += (work - night) * W.prefer;
            var nt = this.in.nightTarget ? this.in.nightTarget[p] : 0;
            if (nt) {
                if ((this.in.balance || []).indexOf('night') >= 0) {
                    var loB2 = Math.max(0, Math.floor(nt) - 1), hiB2 = Math.ceil(nt) + 1;
                    if (night < loB2) hard += (loB2 - night) * HARD;
                    if (night > hiB2) hard += (night - hiB2) * HARD;
                } else soft += Math.abs(night - nt) * W.nightBias;
            }
            for (var n = 0; n < this.T - 1; n++) if (a[n] && a[n + 1] && a[n] !== a[n + 1]) soft += W.sw;
        }
        for (var d = 0; d < this.T; d++) {
            var day = 0, night2 = 0;
            for (var q = 0; q < this.P; q++) { var v = this.a[q][d]; if (v === DAY) day++; else if (v === NIGHT) night2++; }
            var tot = day + night2;
            if (tot < this.minTotal) hard += (this.minTotal - tot) * HARD;
            if (tot > this.maxStaff) hard += (tot - this.maxStaff) * HARD;
            if (day < this.minDay) hard += (this.minDay - day) * HARD;
            if (night2 < this.minNight) hard += (this.minNight - night2) * HARD;
            var drs2 = this.in.dayRules || [];
            for (var di2 = 0; di2 < drs2.length; di2++) {
                var r2 = drs2[di2];
                if (r2.days.indexOf(d) < 0) continue;
                var act2 = r2.kind === 'day' ? day : r2.kind === 'night' ? night2 : tot;
                if (r2.op === 'min' && act2 < r2.n) hard += (r2.n - act2) * HARD;
                if (r2.op === 'max' && act2 > r2.n) hard += (act2 - r2.n) * HARD;
            }
        }
        return { hard: hard / HARD, soft: soft };
    };

    // 从第 d 天起，某人还有几个硬性必休日没有被安排
    function mustRestLeftOf(st, p, d) {
        var c = 0;
        for (var i = d; i < st.T; i++) {
            if (st.in.fixed[p][i] === FIX_REST && st.a[p][i] !== OFF) c++;
        }
        return c;
    }

    // ── 贪心构造 ──
    State.prototype.construct = function () {
        var T = this.T, P = this.P;
        var total = 0;
        for (var p = 0; p < P; p++) total += this.in.targets[p];
        var m = new Array(T).fill(this.minTotal);
        var extra = total - this.minTotal * T;
        var order = [];
        for (var i = 0; i < T; i++) order.push(i);
        for (var s = order.length - 1; s > 0; s--) {
            var r = Math.floor(this.rand() * (s + 1)); var t = order[s]; order[s] = order[r]; order[r] = t;
        }
        var k = 0, guard = 0;
        while (extra > 0 && guard < T * 5) {
            var d0 = order[k % T];
            if (m[d0] < this.maxStaff) { m[d0]++; extra--; }
            k++; guard++;
        }
        // ── 第一步：决定谁休息。休息日强制成对，避免出现孤立单休 ──
        var self = this;
        var restNeed = [];
        for (var q0 = 0; q0 < P; q0++) {
            var lv = 0;
            for (var dd0 = 0; dd0 < T; dd0++) if (this.in.fixed[q0][dd0] === FIX_LEAVE) lv++;
            restNeed.push(Math.max(0, T - this.in.targets[q0] - lv));
        }
        // 每日休息人数目标：按「总休息人天 / 天数」铺开，余量均匀打散。
        // 原来固定每天 2 人休息，总量（2×T）常常少于实际需要的休息人天，
        // 缺口只能靠修复器硬补 —— 补的时候必然拆出孤立单休。
        var totalRestAll = 0;
        for (var qr = 0; qr < P; qr++) totalRestAll += restNeed[qr];
        var baseRest = Math.floor(totalRestAll / T);
        var remRest = totalRestAll - baseRest * T;
        var restTarget = new Array(T).fill(baseRest);
        for (var rr = 0; rr < remRest; rr++) {
            var ridx = Math.min(T - 1, Math.floor((rr + 0.5) * T / Math.max(1, remRest)));
            restTarget[ridx]++;
        }
        var restCap = P - this.minTotal;   // 最多能休几人（保证上班人数够）
        var restMin = P - this.maxStaff;   // 最少要休几人（不超过同时上班上限）
        for (var rt = 0; rt < T; rt++) restTarget[rt] = Math.max(restMin, Math.min(restCap, restTarget[rt]));
        // 默认全部上班，随后逐日「开段」
        for (var pi0 = 0; pi0 < P; pi0++) for (var di0 = 0; di0 < T; di0++) this.a[pi0][di0] = DAY;
        // 每人还该分到几段休息（2 天一段），按它来轮转，避免有人段不够、出勤超标
        var segLeft = restNeed.map(function (r) { return Math.ceil(r / 2); });
        var lastSegEnd = new Array(P).fill(-99);
        // 逐日开「休 2 天」的段：休息日天然成对，且当天/次日出勤人数都可控
        for (var d = 0; d < T - 1; d++) {
            var p, cont = [], offToday = {}, q;
            for (p = 0; p < P; p++) if (lastSegEnd[p] === d) cont.push(p);   // 昨天开段、今天仍在休息的人
            for (p = 0; p < P; p++) {
                var ftd = this.in.fixed[p][d];
                if (ftd === FIX_REST || ftd === FIX_LEAVE) offToday[p] = 1;
            }
            for (q = 0; q < cont.length; q++) offToday[cont[q]] = 1;

            // 今天硬性要休、但昨天没休的人：必须今天开段，否则会变成孤立单休
            var mustStart = [];
            for (p = 0; p < P; p++) {
                if (this.in.fixed[p][d] === FIX_REST && cont.indexOf(p) < 0) mustStart.push(p);
            }
            var targetToday = restTarget[d];                          // 当天休息人数目标
            var targetTomorrow = restTarget[d + 1];
            // 明天已经确定要休的人（必休 / 请假）。今天开段的人明天是「延续」，若他本就在明天必休里则不重复计数
            var offTomorrowSet = {}, offTomorrowCnt = 0;
            for (p = 0; p < P; p++) {
                var ftd1 = this.in.fixed[p][d + 1];
                if (ftd1 === FIX_REST || ftd1 === FIX_LEAVE) { offTomorrowSet[p] = 1; offTomorrowCnt++; }
            }
            var extraCnt = function (list) {
                var c = 0;
                for (var i = 0; i < list.length; i++) if (!offTomorrowSet[list[i]]) c++;
                return c;
            };
            var dcur = d;
            var sc = function (x) {
                var s = segLeft[x] * 3 + restNeed[x] + (dcur - lastSegEnd[x]) * 0.4 + self.rand() * 4;
                // 剩下的天数快要不够把该休的段排完了 —— 必须优先
                if (segLeft[x] * 3 - 1 >= (T - dcur)) s += 40;
                if (self.in.fixed[x][dcur + 1] === FIX_REST) s += 18;  // 明天硬性要休，今天开段正好覆盖
                if (self.in.fixed[x][dcur] === FIX_REST) s += 14;
                if (dcur > 0 && self.a[x][dcur - 1] === NIGHT) s += 1;
                return s;
            };
            var newSegs = [];
            mustStart.sort(function (x, y) { return sc(y) - sc(x); });
            for (var mi = 0; mi < mustStart.length; mi++) {
                var ms = mustStart[mi], fm = this.in.fixed[ms][d + 1];
                if (fm === FIX_DAY || fm === FIX_NIGHT) continue;
                var add1 = offTomorrowSet[ms] ? 0 : 1;
                if (offTomorrowCnt + extraCnt(newSegs) + add1 > targetTomorrow) continue; // 会让明天休息的人太多
                newSegs.push(ms);
            }
            var curOff = 0, kk;
            for (kk in offToday) if (offToday[kk]) curOff++;
            for (var ni0 = 0; ni0 < newSegs.length; ni0++) if (!offToday[newSegs[ni0]]) curOff++;
            while (curOff < targetToday) {
                var cands = [], loose = null;
                for (p = 0; p < P; p++) {
                    if (offToday[p] || newSegs.indexOf(p) >= 0) continue;
                    if (restNeed[p] <= 0) continue;
                    if (this.in.fixed[p][d] === FIX_LEAVE) continue;
                    if (this.in.fixed[p][d] === FIX_WORK || this.in.fixed[p][d + 1] === FIX_WORK) continue;   // 必须上班的日子不能开休息段
                    var cf0 = this.in.fixed[p][d], cf1 = this.in.fixed[p][d + 1];
                    if (cf0 === FIX_DAY || cf0 === FIX_NIGHT || cf1 === FIX_DAY || cf1 === FIX_NIGHT) continue;
                    // 还有硬性必休日没安排的人（例如周四要白班、周三必须休的），只让他开能盖住必休日的段，
                    // 否则他会多拿段 → 休息超标 → 出勤不够
                    if (mustRestLeftOf(this, p, d) > 0) {
                        var cv = (cf0 === FIX_REST && this.a[p][d] !== OFF) || (cf1 === FIX_REST && this.a[p][d + 1] !== OFF);
                        if (!cv) continue;
                    }
                    if (d - lastSegEnd[p] >= 2) cands.push(p);          // 两段之间至少隔一个上班日
                    else if (d - lastSegEnd[p] >= 1) (loose || (loose = [])).push(p); // 退而求其次：连休三天
                }
                if (!cands.length) cands = loose || [];                  // 没人可选时宁可三连休，也不要当天 6 人上班
                if (!cands.length) break;
                cands.sort(function (x, y) { return sc(y) - sc(x); });
                var addC = offTomorrowSet[cands[0]] ? 0 : 1;
                if (offTomorrowCnt + extraCnt(newSegs) + addC > targetTomorrow) break;
                newSegs.push(cands[0]); curOff++;
            }
            for (var si = 0; si < newSegs.length; si++) {
                var sp = newSegs[si];
                this.a[sp][d] = OFF;
                if (this.in.fixed[sp][d] !== FIX_LEAVE) restNeed[sp]--;
                var fn2 = this.in.fixed[sp][d + 1];
                if (fn2 !== FIX_DAY && fn2 !== FIX_NIGHT) {
                    this.a[sp][d + 1] = OFF;
                    if (fn2 !== FIX_LEAVE) restNeed[sp]--;
                    lastSegEnd[sp] = d + 1;
                } else {
                    lastSegEnd[sp] = d;
                }
                if (restNeed[sp] < 0) restNeed[sp] = 0;
                segLeft[sp] = Math.max(0, Math.ceil(restNeed[sp] / 2));
            }
        }
        // 人数校正：杜绝「当天全员上班」和「3 人以上同时休息」
        // 关键：只动「休息段的边缘日」，避免从连休中间切断而裂出孤立单休
        for (var d3 = 0; d3 < T; d3++) {
            var restList = [], workList = [];
            for (q = 0; q < P; q++) {
                if (this.a[q][d3] === OFF) restList.push(q); else workList.push(q);
            }
            if (!restList.length && workList.length) {
                var candW = [];
                for (var wi = 0; wi < workList.length; wi++) {
                    var wp = workList[wi], wf = this.in.fixed[wp][d3];
                    if (wf === FIX_DAY || wf === FIX_NIGHT || wf === FIX_REST || wf === FIX_LEAVE || wf === FIX_WORK) continue;
                    var wAdj = (d3 > 0 && this.a[wp][d3 - 1] === OFF) || (d3 < T - 1 && this.a[wp][d3 + 1] === OFF);
                    candW.push({ p: wp, adj: wAdj ? 0 : 1, need: restNeed[wp] });
                }
                if (candW.length) {
                    candW.sort(function (x, y) { return (x.adj - y.adj) || (y.need - x.need); });
                    var pickW = candW[0].p;
                    this.a[pickW][d3] = OFF;
                    if (restNeed[pickW] > 0) restNeed[pickW]--;
                }
            } else if (restList.length >= 3) {
                var candR = [];
                for (var ri = 0; ri < restList.length; ri++) {
                    var rp = restList[ri], rf = this.in.fixed[rp][d3];
                    if (rf === FIX_REST || rf === FIX_LEAVE) continue;
                    var rEdge = (d3 === 0 || this.a[rp][d3 - 1] !== OFF) || (d3 === T - 1 || this.a[rp][d3 + 1] !== OFF);
                    candR.push({ p: rp, edge: rEdge ? 0 : 1, need: restNeed[rp] });
                }
                if (candR.length) {
                    candR.sort(function (x, y) { return (x.edge - y.edge) || (x.need - y.need); });
                    this.a[candR[0].p][d3] = DAY;
                }
            }
        }
        // 强制：请假 / 必休 / 指定班次
        for (q = 0; q < P; q++) {
            for (var dz = 0; dz < T; dz++) {
                var fz = this.in.fixed[q][dz];
                if (fz === FIX_LEAVE || fz === FIX_REST) this.a[q][dz] = OFF;
                else if (fz === FIX_DAY) this.a[q][dz] = DAY;
                else if (fz === FIX_NIGHT) this.a[q][dz] = NIGHT;
                else if (fz === FIX_WORK && this.a[q][dz] === OFF) this.a[q][dz] = DAY;   // 必须上班：被排成休息就补成白班
            }
        }
        // ── 第二步：白/夜分配 —— 先用回溯精确求解 ──
        var backup = this.a.map(function (r) { return r.slice(); });
        this.dfsOk = assignShiftsDFS(this);
        if (this.dfsOk) {
            this.applyFixed();
            this.refresh();
            return;
        }
        this.a = backup;

        // 回溯失败时的兜底：逐日按配额贪心分配
        var whiteCnt = new Array(P).fill(0);
        for (var d2 = 0; d2 < T; d2++) {
            var mustDay = [], mustNight = [], prevNightList = [], free = [], p2;
            for (p2 = 0; p2 < P; p2++) {
                if (this.a[p2][d2] === OFF) continue;
                var prevIsNight = d2 > 0 ? (this.a[p2][d2 - 1] === NIGHT) : this.prevNight[p2];
                var fpw = this.in.fixed[p2][d2];
                if (fpw === FIX_DAY || fpw === FIX_DAY_IF_WORK) {
                    if (prevIsNight) { this.a[p2][d2] = OFF; continue; } // 昨日小夜+今日必白班：今天只能休
                    mustDay.push(p2);
                } else if (fpw === FIX_NIGHT || fpw === FIX_NIGHT_IF_WORK) mustNight.push(p2);
                else if (prevIsNight) { prevNightList.push(p2); free.push(p2); } // 昨日小夜：优先夜班，非强制
                else free.push(p2);
            }
            var workers = [];
            for (p2 = 0; p2 < P; p2++) if (this.a[p2][d2] !== OFF) workers.push(p2);
            if (!workers.length) continue;
            var mNow = workers.length;
            var loDay = Math.max(this.minDay, mustDay.length);
            var hiDay = Math.max(loDay, mNow - mustNight.length);
            var ideal = Math.round(mNow * 0.5);
            // 前瞻上限：今晚排夜班、且明天还上班的人数有上限 —— 明天的白班必须留得下 minDay 人
            // （小夜之后次日不能上白班，今天夜班排多了明天就没白班可排）
            var cap = 999;
            if (d2 + 1 < T) {
                var wNext = 0, mn2 = 0;
                for (var pn = 0; pn < P; pn++) {
                    if (this.a[pn][d2 + 1] === OFF) continue;
                    wNext++;
                    var fn2 = this.in.fixed[pn][d2 + 1];
                    if (fn2 === FIX_NIGHT || fn2 === FIX_NIGHT_IF_WORK) mn2++;
                }
                cap = wNext - this.minDay - mn2;
            }
            // 自由人排序：白班少的优先、明天必须白班的优先、昨日小夜者靠后
            free.sort(function (x, y) {
                var sx = whiteCnt[x] + (self.tomorrowMustDay(x, d2) ? -3 : 0) + (prevNightList.indexOf(x) >= 0 ? 6 : 0) + self.rand() * 0.8;
                var sy = whiteCnt[y] + (self.tomorrowMustDay(y, d2) ? -3 : 0) + (prevNightList.indexOf(y) >= 0 ? 6 : 0) + self.rand() * 0.8;
                return sx - sy;
            });
            // 枚举白班方案，挑既满足当天白/夜下限、又不把明天白班挤没的组合
            var daySet = null, bestDiff = Infinity;
            var needLo = Math.max(0, loDay - mustDay.length);
            var needHi = Math.min(free.length, hiDay - mustDay.length);
            for (var nd = needLo; nd <= needHi; nd++) {
                var cmbList = combinations(free, nd);
                for (var ci = 0; ci < cmbList.length; ci++) {
                    var trial = mustDay.concat(cmbList[ci]);
                    if (d2 + 1 < T) {
                        var carryCnt = 0;
                        for (var pq = 0; pq < P; pq++) {
                            if (this.a[pq][d2] === OFF || this.a[pq][d2 + 1] === OFF) continue;
                            if (trial.indexOf(pq) < 0) carryCnt++;
                        }
                        if (carryCnt > cap) continue;
                    }
                    var diff = Math.abs(trial.length - ideal);
                    if (diff < bestDiff) { bestDiff = diff; daySet = trial; }
                }
                if (daySet && bestDiff === 0) break;
            }
            if (!daySet) {
                daySet = mustDay.slice(0);
                var dq2 = Math.min(hiDay, Math.max(loDay, ideal));
                for (var fi = 0; fi < free.length && daySet.length < dq2; fi++) daySet.push(free[fi]);
            }
            for (var q2 = 0; q2 < workers.length; q2++) {
                var pidx = workers[q2];
                var isDay = daySet.indexOf(pidx) >= 0;
                this.a[pidx][d2] = isDay ? DAY : NIGHT;
                if (isDay) whiteCnt[pidx]++;
            }
        }
        this.applyFixed();
        this.refresh();
    };

    // ── 模拟退火 ──
    State.prototype.anneal = function (iters, t0, t1) {
        var T = this.T, P = this.P;
        var cur = this.score();
        var alpha = Math.pow(t1 / t0, 1 / Math.max(1, iters));
        var temp = t0;
        for (var it = 0; it < iters; it++) {
            temp *= alpha;
            var r = this.rand();
            var p1, p2, d1, d2, oldv, newv;
            if (r >= 0.90) {
                // 针对性：把孤立单休挪到相邻日，找另一个人做矩形对调
                p1 = Math.floor(this.rand() * P);
                var solos = [];
                for (var si = 1; si < T - 1; si++) {
                    if (this.a[p1][si] === OFF && this.a[p1][si - 1] !== OFF && this.a[p1][si + 1] !== OFF) solos.push(si);
                }
                if (!solos.length) continue;
                d1 = solos[Math.floor(this.rand() * solos.length)];
                d2 = this.rand() < 0.5 ? d1 - 1 : d1 + 1;
                if (this.isLocked(p1, d1) || this.isLocked(p1, d2)) continue;
                var cand2 = [];
                for (var q = 0; q < P; q++) {
                    if (q === p1) continue;
                    if (this.a[q][d2] !== OFF || this.a[q][d1] === OFF) continue;
                    if (this.isLocked(q, d1) || this.isLocked(q, d2)) continue;
                    cand2.push(q);
                }
                if (!cand2.length) continue;
                p2 = cand2[Math.floor(this.rand() * cand2.length)];
                var v1s = this.a[p1][d2], v2s = this.a[p2][d1];
                var b4 = this.pc[p1] + this.pc[p2] + this.dc[d1] + this.dc[d2] + this.balanceCost();
                this.a[p1][d1] = v2s; this.a[p1][d2] = OFF;
                this.a[p2][d1] = OFF; this.a[p2][d2] = v1s;
                this.pc[p1] = this.personCost(p1); this.pc[p2] = this.personCost(p2);
                this.dc[d1] = this.dayCost(d1); this.dc[d2] = this.dayCost(d2);
                var a5 = this.pc[p1] + this.pc[p2] + this.dc[d1] + this.dc[d2] + this.balanceCost();
                if (this.accept(a5 - b4, temp)) cur += a5 - b4;
                else {
                    this.a[p1][d1] = OFF; this.a[p1][d2] = v1s;
                    this.a[p2][d1] = v2s; this.a[p2][d2] = OFF;
                    this.pc[p1] = this.personCost(p1); this.pc[p2] = this.personCost(p2);
                    this.dc[d1] = this.dayCost(d1); this.dc[d2] = this.dayCost(d2);
                }
            } else if (r < 0.30) {
                // 单点变异
                p1 = Math.floor(this.rand() * P); d1 = Math.floor(this.rand() * T);
                if (this.isLocked(p1, d1)) continue;
                oldv = this.a[p1][d1];
                newv = Math.floor(this.rand() * 3);
                if (newv === oldv) continue;
                var before = this.pc[p1] + this.dc[d1] + this.balanceCost();
                this.a[p1][d1] = newv;
                this.pc[p1] = this.personCost(p1); this.dc[d1] = this.dayCost(d1);
                var after = this.pc[p1] + this.dc[d1] + this.balanceCost();
                if (this.accept(after - before, temp)) cur += after - before;
                else { this.a[p1][d1] = oldv; this.pc[p1] = this.personCost(p1); this.dc[d1] = this.dayCost(d1); }
            } else if (r < 0.55) {
                // 同日两人交换（保持当日人数不变）
                d1 = Math.floor(this.rand() * T);
                p1 = Math.floor(this.rand() * P); p2 = Math.floor(this.rand() * P);
                if (p1 === p2 || this.isLocked(p1, d1) || this.isLocked(p2, d1)) continue;
                if (this.a[p1][d1] === this.a[p2][d1]) continue;
                var b2 = this.pc[p1] + this.pc[p2] + this.dc[d1] + this.balanceCost();
                var tmp = this.a[p1][d1]; this.a[p1][d1] = this.a[p2][d1]; this.a[p2][d1] = tmp;
                this.pc[p1] = this.personCost(p1); this.pc[p2] = this.personCost(p2); this.dc[d1] = this.dayCost(d1);
                var a2 = this.pc[p1] + this.pc[p2] + this.dc[d1] + this.balanceCost();
                if (this.accept(a2 - b2, temp)) cur += a2 - b2;
                else {
                    var tmp2 = this.a[p1][d1]; this.a[p1][d1] = this.a[p2][d1]; this.a[p2][d1] = tmp2;
                    this.pc[p1] = this.personCost(p1); this.pc[p2] = this.personCost(p2); this.dc[d1] = this.dayCost(d1);
                }
            } else if (r < 0.75) {
                // 同一人：工作日 ↔ 休息日 互换（保持该人出勤数不变）
                p1 = Math.floor(this.rand() * P);
                d1 = Math.floor(this.rand() * T); d2 = Math.floor(this.rand() * T);
                if (d1 === d2 || this.isLocked(p1, d1) || this.isLocked(p1, d2)) continue;
                if (this.a[p1][d1] === this.a[p1][d2]) continue;
                var b3 = this.pc[p1] + this.dc[d1] + this.dc[d2] + this.balanceCost();
                var t3 = this.a[p1][d1]; this.a[p1][d1] = this.a[p1][d2]; this.a[p1][d2] = t3;
                this.pc[p1] = this.personCost(p1); this.dc[d1] = this.dayCost(d1); this.dc[d2] = this.dayCost(d2);
                var a3 = this.pc[p1] + this.dc[d1] + this.dc[d2] + this.balanceCost();
                if (this.accept(a3 - b3, temp)) cur += a3 - b3;
                else {
                    var t4 = this.a[p1][d1]; this.a[p1][d1] = this.a[p1][d2]; this.a[p1][d2] = t4;
                    this.pc[p1] = this.personCost(p1); this.dc[d1] = this.dayCost(d1); this.dc[d2] = this.dayCost(d2);
                }
            } else {
                // 矩形交换：p1 上 d1 休 d2、p2 上 d2 休 d1 对调 —— 每天人数和每人出勤都不变，
                // 这是唯一能自由挪动休息日位置、消除孤立单休的可行移动
                d1 = Math.floor(this.rand() * T); d2 = Math.floor(this.rand() * T);
                p1 = Math.floor(this.rand() * P); p2 = Math.floor(this.rand() * P);
                if (d1 === d2 || p1 === p2) continue;
                if (this.a[p1][d1] === OFF || this.a[p2][d2] === OFF) continue;
                if (this.a[p1][d2] !== OFF || this.a[p2][d1] !== OFF) continue;
                if (this.isLocked(p1, d1) || this.isLocked(p1, d2) || this.isLocked(p2, d1) || this.isLocked(p2, d2)) continue;
                var v1 = this.a[p1][d1], v2 = this.a[p2][d2];
                var b6 = this.pc[p1] + this.pc[p2] + this.dc[d1] + this.dc[d2] + this.balanceCost();
                this.a[p1][d1] = OFF; this.a[p1][d2] = v2;
                this.a[p2][d1] = v1; this.a[p2][d2] = OFF;
                this.pc[p1] = this.personCost(p1); this.pc[p2] = this.personCost(p2);
                this.dc[d1] = this.dayCost(d1); this.dc[d2] = this.dayCost(d2);
                var a6 = this.pc[p1] + this.pc[p2] + this.dc[d1] + this.dc[d2] + this.balanceCost();
                if (this.accept(a6 - b6, temp)) cur += a6 - b6;
                else {
                    this.a[p1][d1] = v1; this.a[p1][d2] = OFF;
                    this.a[p2][d1] = OFF; this.a[p2][d2] = v2;
                    this.pc[p1] = this.personCost(p1); this.pc[p2] = this.personCost(p2);
                    this.dc[d1] = this.dayCost(d1); this.dc[d2] = this.dayCost(d2);
                }
            }
        }
        return cur;
    };

    State.prototype.accept = function (delta, temp) {
        if (delta <= 0) return true;
        return this.rand() < Math.exp(-delta / Math.max(0.0001, temp));
    };

    // ═══════════ 硬约束定向修复（min-conflicts） ═══════════
    State.prototype.dayOf = function (d) { var c = 0; for (var p = 0; p < this.P; p++) if (this.a[p][d] === DAY) c++; return c; };
    State.prototype.nightOf = function (d) { var c = 0; for (var p = 0; p < this.P; p++) if (this.a[p][d] === NIGHT) c++; return c; };
    State.prototype.dayTotal = function (d) { return this.dayOf(d) + this.nightOf(d); };
    State.prototype.workOf = function (p) { var c = 0; for (var d = 0; d < this.T; d++) if (this.a[p][d]) c++; return c; };
    // 若第 d 天改为上班，连班会变成多少天
    State.prototype.runIfWork = function (p, d) {
        var run = 1, i;
        for (i = d - 1; i >= 0; i--) { if (this.a[p][i]) run++; else break; }
        if (i < 0) run += this.runBefore[p];
        for (i = d + 1; i < this.T; i++) { if (this.a[p][i]) run++; else break; }
        return run;
    };

    // 该休息日所在的连续休息天数
    State.prototype.restRunLen = function (p, d) {
        if (this.a[p][d] !== OFF) return 0;
        var len = 1, i;
        for (i = d - 1; i >= 0; i--) { if (this.a[p][i] === OFF) len++; else break; }
        for (i = d + 1; i < this.T; i++) { if (this.a[p][i] === OFF) len++; else break; }
        return len;
    };

    // 该日是否为「孤立单休」（前后都在上班）
    State.prototype.isSoloRest = function (p, d) {
        if (this.a[p][d] !== OFF) return false;
        var l = d > 0 ? (this.a[p][d - 1] === OFF) : true;
        var r = d < this.T - 1 ? (this.a[p][d + 1] === OFF) : true;
        return !l && !r;
    };

    // 明天上班且必须白班（今天排夜班会挡住明天）
    State.prototype.tomorrowMustDay = function (p, d) {
        if (d + 1 >= this.T) return false;
        var f = this.in.fixed[p][d + 1];
        return (f === FIX_DAY || f === FIX_DAY_IF_WORK) && this.a[p][d + 1] !== OFF;
    };

    // 按星期固定班次（上班日的白/夜必须符合要求）
    State.prototype.fixWeekRule = function () {
        for (var p = 0; p < this.P; p++) {
            for (var d = 0; d < this.T; d++) {
                var f = this.in.fixed[p][d];
                if (f === FIX_NIGHT_IF_WORK && this.a[p][d] === DAY) { this.setCell(p, d, NIGHT); return true; }
                if (f === FIX_DAY_IF_WORK && this.a[p][d] === NIGHT) { this.setCell(p, d, DAY); return true; }
            }
        }
        return false;
    };

    // 小夜 → 次日白班
    State.prototype.fixNightToDay = function () {
        for (var p = 0; p < this.P; p++) {
            if (this.prevNight[p] && this.a[p][0] === DAY) {
                var f0 = this.in.fixed[p][0];
                if (f0 !== FIX_DAY && f0 !== FIX_DAY_IF_WORK && !this.isLocked(p, 0)) { this.setCell(p, 0, NIGHT); return true; }
                if (!this.isLocked(p, 0)) { this.setCell(p, 0, OFF); return true; }
            }
            for (var d = 1; d < this.T; d++) {
                if (this.a[p][d - 1] !== NIGHT || this.a[p][d] !== DAY) continue;
                var fd = this.in.fixed[p][d], fd1 = this.in.fixed[p][d - 1], fd2 = d >= 2 ? this.in.fixed[p][d - 2] : FIX_FREE;
                // a) 前一天也改成白班（保住当天人数，且顺带补白班）
                if (fd1 !== FIX_NIGHT && fd1 !== FIX_NIGHT_IF_WORK && !this.isLocked(p, d - 1) && this.free(p, d - 1)) {
                    if (d < 2 || this.a[p][d - 2] !== NIGHT) { this.setCell(p, d - 1, DAY); return true; }
                    if (fd2 !== FIX_NIGHT && fd2 !== FIX_NIGHT_IF_WORK && !this.isLocked(p, d - 2)) { this.setCell(p, d - 2, DAY); this.setCell(p, d - 1, DAY); return true; }
                }
                // b) 当天改成夜班
                if (fd !== FIX_DAY && fd !== FIX_DAY_IF_WORK && !this.isLocked(p, d) && this.free(p, d)) { this.setCell(p, d, NIGHT); return true; }
                // c) 前一天改休息
                if (!this.isLocked(p, d - 1) && this.free(p, d - 1)) { this.setCell(p, d - 1, OFF); return true; }
                // d) 当天改休息
                if (!this.isLocked(p, d) && this.free(p, d)) { this.setCell(p, d, OFF); return true; }
            }
        }
        return false;
    };

    // 每日人数 / 白班 / 夜班 下限与上限
    State.prototype.fixCoverage = function () {
        for (var d = 0; d < this.T; d++) {
            var day = this.dayOf(d), night = this.nightOf(d), tot = day + night, p;
            if (tot < this.minTotal) {
                var cands = [];
                for (p = 0; p < this.P; p++) {
                    if (this.a[p][d] !== OFF || this.isLocked(p, d)) continue;
                    if (this.runIfWork(p, d) > this.maxRun) continue;
                    cands.push(p);
                }
                var self = this; // 出勤少的人优先
                cands.sort(function (x, y) { return self.workOf(x) - self.workOf(y); });
                for (var ci = 0; ci < cands.length; ci++) {
                    var pc = cands[ci], fc = this.in.fixed[pc][d];
                    var val = (fc === FIX_DAY_IF_WORK) ? DAY
                        : (fc === FIX_NIGHT_IF_WORK) ? NIGHT
                            : (night < this.minNight) ? NIGHT : DAY;
                    // 别制造「小夜 → 次日白班」
                    if (val === DAY && d > 0 && this.a[pc][d - 1] === NIGHT) {
                        if (fc === FIX_DAY_IF_WORK) continue;
                        val = NIGHT;
                    }
                    this.setCell(pc, d, val);
                    return true;
                }
            }
            if (tot > this.maxStaff) {
                for (p = 0; p < this.P; p++) {
                    if (this.a[p][d] === OFF || this.isLocked(p, d) || !this.free(p, d)) continue;
                    var v = this.a[p][d];
                    if (v === DAY && day - 1 < this.minDay) continue;
                    if (v === NIGHT && night - 1 < this.minNight) continue;
                    this.setCell(p, d, OFF); return true;
                }
            }
            if (day < this.minDay) {
                // 优先挑「前一天不是小夜」的人改成白班；前一天是小夜时，连锁把前一天一起改成白班
                var poolD = [];
                for (p = 0; p < this.P; p++) {
                    if (this.a[p][d] !== NIGHT || this.isLocked(p, d)) continue;
                    var fd = this.in.fixed[p][d];
                    if (fd === FIX_NIGHT || fd === FIX_NIGHT_IF_WORK) continue;
                    poolD.push({ p: p, bad: (d > 0 && this.a[p][d - 1] === NIGHT) ? 1 : 0 });
                }
                poolD.sort(function (x, y) { return x.bad - y.bad; });
                for (var di = 0; di < poolD.length; di++) {
                    var pd = poolD[di].p;
                    if (this.isLocked(pd, d) || !this.free(pd, d)) continue;
                    if (!poolD[di].bad) { this.setCell(pd, d, DAY); return true; }
                    // 前一天是小夜：连锁处理，否则会制造新的小夜→白冲突
                    var fdp = d >= 1 ? this.in.fixed[pd][d - 1] : FIX_FREE;
                    if (d >= 1 && !this.isLocked(pd, d - 1) && fdp !== FIX_NIGHT && fdp !== FIX_NIGHT_IF_WORK) {
                        if (d < 2 || this.a[pd][d - 2] !== NIGHT) { this.setCell(pd, d - 1, DAY); this.setCell(pd, d, DAY); return true; }
                    }
                }
                // 都不行就把当天休息的人拉来上白班：优先从 3 天以上的长休息段里挑，避免拆出单休
                var pull = [];
                for (p = 0; p < this.P; p++) {
                    if (this.a[p][d] !== OFF || this.isLocked(p, d) || !this.free(p, d)) continue;
                    if (d > 0 && this.a[p][d - 1] === NIGHT) continue;
                    var fdw = this.in.fixed[p][d];
                    if (fdw === FIX_NIGHT || fdw === FIX_NIGHT_IF_WORK) continue;
                    if (this.runIfWork(p, d) > this.maxRun) continue;
                    // 只有「休息段≥3 天且在边缘」的休息日才可拆：拆完仍是连休
                    var rlp = this.restRunLen(p, d);
                    var rEp = (d === 0 || this.a[p][d - 1] !== OFF) || (d === this.T - 1 || this.a[p][d + 1] !== OFF);
                    pull.push({ p: p, good: (rlp >= 3 && rEp) ? 0 : 1 });
                }
                pull.sort(function (x, y) { return x.good - y.good; });
                if (pull.length) { this.setCell(pull[0].p, d, DAY); return true; }
            }
            if (night < this.minNight) {
                // 优先挑「次日不是白班」的人改成夜班，避免制造小夜→白冲突
                var poolN = [];
                for (p = 0; p < this.P; p++) {
                    if (this.a[p][d] !== DAY || this.isLocked(p, d)) continue;
                    var fn = this.in.fixed[p][d];
                    if (fn === FIX_DAY || fn === FIX_DAY_IF_WORK) continue;
                    poolN.push({ p: p, bad: (d + 1 < this.T && this.a[p][d + 1] === DAY) ? 1 : 0 });
                }
                poolN.sort(function (x, y) { return x.bad - y.bad; });
                for (var ni = 0; ni < poolN.length; ni++) {
                    var pn2 = poolN[ni].p;
                    if (this.isLocked(pn2, d) || !this.free(pn2, d)) continue;
                    this.setCell(pn2, d, NIGHT); return true;
                }
            }
        }
        return false;
    };

    // 出勤偏差的「整段转移」：把 p1 的两天休息段整体交给 p2（p2 那两天正好上班）。
    // 这样两人的休息都还是成对的，不会拆出单休
    State.prototype.fixWorkSwap = function () {
        for (var p1 = 0; p1 < this.P; p1++) {
            if (this.workOf(p1) >= this.in.targets[p1]) continue;   // p1 班太少（休太多）
            for (var p2 = 0; p2 < this.P; p2++) {
                if (p2 === p1 || this.workOf(p2) <= this.in.targets[p2]) continue; // p2 班太多（休太少）
                for (var d = 0; d < this.T - 1; d++) {
                    if (this.a[p1][d] !== OFF || this.a[p1][d + 1] !== OFF) continue;
                    if (this.a[p2][d] === OFF || this.a[p2][d + 1] === OFF) continue;
                    if (this.restRunLen(p1, d) !== 2) continue;      // 只搬整段（两天），不拆长段
                    if (this.isLocked(p1, d) || this.isLocked(p1, d + 1) || this.isLocked(p2, d) || this.isLocked(p2, d + 1)) continue;
                    var g1 = this.in.fixed[p1][d], g2 = this.in.fixed[p1][d + 1];
                    if (g1 === FIX_DAY || g1 === FIX_NIGHT || g2 === FIX_DAY || g2 === FIX_NIGHT) continue;
                    if (g1 === FIX_REST || g2 === FIX_REST) continue;
                    var v1 = this.a[p2][d], v2 = this.a[p2][d + 1];
                    var base = this.total();
                    this.a[p1][d] = v1; this.a[p1][d + 1] = v2;
                    this.a[p2][d] = OFF; this.a[p2][d + 1] = OFF;
                    if (this.total() - base < 0) {
                        this.tabu[p1][d] = this.step + this.tabuLen;
                        this.tabu[p2][d] = this.step + this.tabuLen;
                        return true;
                    }
                    this.a[p1][d] = OFF; this.a[p1][d + 1] = OFF;
                    this.a[p2][d] = v1; this.a[p2][d + 1] = v2;
                }
            }
        }
        return false;
    };

    // 每人出勤天数
    State.prototype.fixWorkload = function () {
        var self = this;
        for (var p = 0; p < this.P; p++) {
            var work = this.workOf(p), tg = this.in.targets[p], d;
            // 差 1 天可以接受（优先保证双休），差 2 天以上才强制调整
            if (tg - work > 1) {
                var cands = [];
                for (d = 0; d < this.T; d++) {
                    if (this.a[p][d] !== OFF || this.isLocked(p, d)) continue;
                    if (this.runIfWork(p, d) > this.maxRun) continue;
                    if (this.dayTotal(d) >= this.maxStaff) continue;
                    cands.push(d);
                }
                if (!cands.length) continue;
                // 优先缩短「3 天以上的长休息段」（拆一天后仍是连休，不破坏双休），其次补当天缺人的日子
                cands.sort(function (a, b) {
                    var wa = (self.isSoloRest(p, a) ? 0 : (self.restRunLen(p, a) >= 3 ? 0 : 4)) - (self.minTotal - self.dayTotal(a)) * 0.5;
                    var wb = (self.isSoloRest(p, b) ? 0 : (self.restRunLen(p, b) >= 3 ? 0 : 4)) - (self.minTotal - self.dayTotal(b)) * 0.5;
                    return wa - wb;
                });
                var ds = cands[0], fs = this.in.fixed[p][ds];
                var wantNight = (fs === FIX_NIGHT_IF_WORK) || (this.nightOf(ds) < this.minNight);
                if (!wantNight && ds > 0 && this.a[p][ds - 1] === NIGHT) wantNight = true; // 避免小夜→白
                this.setCell(p, ds, (fs === FIX_DAY_IF_WORK) ? DAY : (wantNight ? NIGHT : DAY));
                return true;
            }
            if (work - tg > 1) {
                var poolW = [];
                for (d = 0; d < this.T; d++) {
                    if (this.a[p][d] === OFF || this.isLocked(p, d) || !this.free(p, d)) continue;
                    var v = this.a[p][d];
                    if (this.dayTotal(d) - 1 < this.minTotal) continue;
                    if (v === DAY && this.dayOf(d) - 1 < this.minDay) continue;
                    if (v === NIGHT && this.nightOf(d) - 1 < this.minNight) continue;
                    // 优先挑「旁边已经在休息」的日子，凑成连休两天
                    var near = ((d > 0 && this.a[p][d - 1] === OFF) || (d + 1 < this.T && this.a[p][d + 1] === OFF)) ? 0 : 2;
                    poolW.push({ d: d, w: near });
                }
                poolW.sort(function (x, y) { return x.w - y.w; });
                if (poolW.length) { this.setCell(p, poolW[0].d, OFF); return true; }
            }
        }
        return false;
    };

    // 孤立单休（必须双休）：随机挑一个，枚举「本人挪到相邻日」和「与另一人矩形对调」，
    // 只在总代价下降时才执行，因此不会破坏其它硬约束
    State.prototype.fixSoloRest = function () {
        var targets = [], p, d;
        for (p = 0; p < this.P; p++) {
            for (d = 1; d < this.T - 1; d++) {
                if (this.isSoloRest(p, d) && !this.isLocked(p, d)) targets.push({ p: p, d: d });
            }
        }
        if (!targets.length) return false;
        var t = targets[Math.floor(this.rand() * targets.length)];
        var dirs = [t.d - 1, t.d + 1];
        var baseC = this.fullCost();
        var baseHard = baseC.hard, baseTotal = baseC.hard * HARD + baseC.soft;
        // 评分：硬违规数优先，其次总代价。只要不新增违规就允许执行（否则僵局解不开）
        var bestScore = baseHard * 100000 + baseTotal, bestApply = null, bestHard = baseHard;

        // 方案 A：本人把休息挪到相邻的上班日（出勤天数不变，当天人数不变）
        for (var k = 0; k < 2; k++) {
            var d2 = dirs[k];
            if (d2 < 0 || d2 >= this.T) continue;
            if (this.isLocked(t.p, d2) || this.a[t.p][d2] === OFF || !this.free(t.p, d2)) continue;
            var v = this.a[t.p][d2];
            this.a[t.p][t.d] = v; this.a[t.p][d2] = OFF;
            var cA = this.fullCost();
            this.a[t.p][t.d] = OFF; this.a[t.p][d2] = v;
            var totA = cA.hard * HARD + cA.soft;
            if (cA.hard <= baseHard && totA < baseTotal + 300) {
                var scA = cA.hard * 100000 + totA;
                if (scA < bestScore) { bestScore = scA; bestHard = cA.hard; bestApply = { type: 'A', d2: d2, v: v }; }
            }
        }
        // 方案 B：与另一个人矩形对调（每天人数、每人出勤都不变）
        for (var q = 0; q < this.P; q++) {
            if (q === t.p) continue;
            for (var k2 = 0; k2 < 2; k2++) {
                var d3 = dirs[k2];
                if (d3 < 0 || d3 >= this.T) continue;
                if (this.a[q][d3] !== OFF || this.a[q][t.d] === OFF) continue;
                if (this.isLocked(q, t.d) || this.isLocked(q, d3) || this.isLocked(t.p, d3)) continue;
                if (!this.free(t.p, d3) || !this.free(q, t.d) || !this.free(q, d3)) continue;
                var v1 = this.a[t.p][d3], v2 = this.a[q][t.d];
                this.a[t.p][t.d] = v2; this.a[t.p][d3] = OFF;
                this.a[q][t.d] = OFF; this.a[q][d3] = v1;
                var cB = this.fullCost();
                this.a[t.p][t.d] = OFF; this.a[t.p][d3] = v1;
                this.a[q][t.d] = v2; this.a[q][d3] = OFF;
                var totB = cB.hard * HARD + cB.soft;
                if (cB.hard <= baseHard && totB < baseTotal + 300) {
                    var scB = cB.hard * 100000 + totB;
                    if (scB < bestScore) { bestScore = scB; bestHard = cB.hard; bestApply = { type: 'B', q: q, d3: d3, v1: v1, v2: v2 }; }
                }
            }
        }
        if (!bestApply) return false;
        var ba = bestApply;
        if (ba.type === 'A') {
            this.a[t.p][t.d] = ba.v; this.a[t.p][ba.d2] = OFF;
            this.tabu[t.p][ba.d2] = this.step + this.tabuLen;
        } else {
            this.a[t.p][t.d] = ba.v2; this.a[t.p][ba.d3] = OFF;
            this.a[ba.q][t.d] = OFF; this.a[ba.q][ba.d3] = ba.v1;
            this.tabu[t.p][ba.d3] = this.step + this.tabuLen;
            this.tabu[ba.q][t.d] = this.step + this.tabuLen;
        }
        this.tabu[t.p][t.d] = this.step + this.tabuLen;
        return true;
    };

    // 连续上班超限
    State.prototype.fixRuns = function () {
        for (var p = 0; p < this.P; p++) {
            var run = this.runBefore[p];
            for (var d = 0; d < this.T; d++) {
                if (!this.a[p][d]) { run = 0; continue; }
                run++;
                if (run <= this.maxRun) continue;
                // 优先挑「改掉后当天人数仍达标」的一天；实在没有就强制改（交给 fixCoverage 补人）
                var fallback = -1;
                for (var k = d; k >= 0 && k > d - run; k--) {
                    if (this.isLocked(p, k) || !this.free(p, k)) continue;
                    if (this.dayTotal(k) - 1 >= this.minTotal) { this.setCell(p, k, OFF); return true; }
                    if (fallback < 0) fallback = k;
                }
                if (fallback >= 0) { this.setCell(p, fallback, OFF); return true; }
                break;
            }
        }
        return false;
    };

    State.prototype.total = function () { var c = this.fullCost(); return c.hard * HARD + c.soft; };

    // 单休专项消除：对每个孤立单休，枚举所有「矩形对调」方案，挑代价最小的执行
    State.prototype.reduceSoloRest = function (maxRounds) {
        var moved = 0;
        for (var r = 0; r < (maxRounds || 400); r++) {
            var targets = [], p, d;
            for (p = 0; p < this.P; p++) {
                for (d = 1; d < this.T - 1; d++) {
                    if (this.a[p][d] === OFF && this.a[p][d - 1] !== OFF && this.a[p][d + 1] !== OFF) targets.push({ p: p, d: d });
                }
            }
            if (!targets.length) break;
            var t = targets[Math.floor(this.rand() * targets.length)];
            var base = this.total();
            var bestDelta = Infinity, best = null;
            var dirs = [t.d - 1, t.d + 1];
            for (var di = 0; di < 2; di++) {
                var d2 = dirs[di];
                if (d2 < 0 || d2 >= this.T) continue;
                for (var q = 0; q < this.P; q++) {
                    if (q === t.p) continue;
                    if (this.a[q][d2] !== OFF || this.a[q][t.d] === OFF) continue;
                    if (this.isLocked(t.p, t.d) || this.isLocked(t.p, d2) || this.isLocked(q, t.d) || this.isLocked(q, d2)) continue;
                    var v1 = this.a[t.p][d2], v2 = this.a[q][t.d];
                    this.a[t.p][t.d] = v2; this.a[t.p][d2] = OFF;
                    this.a[q][t.d] = OFF; this.a[q][d2] = v1;
                    var delta = this.total() - base;
                    this.a[t.p][t.d] = OFF; this.a[t.p][d2] = v1;
                    this.a[q][t.d] = v2; this.a[q][d2] = OFF;
                    if (delta < bestDelta) { bestDelta = delta; best = { q: q, d2: d2, v1: v1, v2: v2 }; }
                }
            }
            if (best && (bestDelta <= 0 || (bestDelta < 60 && this.rand() < 0.25))) {
                this.a[t.p][t.d] = best.v2; this.a[t.p][best.d2] = OFF;
                this.a[best.q][t.d] = OFF; this.a[best.q][best.d2] = best.v1;
                moved++;
            }
        }
        this.refresh();
        return moved;
    };

    // 随机扰动：打乱若干格，配合 repair 跳出局部僵局
    State.prototype.perturb = function (k) {
        for (var i = 0; i < k; i++) {
            var p = Math.floor(this.rand() * this.P), d = Math.floor(this.rand() * this.T);
            if (this.isLocked(p, d)) continue;
            this.a[p][d] = Math.floor(this.rand() * 3);
        }
        this.refresh();
    };

    State.prototype.repair = function (maxSteps) {
        var steps = maxSteps || 300;
        var cnt = { w: 0, n: 0, c: 0, k: 0, r: 0, s: 0 }, s = 0, clearedTabu = false;
        // 记录历史最优，结束时回到该状态 —— 保证 repair 单调不劣化
        var c0 = this.fullCost();
        var bestA = this.a.map(function (r) { return r.slice(); });
        var bestHard = c0.hard, bestSoft = c0.soft;
        for (var tp = 0; tp < this.P; tp++) this.tabu[tp].fill(0);
        this.step = 0;
        for (; s < steps; s++) {
            this.step++;
            var moved = false;
            if (this.fixWeekRule()) moved = true;
            else if (this.fixNightToDay()) moved = true;
            else if (this.fixCoverage()) moved = true;
            else if (this.fixWorkSwap()) moved = true;
            else if (this.fixWorkload()) moved = true;
            else if (this.fixRuns()) moved = true;
            else if (this.fixSoloRest()) moved = true;
            if (!moved) {
                if (!clearedTabu) {
                    clearedTabu = true;
                    for (var tp2 = 0; tp2 < this.P; tp2++) this.tabu[tp2].fill(0);
                    continue;
                }
                break;
            }
            var cc = this.fullCost();
            if (cc.hard < bestHard || (cc.hard === bestHard && cc.soft < bestSoft)) {
                bestHard = cc.hard; bestSoft = cc.soft;
                bestA = this.a.map(function (r) { return r.slice(); });
            }
        }
        this.a = bestA;
        this.refresh();
    };

    // ── 主求解入口 ──
    function solve(input) {
        var chk = precheck(input);
        if (!chk.ok) return { ok: false, reason: chk.reason };
        var best = null;
        var snapshot = function (st) { return { a: st.a.map(function (row) { return row.slice(); }), cost: st.fullCost(), state: st }; };
        var keep = function (cand) {
            if (!best || cand.cost.hard < best.cost.hard || (cand.cost.hard === best.cost.hard && cand.cost.soft < best.cost.soft)) best = cand;
        };

        // 阶段 A1：大量「构造 + 定向修复」（很快），先攒够满足全部硬约束的可行解
        var feasibles = [], pool = [];
        for (var a = 0; a < 260 && feasibles.length < 5; a++) {
            var st0 = new State(input, makeRand(1000 + a * 7919 + Math.floor(Math.random() * 100000)));
            st0.construct();
            // 白/夜无解的骨架直接换一个；但至少留一个兜底，避免一个候选都没有
            // 不再因为 dfsOk=false 就跳过：只要还没攒到足够可行解就继续尝试修复
            if (!st0.dfsOk && feasibles.length >= 2 && pool.length >= 5) continue;
            st0.repair(300);
            var c0 = st0.fullCost();
            if (c0.hard === 0) { feasibles.push(st0); continue; }
            pool.push({ st: st0, cost: c0 });
            keep({ a: st0.a.map(function (row) { return row.slice(); }), cost: c0, state: st0 });
        }

        // 阶段 A2：还不够就挑几个最接近的做迭代局部搜索
        pool.sort(function (x, y) { return (x.cost.hard - y.cost.hard) || (x.cost.soft - y.cost.soft); });
        for (var b = 0; b < Math.min(20, pool.length) && feasibles.length < 5; b++) {
            var st = pool[b].st, cc = pool[b].cost;
            for (var att = 0; att < 300 && cc.hard > 0; att++) {
                var trial = new State(input, makeRand(Math.floor(Math.random() * 1e9)));
                trial.a = st.a.map(function (row) { return row.slice(); });
                trial.refresh();
                trial.perturb(2 + Math.floor(trial.rand() * 5));
                trial.repair(120);
                var tc = trial.fullCost();
                if (tc.hard < cc.hard || (tc.hard === cc.hard && tc.soft < cc.soft)) { st = trial; cc = tc; }
            }
            if (cc.hard === 0) feasibles.push(st);
            else keep({ a: st.a.map(function (row) { return row.slice(); }), cost: cc, state: st });
        }

        // 阶段 B：在可行域内退火精修软目标（温度远低于硬违规代价，不会跳出可行域）
        for (var f = 0; f < feasibles.length; f++) {
            var sf = feasibles[f];
            // 先把被 repair 打散的休息段重新配对，再用温和退火保住结构
            sf.reduceSoloRest(400);
            sf.repair(150);
            sf.anneal(150000, 35, 0.5);
            sf.repair(200);
            sf.reduceSoloRest(300);
            sf.repair(150);
            if (sf.fullCost().hard === 0) { sf.anneal(80000, 6, 0.2); sf.repair(200); sf.reduceSoloRest(200); sf.repair(150); }
            keep(snapshot(sf));
        }

        if (!best || best.cost.hard > 0) {
            // 硬约束未清零：再多跑几轮更长退火抢救
            for (var extra = 0; extra < 4; extra++) {
                var st2 = new State(input, makeRand(Math.floor(Math.random() * 1e9)));
                st2.construct();
                st2.anneal(200000, 30, 0.2);
                st2.repair(400);
                if (st2.fullCost().hard === 0) { st2.anneal(40000, 3, 0.2); st2.repair(200); }
                var c2 = st2.fullCost();
                if (c2.hard < best.cost.hard || (c2.hard === best.cost.hard && c2.soft < best.cost.soft)) {
                    best = { a: st2.a.map(function (row) { return row.slice(); }), cost: c2, state: st2 };
                }
                if (best.cost.hard === 0) break;
            }
        }
        // 兜底：迭代局部搜索（随机扰动 + 定向修复），直到硬约束清零
        if (best && best.cost.hard > 0) {
            var rand2 = makeRand(Math.floor(Math.random() * 1e9));
            var cur = new State(input, rand2);
            cur.a = best.a.map(function (row) { return row.slice(); });
            cur.refresh();
            var curCost = cur.fullCost();
            for (var att = 0; att < 120 && curCost.hard > 0; att++) {
                var trial = new State(input, rand2);
                trial.a = cur.a.map(function (row) { return row.slice(); });
                trial.refresh();
                trial.perturb(2 + Math.floor(rand2() * 5));
                trial.repair(200);
                var tc = trial.fullCost();
                if (tc.hard < curCost.hard || (tc.hard === curCost.hard && tc.soft < curCost.soft)) {
                    cur = trial; curCost = tc;
                }
            }
            if (curCost.hard === 0) { cur.anneal(40000, 3, 0.2); cur.repair(300); curCost = cur.fullCost(); }
            if (curCost.hard < best.cost.hard || (curCost.hard === best.cost.hard && curCost.soft < best.cost.soft)) {
                best = { a: cur.a.map(function (row) { return row.slice(); }), cost: curCost, state: cur };
            }
        }
        return { ok: best.cost.hard === 0, a: best.a, cost: best.cost, reason: best.cost.hard > 0 ? '约束冲突未能完全化解（剩余违规 ' + best.cost.hard + ' 项），请放宽需求或减少请假' : '' };
    }

    // 从数组中取 k 个元素的所有组合
    function combinations(arr, k) {
        var res = [];
        (function pick(start, cur) {
            if (cur.length === k) { res.push(cur.slice()); return; }
            for (var i = start; i < arr.length; i++) { cur.push(arr[i]); pick(i + 1, cur); cur.pop(); }
        })(0, []);
        return res;
    }

    // 休息骨架定下来之后，用回溯给每天分配白/夜：
    // 每天上班的只有 4~5 人，白班组合最多 C(5,2)=10 种，配合「明日要白班的人今晚不能排夜」的剪枝，很快能出解
    function assignShiftsDFS(st) {
        var T = st.T, P = st.P, nodes = 0;
        function rec(d) {
            if (d >= T) return true;
            if (++nodes > 1500000) return false;
            var workers = [], mustDay = [], mustNight = [], free = [], p;
            for (p = 0; p < P; p++) {
                if (st.a[p][d] === OFF) continue;
                workers.push(p);
                var f = st.in.fixed[p][d];
                var prevNight = d > 0 ? (st.a[p][d - 1] === NIGHT) : st.prevNight[p];
                if (f === FIX_DAY || f === FIX_DAY_IF_WORK) mustDay.push(p);
                else if (f === FIX_NIGHT || f === FIX_NIGHT_IF_WORK || prevNight) mustNight.push(p);
                else free.push(p);
            }
            if (!workers.length) return rec(d + 1);
            // 明天上班且必须白班的人，今天不能排夜班
            var free2 = [];
            for (var i = 0; i < free.length; i++) {
                var q = free[i];
                if (d + 1 < T && st.a[q][d + 1] !== OFF) {
                    var f1 = st.in.fixed[q][d + 1];
                    if (f1 === FIX_DAY || f1 === FIX_DAY_IF_WORK) mustDay.push(q); else free2.push(q);
                } else free2.push(q);
            }
            free = free2;
            for (var j = 0; j < mustDay.length; j++) if (mustNight.indexOf(mustDay[j]) >= 0) return false;
            var loDay = Math.max(st.minDay, mustDay.length);
            var hiDay = workers.length - Math.max(st.minNight, mustNight.length);
            if (loDay > hiDay) return false;
            var need = Math.min(hiDay, Math.max(loDay, Math.round(workers.length * 0.5))) - mustDay.length;
            if (need < 0) need = 0;
            if (need > free.length) return false;
            // 前瞻：今天排夜班的人，明天上班的话明天还得是夜班。
            // 明天夜班名额有限（要留够白班下限），超了明天就无解 —— 现在就避开
            var cap = 999;
            if (d + 1 < T) {
                var wNext = 0, mn2 = 0;
                for (p = 0; p < P; p++) {
                    if (st.a[p][d + 1] === OFF) continue;
                    wNext++;
                    var f2 = st.in.fixed[p][d + 1];
                    if (f2 === FIX_NIGHT || f2 === FIX_NIGHT_IF_WORK) mn2++;
                }
                cap = wNext - st.minDay - mn2;
                if (cap < 0) return false;
            }
            var combos = combinations(free, need);
            for (var c = 0; c < combos.length; c++) {
                var daySet = mustDay.concat(combos[c]);
                if (cap < 999) {
                    var carry = 0;
                    for (p = 0; p < P; p++) {
                        if (st.a[p][d] === OFF || st.a[p][d + 1] === OFF) continue;
                        if (daySet.indexOf(p) < 0) carry++;
                    }
                    if (carry > cap) continue;
                }
                for (p = 0; p < P; p++) {
                    if (st.a[p][d] === OFF) continue;
                    st.a[p][d] = daySet.indexOf(p) >= 0 ? DAY : NIGHT;
                }
                if (rec(d + 1)) return true;
            }
            return false;
        }
        return rec(0);
    }

    // ═══════════ 结果整理 ═══════════
    function buildResult(input, a) {
        var T = input.dates.length, P = input.people.length;
        var grid = [], personStats = [];
        for (var p = 0; p < P; p++) {
            var row = [];
            var work = 0, rest = 0, leave = 0, night = 0, weekend = 0;
            var leaveDetail = {};
            for (var d = 0; d < T; d++) {
                var v = a[p][d];
                if (input.fixed[p][d] === FIX_LEAVE) {
                    var ln = input.leaveName[p][d] || '事假';
                    row.push(ln); leave++; leaveDetail[ln] = (leaveDetail[ln] || 0) + 1;
                } else if (v === OFF) { row.push('休'); rest++; }
                else if (v === NIGHT) {
                    row.push(NIGHT_SHIFT); work++; night++;
                    if (input.weekend[d]) weekend++;
                } else {
                    row.push(DAY_SHIFT); work++;
                    if (input.weekend[d]) weekend++;
                }
            }
            // 最长连班（含上期衔接）
            var run = 0, maxRun = 0;
            var pv = (input.carry && input.carry[p]) ? input.carry[p] : [];
            for (var i = pv.length - 1; i >= 0; i--) { if (pv[i]) run++; else break; }
            for (var k = 0; k < T; k++) {
                if (a[p][k]) { run++; if (run > maxRun) maxRun = run; } else run = 0;
            }
            grid.push(row);
            personStats.push({
                cn: input.people[p].cn, en: input.people[p].en, org: input.people[p].org,
                work: work, rest: rest, leave: leave, leaveDetail: leaveDetail,
                day: work - night, night: night, weekend: weekend, maxRun: maxRun
            });
        }
        var dayStats = [];
        for (var dd = 0; dd < T; dd++) {
            var day = 0, night2 = 0, off = 0;
            for (var p3 = 0; p3 < P; p3++) {
                var v3 = a[p3][dd];
                if (v3 === DAY) day++; else if (v3 === NIGHT) night2++; else off++;
            }
            dayStats.push({ day: day, night: night2, total: day + night2, rest: off });
        }
        // 争议值班轮值
        var dayDuty = new Array(T).fill(''), nightDuty = new Array(T).fill('');
        var dutyCnt = {}, lastDay = {}, lastNight = {};
        for (var t = 0; t < T; t++) {
            var cands = [];
            for (var p4 = 0; p4 < P; p4++) if (a[p4][t] === DAY) cands.push(p4);
            cands.sort(function (x, y) { return (dutyCnt[x] || 0) - (dutyCnt[y] || 0); });
            var pick = cands.filter(function (x) { return lastDay[x] !== t - 1; });
            var chosen = pick.length ? pick[0] : (cands.length ? cands[0] : -1);
            if (chosen >= 0) { dayDuty[t] = input.people[chosen].cn; dutyCnt[chosen] = (dutyCnt[chosen] || 0) + 1; lastDay[chosen] = t; }

            var ncands = [];
            for (var p5 = 0; p5 < P; p5++) if (a[p5][t] === NIGHT) ncands.push(p5);
            ncands.sort(function (x, y) { return (dutyCnt[x] || 0) - (dutyCnt[y] || 0); });
            var npick = ncands.filter(function (x) { return lastNight[x] !== t - 1; });
            var nchosen = npick.length ? npick[0] : (ncands.length ? ncands[0] : -1);
            if (nchosen >= 0) { nightDuty[t] = input.people[nchosen].cn; dutyCnt[nchosen] = (dutyCnt[nchosen] || 0) + 1; lastNight[nchosen] = t; }
        }
        return { grid: grid, personStats: personStats, dayStats: dayStats, dayDuty: dayDuty, nightDuty: nightDuty, raw: a };
    }

    // ═══════════ 独立校验（不信任求解器自检） ═══════════
    function validate(input, result) {
        var T = input.dates.length, P = input.people.length;
        var v = [], notes = [], solo = [];
        var rules = input.rules;
        var dlabel = function (i) { return (input.dates[i].getMonth() + 1) + '/' + input.dates[i].getDate(); };
        for (var p = 0; p < P; p++) {
            var st = result.personStats[p];
            if (Math.abs(st.work - input.targets[p]) > 1) v.push(st.cn + ' 实际出勤 ' + st.work + ' 天，目标 ' + input.targets[p] + ' 天（超出允许浮动）');
            else if (st.work !== input.targets[p]) notes.push(st.cn + ' 出勤 ' + st.work + ' 天（目标 ' + input.targets[p] + ' 天，为保证双休做了 ±1 天浮动）');
            if (st.maxRun > rules.maxRun) v.push(st.cn + ' 最长连班 ' + st.maxRun + ' 天，超过上限 ' + rules.maxRun);
            for (var d = 0; d < T - 1; d++) {
                if (result.raw[p][d] === NIGHT && result.raw[p][d + 1] === DAY) {
                    v.push(st.cn + ' ' + input.dates[d].getDate() + '号小夜 → ' + input.dates[d + 1].getDate() + '号白班');
                }
            }
            // 双休（尽量满足）：单休不算违规，单独列出；含上期衔接的边界
            var cr = (input.carry && input.carry[p]) || [];
            for (var dr = 0; dr < T - 1; dr++) {
                if (result.raw[p][dr] !== OFF || input.fixed[p][dr] === FIX_LEAVE) continue;
                var lOff = dr > 0 ? result.raw[p][dr - 1] === OFF : (cr.length ? cr[cr.length - 1] === OFF : true);
                if (!lOff && result.raw[p][dr + 1] !== OFF) solo.push(st.cn + ' ' + dlabel(dr));
            }
            if (cr.length >= 2 && cr[cr.length - 1] === OFF && cr[cr.length - 2] !== OFF && result.raw[p][0] !== OFF) solo.push(st.cn + ' 上期最后一天单休（本期首日在班）');
            if (rules.nightToDayHard && cr.length && cr[cr.length - 1] === NIGHT && result.raw[p][0] === DAY) v.push(st.cn + ' 上期末小夜 → ' + dlabel(0) + ' 白班');
            for (var d2 = 0; d2 < T; d2++) {
                var f = input.fixed[p][d2];
                if ((f === FIX_REST || f === FIX_LEAVE) && result.raw[p][d2] !== OFF) v.push(st.cn + ' ' + input.dates[d2].getDate() + '号应休息但被排班');
                if (f === FIX_DAY && result.raw[p][d2] !== DAY) v.push(st.cn + ' ' + input.dates[d2].getDate() + '号未按要求上白班');
                if (f === FIX_NIGHT && result.raw[p][d2] !== NIGHT) v.push(st.cn + ' ' + input.dates[d2].getDate() + '号未按要求上夜班');
                if (f === FIX_DAY_IF_WORK && result.raw[p][d2] === NIGHT) v.push(st.cn + ' 周' + '一二三四五六日'.charAt((input.dates[d2].getDay() + 6) % 7) + '应白班，却排了夜班');
                if (f === FIX_NIGHT_IF_WORK && result.raw[p][d2] === DAY) v.push(st.cn + ' 周' + '一二三四五六日'.charAt((input.dates[d2].getDay() + 6) % 7) + '应夜班，却排了白班');
                if (f === FIX_WORK && result.raw[p][d2] === OFF) v.push(st.cn + ' ' + input.dates[d2].getDate() + '号要求上班，却排了休息');
            }
            // 天数类要求（自定义需求）
            (input.countReqs || []).forEach(function (cr) {
                if (cr.p !== p) return;
                var act = cr.kind === 'day' ? st.day : cr.kind === 'night' ? st.night : st.work;
                var bad = (cr.op === 'min' && act < cr.n) || (cr.op === 'max' && act > cr.n) || (cr.op === 'eq' && act !== cr.n);
                if (bad) v.push(st.cn + ' 自定义要求' + KIND_CN[cr.kind] + OP_CN[cr.op] + cr.n + '天，实际 ' + act + ' 天');
            });
            // 夜班平均（自定义需求）：允许均值 ±1 天
            if ((input.balance || []).indexOf('night') >= 0) {
                var avgN2 = input.nightTarget[p] || 0;
                var lo2 = Math.max(0, Math.floor(avgN2) - 1), hi2 = Math.ceil(avgN2) + 1;
                if (st.night < lo2 || st.night > hi2) v.push(st.cn + ' 夜班 ' + st.night + ' 天，未平均（要求 ' + lo2 + '~' + hi2 + ' 天）');
            }
        }
        for (var dd = 0; dd < T; dd++) {
            var ds = result.dayStats[dd];
            if (ds.day < rules.minDay) v.push(input.dates[dd].getDate() + '号白班 ' + ds.day + ' 人，低于最低 ' + rules.minDay);
            if (ds.night < rules.minNight) v.push(input.dates[dd].getDate() + '号夜班 ' + ds.night + ' 人，低于最低 ' + rules.minNight);
            if (ds.total > rules.maxStaff) v.push(input.dates[dd].getDate() + '号出勤 ' + ds.total + ' 人，超过上限 ' + rules.maxStaff);
            // 自定义需求里的每日人数规则
            (input.dayRules || []).forEach(function (r) {
                if (r.days.indexOf(dd) < 0) return;
                var act = r.kind === 'day' ? ds.day : r.kind === 'night' ? ds.night : ds.total;
                var bad = (r.op === 'min' && act < r.n) || (r.op === 'max' && act > r.n);
                if (bad) v.push(input.dates[dd].getDate() + '号自定义要求' + KIND_CN[r.kind] + OP_CN[r.op] + r.n + '人，实际 ' + act + ' 人');
            });
        }
        return { errors: v, notes: notes, solo: solo };
    }

    // ═══════════ Excel 导出（复刻现有排班表格式） ═══════════
    function exportXlsx(input, result, fileName) {
        if (typeof XLSX === 'undefined') return false;
        var T = input.dates.length, P = input.people.length;
        var aoa = [];
        var r1 = ['排班原则：最低保障每天白班2人夜班2人', '', ''];
        input.dates.forEach(function (d) { r1.push((d.getMonth() + 1) + '月' + d.getDate() + '日'); });
        aoa.push(r1);
        var r2 = ['企业名', '英文名', '中文名'];
        input.dates.forEach(function (d) { r2.push(weekdayCn(d)); });
        aoa.push(r2);
        for (var p = 0; p < P; p++) {
            var row = [input.people[p].org, input.people[p].en, input.people[p].cn];
            for (var d = 0; d < T; d++) row.push(result.grid[p][d]);
            // 个人汇总：白班 / 夜班 / 出勤 / 休
            var st = result.personStats[p];
            var c1 = 0, c3 = 0;
            for (var i = 0; i < T; i++) {
                var nm = result.grid[p][i];
                if (nm === '白班') c1++; else if (nm === '小夜班3') c3++;
            }
            row.push('', '', c1, c3, st.work, st.rest);
            LEAVE_TYPES.forEach(function (lt) { row.push(st.leaveDetail[lt] || 0); });
            aoa.push(row);
        }
        aoa.push(['备注', '', '', '夜班 = 小夜班3；最多 ' + input.rules.maxStaff + ' 人同时上班']);
        aoa.push([]); aoa.push([]); aoa.push([]);
        var sIdx = aoa.length;
        ['白班', '小夜班3', '日实际出勤', '休'].forEach(function (label) { aoa.push(['', '', label]); });
        for (var d2 = 0; d2 < T; d2++) {
            var c1n = 0, c3n = 0;
            for (var p2 = 0; p2 < P; p2++) {
                var v = result.grid[p2][d2];
                if (v === '白班') c1n++; else if (v === '小夜班3') c3n++;
            }
            aoa[sIdx][3 + d2] = c1n;
            aoa[sIdx + 1][3 + d2] = c3n;
            aoa[sIdx + 2][3 + d2] = result.dayStats[d2].total;
            aoa[sIdx + 3][3 + d2] = result.dayStats[d2].rest;
        }
        aoa.push([]);
        ['白班', '小夜班3'].forEach(function (k) { aoa.push([k, SHIFT_TIME[k]]); });
        aoa.push(['', '', '争议白班值班']);
        result.dayDuty.forEach(function (n, i) { aoa[aoa.length - 1][3 + i] = n; });
        aoa.push(['', '', '争议夜班值班']);
        result.nightDuty.forEach(function (n, i) { aoa[aoa.length - 1][3 + i] = n; });

        var ws = XLSX.utils.aoa_to_sheet(aoa);
        ws['!cols'] = [{ wch: 22 }, { wch: 14 }, { wch: 10 }];
        for (var c = 0; c < T; c++) ws['!cols'].push({ wch: 9 });
        for (var h = 0; h < 3 + T + 12; h++) ws['!cols'].push({ wch: 9 });

        // ── 样式（xlsx-js-style：单元格样式仅在该库生效，标准 SheetJS 会忽略）──
        var S = {
            title:   { font: { bold: true, sz: 12, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: '4472C4' } }, alignment: { horizontal: 'center', vertical: 'center' } },
            header:  { font: { bold: true, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: '5B9BD5' } }, alignment: { horizontal: 'center', vertical: 'center' } },
            weekend: { font: { bold: true, color: { rgb: 'C00000' } }, fill: { fgColor: { rgb: 'FCE4E4' } }, alignment: { horizontal: 'center' } },
            weekendF:{ fill: { fgColor: { rgb: 'FDF3F3' } } },
            name:    { font: { bold: true }, alignment: { horizontal: 'left' } },
            night:   { font: { color: { rgb: 'ED7D31' } }, alignment: { horizontal: 'center' } },
            rest:    { font: { color: { rgb: 'C00000' } }, alignment: { horizontal: 'center' } },
            leave:   { font: { color: { rgb: '7030A0' } }, alignment: { horizontal: 'center' } },
            day:     { alignment: { horizontal: 'center' } },
            stat:    { font: { bold: true }, fill: { fgColor: { rgb: 'F2F2F2' } }, alignment: { horizontal: 'center' } },
            note:    { font: { italic: true, color: { rgb: '808080' } } }
        };
        var lastCol = 3 + T + 12;
        function setCell(r, c, st) {
            var addr = XLSX.utils.encode_cell({ r: r, c: c });
            if (!ws[addr]) ws[addr] = { t: 'z' };
            ws[addr].s = st;
        }
        // 标题行 + 星期行
        for (var c0 = 0; c0 <= lastCol; c0++) { setCell(0, c0, S.title); setCell(1, c0, S.header); }
        // 周末列标红
        for (var d3 = 0; d3 < T; d3++) if (isWeekend(input.dates[d3])) setCell(1, 3 + d3, S.weekend);
        // 数据行
        for (var pr = 2; pr < 2 + P; pr++) {
            setCell(pr, 0, S.name); setCell(pr, 1, S.name); setCell(pr, 2, S.name);
            for (var d4 = 0; d4 < T; d4++) {
                var v4 = result.grid[pr - 2][d4];
                var st4 = v4 === '小夜班3' ? S.night : (v4 === '休' ? S.rest : (v4 === '白班' ? S.day : S.leave));
                if (isWeekend(input.dates[d4])) {
                    st4 = JSON.parse(JSON.stringify(st4)); // 深拷贝，保留字体色
                    st4.fill = { fgColor: { rgb: 'FDF3F3' } };
                }
                setCell(pr, 3 + d4, st4);
            }
            for (var sc = 3 + T; sc <= lastCol; sc++) setCell(pr, sc, S.stat);
        }
        // 备注行 + 统计区标签
        var noteRow = 2 + P;
        for (var nc = 0; nc <= lastCol; nc++) setCell(noteRow, nc, S.note);
        for (var sr = sIdx; sr < sIdx + 4; sr++) setCell(sr, 2, S.stat);
        setCell(aoa.length - 2, 2, S.stat);
        setCell(aoa.length - 1, 2, S.stat);

        var wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, '排班表');
        XLSX.writeFile(wb, fileName);
        return true;
    }

    // ══════════════════════════════════════════════════════
    //  以下为页面层（浏览器环境才会执行）
    // ══════════════════════════════════════════════════════
    var UI = { last: null, lastInput: null, customText: '' };

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function $(id) { return document.getElementById(id); }
    function el(tag, cls, text) {
        var e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    }

    function loadPeople() {
        try {
            var raw = localStorage.getItem('scheduler_people');
            if (raw) {
                var list = JSON.parse(raw);
                DEFAULT_PEOPLE.forEach(function (d) {
                    for (var i = 0; i < list.length; i++) {
                        if (list[i].en !== d.en) continue;
                        // 老存档只有结构化的 weekDay/weekNight，迁移成需求文字
                        if (list[i].need === undefined) {
                            var wd = list[i].weekDay || d.weekDay || '';
                            var wn = list[i].weekNight || d.weekNight || '';
                            var txt = [];
                            if (wd) txt.push('周' + wd.split(',').map(cnWeek).join('') + '白班');
                            if (wn) txt.push('周' + wn.split(',').map(cnWeek).join('') + '夜班');
                            list[i].need = txt.join('，') || (d.need || '');
                        }
                        if (list[i].need === OLD_DEFAULT_NEED) list[i].need = '';   // 旧版预置的固定需求，清空
                        list[i].prefer = '';                                         // 偏好只来自需求文字，不再保留旧版隐藏偏好
                        if (typeof list[i].nightBias !== 'number' && typeof d.nightBias === 'number') list[i].nightBias = d.nightBias;
                    }
                });
                return list;
            }
        } catch (e) { }
        return JSON.parse(JSON.stringify(DEFAULT_PEOPLE));
    }
    function savePeople(list) {
        try { localStorage.setItem('scheduler_people', JSON.stringify(list)); } catch (e) { }
    }
    // 自定义需求（全局，叠加到现有规则上）：单独存，不跟人员列表混在一起
    function loadCustom() {
        try { return localStorage.getItem('scheduler_custom_need') || ''; } catch (e) { return ''; }
    }
    function saveCustom() {
        try { localStorage.setItem('scheduler_custom_need', UI.customText || ''); } catch (e) { }
    }
    function loadRules() {
        try {
            var raw = localStorage.getItem('scheduler_rules');
            if (raw) {
                var r = JSON.parse(raw);
                // 旧存档默认是「小夜=软约束」，升级为硬性要求
                if (!r || r.v === undefined || r.v < 2) {
                    r = r || {};
                    r.nightToDayHard = true;
                    r.v = 2;
                    saveRules(r);
                }
                return r;
            }
        } catch (e) { }
        return JSON.parse(JSON.stringify(DEFAULT_RULES));
    }
    function saveRules(r) {
        try { localStorage.setItem('scheduler_rules', JSON.stringify(r)); } catch (e) { }
    }

    function previewDates() { try { return currentPeriod().dates; } catch (e) { return null; } }
    function renderPeopleTable() {
        var box = $('people-box');
        box.innerHTML = '';
        var tbl = el('table', 'sch-people');
        var thead = el('thead');
        var hr = el('tr');
        ['参与', '姓名', '需求（一句话写清楚就行）', '识别结果'].forEach(function (t) {
            var th = el('th', null, t); hr.appendChild(th);
        });
        thead.appendChild(hr); tbl.appendChild(thead);
        var tbody = el('tbody');
        UI.people.forEach(function (p, idx) {
            var tr = el('tr');
            if (!p.active) tr.style.opacity = '.45';

            var td0 = el('td'); var cb = el('input'); cb.type = 'checkbox'; cb.checked = !!p.active;
            cb.addEventListener('change', function () { p.active = cb.checked; savePeople(UI.people); renderPeopleTable(); });
            td0.appendChild(cb); tr.appendChild(td0);

            var td1 = el('td', null, p.cn); td1.style.fontWeight = '600'; tr.appendChild(td1);

            // 需求：一段话写清楚，输入时即时显示识别结果
            var td2 = el('td'); var inp = el('input');
            inp.type = 'text'; inp.value = p.need || '';
            inp.placeholder = '如：11月25日-27日年假，12月8、9号休，周四周五休，周末白班，其余夜班，尽量少上夜班';
            inp.style.cssText = 'width:100%;min-width:320px';
            var td3 = el('td', 'sch-need-preview');
            function refresh() {
                var n = parseNeedText(inp.value, previewDates());
                td3.textContent = describeNeed(n) || '—';
                td3.title = td3.textContent;
            }
            inp.addEventListener('input', function () { p.need = inp.value; savePeople(UI.people); refresh(); });
            td2.appendChild(inp); tr.appendChild(td2);
            refresh(); tr.appendChild(td3);
            tbody.appendChild(tr);
        });
        // ── 自定义需求：不绑定具体人，叠加到现有规则上（全员 / 点名某人 / 每日人数）──
        var ctr = el('tr', 'sch-custom-row');
        var ctd0 = el('td', null, '＋'); ctd0.title = '自定义需求：对全员生效，也可点名某人';
        ctr.appendChild(ctd0);
        var ctd1 = el('td', null, '自定义需求'); ctd1.style.fontWeight = '600'; ctr.appendChild(ctd1);
        var ctd2 = el('td'); var cinp = el('input');
        cinp.type = 'text'; cinp.value = UI.customText || '';
        cinp.placeholder = '如：12月31日不休；每天白班至少3人；吴超：12月1日-2日年假；周末上班最多4人';
        cinp.style.cssText = 'width:100%;min-width:320px';
        var ctd3 = el('td', 'sch-need-preview');
        function refreshCustom() {
            var c = parseCustomNeed(cinp.value, previewDates(), UI.people);
            ctd3.textContent = describeCustom(c) || '—';
            ctd3.title = ctd3.textContent;
        }
        cinp.addEventListener('input', function () { UI.customText = cinp.value; saveCustom(); refreshCustom(); });
        ctd2.appendChild(cinp); ctr.appendChild(ctd2);
        refreshCustom(); ctr.appendChild(ctd3);
        tbody.appendChild(ctr);
        tbl.appendChild(tbody);
        box.appendChild(tbl);
    }

    function renderRules() {
        var r = UI.rules;
        $('rule-minday').value = r.minDay;
        $('rule-minnight').value = r.minNight;
        $('rule-maxstaff').value = r.maxStaff;
        $('rule-maxrun').value = r.maxRun;
        $('rule-target').value = r.targetDays;
        if ($('rule-n2dh')) $('rule-n2dh').checked = !!r.nightToDayHard;
    }

    function currentPeriod() {
        var y = parseInt($('period-year').value, 10);
        var m = parseInt($('period-month').value, 10);
        return { year: y, month: m, dates: periodDates(y, m) };
    }

    function periodLabel(dates) {
        var a = dates[0], b = dates[dates.length - 1];
        return a.getFullYear() + '年' + (a.getMonth() + 1) + '月' + a.getDate() + '日 ~ ' +
            b.getFullYear() + '年' + (b.getMonth() + 1) + '月' + b.getDate() + '日（共 ' + dates.length + ' 天）';
    }

    // 跨周期衔接：读取上一周期已生成的排班
    // 返回 { carry, linked, gap }：linked=是否成功衔接上期，gap=与上期末的间隔天数
    // 间隔 1 天正常衔接；间隔 2~7 天视为有空档（空档按休息处理，仍衔接尾部班段）；
    // 无存档或间隔 >7 天则不衔接
    var CARRY_DAYS = 8;
    // 班表单元格 → 0 休/假 / 1 白 / 2 夜（正常班、早班2、白班都算白班；小夜班3、晚班算夜班）
    function shiftCode(v) {
        var t = String(v == null ? '' : v).trim();
        if (!t) return null;
        if (/(休|假|off|leave)/i.test(t)) return OFF;
        if (/(夜|晚|night)/i.test(t)) return NIGHT;
        return DAY;
    }
    // 列名是否为某一天：11月20日 / 11月20号 / 2026-11-20 / 2026/11/20 / 11/20
    function dateKeyMatch(key, d) {
        var k = String(key).trim(), y = d.getFullYear(), m = d.getMonth() + 1, dd = d.getDate(), x;
        if ((x = k.match(/^(\d{4})\s*[-\/.年]\s*(\d{1,2})\s*[-\/.月]\s*(\d{1,2})\s*[日号]?$/))) return +x[1] === y && +x[2] === m && +x[3] === dd;
        if ((x = k.match(/^(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?$/))) return +x[1] === m && +x[2] === dd;
        if ((x = k.match(/^(\d{1,2})[\/.](\d{1,2})$/))) return +x[1] === m && +x[2] === dd;
        return false;
    }
    // 从「数据导入」页导入的实际班表里取上期最后 8 天（实际执行的班次比本工具上次生成的更可靠，优先使用）
    function carryFromImported(people, dates) {
        var raw = localStorage.getItem('importedShiftData');
        if (!raw) return null;
        var rows = JSON.parse(raw);
        if (!Array.isArray(rows) || !rows.length) return null;
        var prevDays = [];
        for (var i = CARRY_DAYS; i >= 1; i--) { var d = new Date(dates[0].getTime()); d.setDate(d.getDate() - i); prevDays.push(d); }
        var keys = Object.keys(rows[0]);
        var colOf = prevDays.map(function (d) { for (var j = 0; j < keys.length; j++) if (dateKeyMatch(keys[j], d)) return keys[j]; return null; });
        if (!colOf[colOf.length - 1]) return null;   // 导入的班表必须包含本期首日的前一天
        var nameKeys = keys.filter(function (k) { return /(英文|中文|企业|姓名|名字)/.test(k); });
        if (!nameKeys.length) nameKeys = keys.filter(function (k) { return colOf.indexOf(k) < 0; }).slice(0, 3);
        var found = 0;
        var carry = people.map(function (p) {
            var row = null;
            for (var r = 0; r < rows.length && !row; r++) {
                for (var n = 0; n < nameKeys.length; n++) {
                    var v = String(rows[r][nameKeys[n]] || '').trim();
                    if (v && (v.toLowerCase() === String(p.en).toLowerCase() || v === p.cn || v === p.org)) { row = rows[r]; break; }
                }
            }
            if (!row) return [];
            var seq = [];
            colOf.forEach(function (k) {
                var c = k ? shiftCode(row[k]) : null;
                if (c === null) { seq = []; return; }   // 中间断档：只保留紧挨本期的连续几天
                seq.push(c);
            });
            if (seq.length) found++;
            return seq;
        });
        if (!found) return null;
        var missing = [];
        people.forEach(function (p, i) { if (!carry[i].length) missing.push(p.cn); });
        return { carry: carry, linked: true, gap: 1, source: 'import', days: colOf.filter(Boolean).length, missing: missing };
    }
    // 跨周期衔接。返回 { carry, linked, gap, source }：
    //   source=import：取自「数据导入」的实际班表；source=last：取自本工具上次生成的排班
    // 间隔 1 天正常衔接；间隔 2~7 天视为有空档（空档按休息处理）；无存档或间隔 >7 天则不衔接
    function loadCarry(people, dates) {
        var none = { carry: null, linked: false, gap: -1 };
        try { var imp = carryFromImported(people, dates); if (imp) return imp; } catch (e) { }
        try {
            var raw = localStorage.getItem('scheduler_last');
            if (!raw) return none;
            var last = JSON.parse(raw);
            // 原来判断的是 last.grid，但保存时只写了 dates/people/raw —— 导致上期存档永远读不到
            if (!last || !last.raw || !last.dates || !last.people) return none;
            var pk = String(last.dates[last.dates.length - 1]).split('-');
            var endPrev = new Date(+pk[0], +pk[1] - 1, +pk[2]);   // 按本地日期解析，避免 UTC 偏移
            var diff = Math.round((dates[0] - endPrev) / 86400000);
            if (diff < 1 || diff > 7) return none;
            var map = {};
            last.people.forEach(function (p, i) { map[p.en] = i; });
            var carry = [];
            people.forEach(function (p) {
                var i = map[p.en];
                if (i == null || !last.raw[i]) { carry.push([]); return; }
                var tail = last.raw[i].slice(-Math.min(CARRY_DAYS, last.raw[i].length));
                if (diff > 1) tail = tail.concat(new Array(diff - 1).fill(0));
                carry.push(tail);
            });
            return { carry: carry, linked: true, gap: diff, source: 'last' };
        } catch (e) { return none; }
    }

    function runSchedule() {
        var box = $('result-box');
        var sumBox = $('summary-box');
        var per = currentPeriod();
        var rules = UI.rules;
        var actives = UI.people.filter(function (p) { return p.active; });
        if (!actives.length) { notify('请至少勾选一位参与排班的人', 'error'); return; }
        if (actives.length < rules.minDay + rules.minNight) { notify('参与人数少于每日最低保障人数', 'error'); return; }
        if (UI.running) return;
        UI.running = true;
        $('period-label').textContent = periodLabel(per.dates);
        var btns = [$('btn-run'), $('btn-again')];
        btns.forEach(function (b) { if (b) b.disabled = true; });
        $('btn-run').textContent = '排班中…';
        box.classList.add('active');
        box.innerHTML = '<div class="sch-empty">⏳ 正在排班（精确求解，通常 5~30 秒）…</div>';
        try { box.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) { }
        // 把每人的需求文字翻译成排班约束（按本期日期解析；偏好只来自本期需求文字）
        var needNotes = [], invalid = [];
        actives.forEach(function (p) {
            var n = parseNeedText(p.need, per.dates);
            p.leave = n.leave.join(','); p.off = n.off.join(','); p.fix = n.fix.join(',');
            p.weekDay = n.weekDay.join(','); p.weekNight = n.weekNight.join(','); p.weekOff = n.weekOff.join(',');
            p.prefer = n.prefer || '';
            n.invalid.forEach(function (x) { invalid.push(p.cn + '：' + x); });
            n.notes.forEach(function (x) { needNotes.push(p.cn + '：' + x); });
        });
        // 自定义需求（全局）：叠加到现有规则上，不覆盖个人需求
        var custom = parseCustomNeed(UI.customText || '', per.dates, UI.people);
        custom.invalid.forEach(function (x) { invalid.push('自定义需求：' + x); });
        var carryInfo = loadCarry(actives, per.dates);
        var carry = carryInfo.carry;
        var finish = function () {
            UI.running = false;
            btns.forEach(function (b) { if (b) b.disabled = false; });
            $('btn-run').textContent = '⚡ 生成排班';
        };
        var show = function (input, res, engineNote) {
            if (!res.a) {
                box.innerHTML = '<div class="sch-empty">❌ ' + esc(res.reason || '无解') + '</div>';
                sumBox.classList.remove('active'); sumBox.innerHTML = '';
                UI.last = null;
                notify(res.reason || '无解', 'error');
                return;
            }
            var result = buildResult(input, res.a);
            var vs = validate(input, result);
            if (engineNote) vs.notes.unshift(engineNote);
            if (invalid.length) vs.notes.unshift('需求里有内容没识别，已忽略：' + invalid.join('；'));
            UI.last = { input: input, result: result, dates: per.dates, year: per.year, month: per.month };
            UI.lastInput = input;
            renderResult(input, result, per.dates);
            renderSummary(input, result, vs, carryInfo);
            try {
                localStorage.setItem('scheduler_last', JSON.stringify({
                    dates: per.dates.map(keyOf),
                    people: actives.map(function (p) { return { en: p.en, cn: p.cn }; }),
                    raw: res.a
                }));
            } catch (e) { }
            var nErr = vs.errors.length, nSolo = (vs.solo || []).length;
            notify(nErr ? '排班完成，但有 ' + nErr + ' 项要求无法满足，详见校验报告'
                : (nSolo ? '排班完成：硬性要求全部满足，有 ' + nSolo + ' 处单休（已尽量避免）' : '排班完成，全部要求满足'),
                nErr ? 'error' : 'success');
        };
        setTimeout(function () {
            var input;
            try { input = buildInput(per.dates, actives, rules, carry, { needNotes: needNotes, custom: custom }); }
            catch (err) { box.innerHTML = '<div class="sch-empty">❌ 求解出错：' + esc(err.message) + '</div>'; finish(); return; }
            solveExact(input).then(function (res) {
                show(input, res, res.engine === 'highs'
                    ? '精确求解用时 ' + (res.ms / 1000).toFixed(1) + ' 秒' + (res.status === 'Optimal' ? '' : '（已到时间上限，取当前最好方案）') : '');
            }, function (err) {
                // 精确求解不可用（highs 文件缺失 / 浏览器不支持 Worker）→ 退回原启发式算法
                var hin = buildInput(per.dates, actives, rules, carry, { heuristic: true, needNotes: needNotes, custom: custom });
                show(hin, solve(hin), '⚠ 精确求解不可用（' + ((err && err.message) || err) + '），已改用备用算法，结果可能有违规');
            }).catch(function (err) {
                box.innerHTML = '<div class="sch-empty">❌ 求解出错：' + esc((err && err.message) || String(err)) + '</div>';
            }).then(finish, finish);
        }, 30);
    }

    function renderResult(input, result, dates) {
        var box = $('result-box');
        box.classList.add('active');
        box.innerHTML = '';
        var wrap = el('div', 'sch-table-wrap');
        var tbl = el('table', 'sch-table');

        var thead = el('thead');
        var hr = el('tr');
        var th0 = el('th', 'sch-name-col', '姓名'); hr.appendChild(th0);
        dates.forEach(function (d) {
            var th = el('th', isWeekend(d) ? 'sch-we' : '', String(d.getDate()));
            th.title = keyOf(d) + ' ' + weekdayCn(d);
            hr.appendChild(th);
        });
        ['出勤', '休', '白班', '小夜', '最长连班'].forEach(function (t) {
            hr.appendChild(el('th', 'sch-sum-col', t));
        });
        thead.appendChild(hr); tbl.appendChild(thead);

        var tbody = el('tbody');
        result.grid.forEach(function (row, p) {
            var tr = el('tr');
            var td0 = el('td', 'sch-name-col', input.people[p].cn); tr.appendChild(td0);
            row.forEach(function (v, d) {
                var cls = 'sch-cell';
                if (v === '小夜班3') cls += ' night';
                else if (v === '休') cls += ' rest';
                else if (v === '白班') cls += ' day1';
                else cls += ' leave';
                var td = el('td', cls, shortName(v));
                td.title = keyOf(dates[d]) + ' ' + v;
                tr.appendChild(td);
            });
            var st = result.personStats[p];
            tr.appendChild(el('td', 'sch-sum-col', String(st.work)));
            tr.appendChild(el('td', 'sch-sum-col', String(st.rest)));
            tr.appendChild(el('td', 'sch-sum-col', String(st.day)));
            tr.appendChild(el('td', 'sch-sum-col', String(st.night)));
            var mr = el('td', 'sch-sum-col' + (st.maxRun > input.rules.maxRun ? ' bad' : ''), String(st.maxRun));
            tr.appendChild(mr);
            tbody.appendChild(tr);
        });
        tbl.appendChild(tbody);

        // 每日统计行
        var tfoot = el('tfoot');
        [['白班', function (s) { return s.day; }], ['夜班', function (s) { return s.night; }], ['合计', function (s) { return s.total; }]].forEach(function (pair) {
            var tr = el('tr', 'sch-stat-row');
            tr.appendChild(el('td', 'sch-name-col', pair[0]));
            result.dayStats.forEach(function (s) {
                var val = pair[1](s);
                var cls = 'sch-cell stat';
                if (pair[0] === '白班' && val < input.rules.minDay) cls += ' bad';
                if (pair[0] === '夜班' && val < input.rules.minNight) cls += ' bad';
                if (pair[0] === '合计' && val > input.rules.maxStaff) cls += ' bad';
                tr.appendChild(el('td', cls, String(val)));
            });
            for (var ec = 0; ec < 5; ec++) tr.appendChild(el('td', 'sch-sum-col', ''));
            tfoot.appendChild(tr);
        });
        // 争议值班行
        [['争议白班', result.dayDuty], ['争议夜班', result.nightDuty]].forEach(function (pair) {
            var tr = el('tr', 'sch-duty-row');
            tr.appendChild(el('td', 'sch-name-col', pair[0]));
            pair[1].forEach(function (n) { tr.appendChild(el('td', 'sch-cell duty', n ? n.slice(0, 3) : '')); });
            for (var ec = 0; ec < 5; ec++) tr.appendChild(el('td', 'sch-sum-col', ''));
            tfoot.appendChild(tr);
        });
        tbl.appendChild(tfoot);
        wrap.appendChild(tbl);
        box.appendChild(wrap);

        var legend = el('div', 'sch-legend');
        [['白班', 'day1'], ['小夜班3', 'night'], ['休', 'rest'], ['假', 'leave']].forEach(function (pair) {
            var item = el('span', 'sch-legend-item');
            var dot = el('i', 'sch-dot ' + pair[1]);
            item.appendChild(dot); item.appendChild(el('span', null, pair[0]));
            legend.appendChild(item);
        });
        box.appendChild(legend);
    }

    function shortName(v) {
        if (v === '白班') return '白';
        if (v === '小夜班3') return '小夜';
        if (v === '休') return '休';
        return v;
    }

    function renderSummary(input, result, violations, carryInfo) {
        var box = $('summary-box');
        box.classList.add('active');
        box.innerHTML = '';
        var errs = violations.errors || violations, notes = violations.notes || [];
        var solo = violations.solo || [];
        if (input.needNotes && input.needNotes.length) notes = notes.concat(input.needNotes);
        var head = el('div', 'sch-sum-title', '校验报告');
        box.appendChild(head);
        if (errs.length) {
            var ul = el('div', 'sch-violations');
            errs.slice(0, 20).forEach(function (v) { ul.appendChild(el('div', 'sch-violation', '⚠ ' + v)); });
            if (errs.length > 20) ul.appendChild(el('div', 'sch-violation', '…还有 ' + (errs.length - 20) + ' 项'));
            box.appendChild(ul);
            box.appendChild(el('div', 'sch-tip', '可以多点几次「换个排法」，挑一个违规为 0 的方案'));
        } else {
            box.appendChild(el('div', 'sch-ok', '✅ 全部硬约束满足：白班≥' + input.rules.minDay + '、夜班≥' + input.rules.minNight +
                '、同时上班≤' + input.rules.maxStaff + '、每人出勤' + input.rules.targetDays + '天、连班≤' + input.rules.maxRun +
                '、小夜后不上白班' + (solo.length ? '' : '、休息均为连续两天（双休）')));
        }
        if (solo.length) {
            var sl = el('div', 'sch-violations');
            sl.appendChild(el('div', 'sch-violation', '△ 以下 ' + solo.length + ' 处单休（双休实在排不开，已尽量避免）：' + solo.join('、')));
            box.appendChild(sl);
        }
        if (carryInfo && carryInfo.linked) {
            box.appendChild(el('div', 'sch-tip', carryInfo.source === 'import'
                ? '已按「数据导入」的实际班表衔接上期最后 ' + carryInfo.days + ' 天（连班、小夜→白班、双休跨期生效）' +
                  (carryInfo.missing && carryInfo.missing.length ? '；导入班表里没找到：' + carryInfo.missing.join('、') : '')
                : carryInfo.gap === 1
                ? '已衔接上一周期末尾班段（连班计数与小夜限制跨周期生效）'
                : '已衔接上一周期末尾班段（中间空档 ' + (carryInfo.gap - 1) + ' 天按休息处理）'));
        } else {
            box.appendChild(el('div', 'sch-tip', '⚠ 未找到上期班次：请先在「数据导入」导入包含上期最后几天的班表（或先排上一期），否则连班、小夜→白班、双休只在本期内检查'));
        }
        if (input.nightTarget) {
            var nb = [];
            result.personStats.forEach(function (s, i) {
                nb.push(s.cn + ' ' + s.night + '/' + input.nightTarget[i].toFixed(0));
            });
            box.appendChild(el('div', 'sch-tip', '夜班分配参考往期习惯（实际/目标）：' + nb.join('　')));
        }
        if (notes.length) {
            var nl = el('div', 'sch-notes');
            notes.forEach(function (n) { nl.appendChild(el('div', 'sch-note', '· ' + n)); });
            box.appendChild(nl);
        }

        var tbl = el('table', 'sch-table sch-mini');
        var hr = el('tr');
        ['姓名', '出勤', '休', '假', '白班', '小夜', '周末班', '最长连班'].forEach(function (t) { hr.appendChild(el('th', null, t)); });
        tbl.appendChild(hr);
        result.personStats.forEach(function (st) {
            var tr = el('tr');
            tr.appendChild(el('td', null, st.cn));
            tr.appendChild(el('td', null, String(st.work)));
            tr.appendChild(el('td', null, String(st.rest)));
            tr.appendChild(el('td', null, st.leave ? String(st.leave) : '-'));
            tr.appendChild(el('td', null, String(st.day)));
            tr.appendChild(el('td', null, String(st.night)));
            tr.appendChild(el('td', null, String(st.weekend)));
            tr.appendChild(el('td', null, String(st.maxRun)));
            tbl.appendChild(tr);
        });
        box.appendChild(tbl);
    }

    var _notifTimer = null;
    // 提示统一走 common.js 的全局提示框（挂在 body 下、样式在 head 里，切换模块也不会残留或错位）；
    // 单独打开 scheduler.html（没加载 common.js）时才用页面自带的提示条
    function notify(msg, type) {
        if (typeof DC !== 'undefined' && DC && typeof DC.showNotification === 'function' && (DC.VERSION || 0) >= 4) { DC.showNotification(msg, type || 'success'); return; }
        var n = $('sch-notification');
        if (!n) return;
        if (_notifTimer) clearTimeout(_notifTimer);
        n.className = 'sch-notify ' + (type || 'success');
        n.textContent = msg;
        void n.offsetWidth;
        n.classList.add('show');
        _notifTimer = setTimeout(function () { n.classList.remove('show'); }, 3000);
    }

    function doExport() {
        if (!UI.last) { notify('请先生成排班', 'error'); return; }
        var input = UI.last.input, result = UI.last.result;
        var name = '排班_' + input.dates[0].getFullYear() + '-' + pad(input.dates[0].getMonth() + 1) + '-' + pad(input.dates[0].getDate()) +
            '_' + pad(input.dates[input.dates.length - 1].getMonth() + 1) + '-' + pad(input.dates[input.dates.length - 1].getDate()) + '.xlsx';
        var ok = exportXlsx(input, result, name);
        notify(ok ? '已导出 ' + name : '导出失败：缺少 XLSX 库', ok ? 'success' : 'error');
    }
    function pad(n) { return n < 10 ? '0' + n : String(n); }

    function init() {
        if (!$('people-box')) return;
        var strays = document.querySelectorAll('body > #sch-notification');
        for (var si = 0; si < strays.length; si++) strays[si].parentNode.removeChild(strays[si]);
        UI.people = loadPeople();
        UI.rules = loadRules();
        UI.customText = loadCustom();

        // 周期选择（默认下一个周期：本月21号起算的结束月）
        var now = new Date();
        var sy = $('period-year'), sm = $('period-month');
        if (sy.options.length === 0) {
            for (var y = now.getFullYear() - 1; y <= now.getFullYear() + 2; y++) {
                var o = el('option', null, y + '年'); o.value = y; sy.appendChild(o);
            }
            for (var m = 1; m <= 12; m++) {
                var o2 = el('option', null, m + '月'); o2.value = m; sm.appendChild(o2);
            }
        }
        var endMonth = now.getDate() >= 21 ? now.getMonth() + 2 : now.getMonth() + 1;
        var endYear = now.getFullYear();
        if (endMonth > 12) { endMonth -= 12; endYear += 1; }
        sy.value = endYear; sm.value = endMonth;

        renderPeopleTable();
        renderRules();

        $('period-year').addEventListener('change', function () { $('period-label').textContent = periodLabel(currentPeriod().dates); renderPeopleTable(); });
        $('period-month').addEventListener('change', function () { $('period-label').textContent = periodLabel(currentPeriod().dates); renderPeopleTable(); });
        [['rule-minday', 'minDay'], ['rule-minnight', 'minNight'], ['rule-maxstaff', 'maxStaff'], ['rule-maxrun', 'maxRun'], ['rule-target', 'targetDays']].forEach(function (pair) {
            $(pair[0]).addEventListener('change', function () {
                var v = parseInt($(pair[0]).value, 10);
                if (!isNaN(v) && v > 0) { UI.rules[pair[1]] = v; saveRules(UI.rules); }
            });
        });
        var cbN2D = $('rule-n2dh');
        if (cbN2D) {
            cbN2D.addEventListener('change', function () {
                UI.rules.nightToDayHard = cbN2D.checked; saveRules(UI.rules);
                notify(cbN2D.checked ? '已把小夜约束设为硬约束（可能击穿白班下限）' : '已把小夜约束设为软约束（优先保证人数与双休）');
            });
        }
        $('btn-run').addEventListener('click', runSchedule);
        $('btn-again').addEventListener('click', runSchedule); // 换一组随机起点重排，挑违规最少的
        $('btn-export').addEventListener('click', doExport);
        $('btn-reset').addEventListener('click', function () {
            UI.rules = JSON.parse(JSON.stringify(DEFAULT_RULES));
            saveRules(UI.rules); renderRules(); notify('规则已恢复默认');
        });
        $('btn-restore').addEventListener('click', function () {
            UI.people = JSON.parse(JSON.stringify(DEFAULT_PEOPLE));
            savePeople(UI.people); renderPeopleTable(); notify('人员已恢复默认');
        });
        $('period-label').textContent = periodLabel(currentPeriod().dates);
    }

    return {
        LEAVE_TYPES: LEAVE_TYPES,
        DEFAULT_PEOPLE: DEFAULT_PEOPLE,
        DEFAULT_RULES: DEFAULT_RULES,
        periodDates: periodDates,
        buildInput: buildInput,
        precheck: precheck,
        solve: solve,
        solveExact: solveExact,
        loadHighs: loadHighs,
        openSolver: openSolver,
        loadCarry: loadCarry,
        MIP: MIP,
        buildResult: buildResult,
        validate: validate,
        exportXlsx: exportXlsx,
        parseNeedText: parseNeedText,
        describeNeed: describeNeed,
        parseCustomNeed: parseCustomNeed,
        describeCustom: describeCustom,
        init: init
    };
})();

if (typeof module !== 'undefined' && module.exports) { module.exports = SCH; }
if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { SCH.init(); });
    else SCH.init();
}
