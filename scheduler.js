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

    var HARD = 1000;
    // 软目标权重。「孤立单休」不是软目标 —— 休息必须连续两天，已按硬约束处理
    var W = {
        longRest: 12, run6: 15, segLen: 8,
        segMix: 2, allNight: 120, allDay: 8,
        nightBias: 4, weekendBal: 5, prefer: 3, sw: 2,
        // 「小夜后次日不上白班」降级为重罚软约束：在 7 人规模下它与
        // 「每天≥2 人夜班」互相冲突，硬卡死会导致整个班表无解。
        // 权重给得很高（仅次于硬违规），求解器仍极力避免，但必要时可让步。
        nightToDay: 900
    };

    // nightBias = 往期排班统计出来的「夜班占其出勤的比例」，用来让新排班延续每个人的习惯
    var DEFAULT_PEOPLE = [
        { en: 'kafewu', cn: '吴超', org: 'kafewu(吴超)', prefer: 'day', active: true, nightBias: 0.37 },
        { en: 'cuijunfang', cn: '崔俊芳', org: 'cuijunfang(崔俊芳)', prefer: '', active: false, nightBias: 0 },
        { en: 'nomadshi', cn: '石浩东', org: 'nomadshi (石浩东)', prefer: '', active: true, nightBias: 0.43 },
        { en: 'anweili', cn: '李安维', org: 'anweili(李安维)', prefer: '', active: true, nightBias: 0.50 },
        { en: 'hanleywang', cn: '王汉明', org: 'hanleywang(王汉明)', prefer: 'night', active: true, nightBias: 0.77 },
        { en: 'ventili', cn: '厉津睿', org: 'ventili(厉津睿)', prefer: 'night', active: true, nightBias: 0.62, need: '周四周五白班，其余夜班' },
        { en: 'zaklin', cn: '林国宇', org: 'zaklin(林国宇)', prefer: 'night', active: true, nightBias: 0.77, need: '周四周五白班，其余夜班' }
    ];

    // nightToDayHard：小夜后次日不上白班是否作为硬约束。
    // 默认 false（重罚软约束）—— 7 人规模下它与「每天≥2 人夜班」互斥，
    // 硬卡死会让整个班表无解，只能靠击穿白班人数下限来满足。
    var DEFAULT_RULES = { minDay: 2, minNight: 2, maxStaff: 5, maxRun: 6, targetDays: 21, nightToDayHard: false };

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

    // 从一句话里抽出日期：支持 24 / 24号 / 8、9号 / 8-9号（区间展开）/ 10-24 / 2026-10-24
    function extractDays(seg) {
        var out = [], m, i;
        var re0 = /(\d{4})\s*[-\/年]\s*(\d{1,2})\s*[-\/月]\s*(\d{1,2})/g;
        while ((m = re0.exec(seg))) out.push(m[1] + '-' + (+m[2]) + '-' + (+m[3]));
        var rest = seg.replace(re0, ' ');
        var re1 = /(\d{1,2})\s*[-~至到]\s*(\d{1,2})/g;
        while ((m = re1.exec(rest))) {
            var a = parseInt(m[1], 10), b = parseInt(m[2], 10);
            if (a <= 12 && b > 12) out.push(a + '-' + b);                       // 10-24 → 10月24日
            else if (a <= b) { for (i = a; i <= b; i++) out.push(String(i)); }   // 8-9 → 8号、9号
            else { for (i = a; i >= b; i--) out.push(String(i)); }
        }
        rest = rest.replace(re1, ' ');
        var re2 = /(\d{1,2})\s*[号日]?/g;
        while ((m = re2.exec(rest))) out.push(String(parseInt(m[1], 10)));
        return dedup(out);
    }

    function parseNeedText(text) {
        var r = { leave: [], off: [], fix: [], weekDay: [], weekNight: [], prefer: '', nightAll: false };
        if (!text) return r;
        var segs = String(text).split(/[,，。;；\n\r]+/);   // 顿号留给「8、9号休」这种并列日期
        for (var i = 0; i < segs.length; i++) {
            var seg = segs[i].trim();
            if (!seg) continue;

            // ① 星期 + 班次：「周四周五白班」「每周六、日 夜班」
            if (/(周|星期)/.test(seg) && /(白|夜)/.test(seg)) {
                var wds = [], m;
                var re = /(?:周|星期)?([一二三四五六日1-7])/g;
                while ((m = re.exec(seg))) { var w = WD_MAP[m[1]]; if (w) wds.push(w); }
                if (wds.length) {
                    if (/夜/.test(seg)) r.weekNight = dedup(r.weekNight.concat(wds));
                    else r.weekDay = dedup(r.weekDay.concat(wds));
                }
                continue;
            }
            // ② 「其余夜班 / 其余白班」
            if (/(其余|其他|其它|剩下|别的)/.test(seg) && /(白|夜)/.test(seg)) {
                if (/白/.test(seg)) r.dayAll = true; else r.nightAll = true;
                continue;
            }
            // ③ 偏好：「尽量少上夜班」「想上白班」
            if (/(想|希望|尽量|倾向|偏好|最好|优先|少上|多上|不想|避免)/.test(seg) && /(白|夜)/.test(seg)) {
                var neg = /少上|不想|避免|尽量不/.test(seg);
                var wantNight = /夜/.test(seg);
                if (neg) r.prefer = wantNight ? 'day' : 'night';       // 「少上夜班」= 偏白班
                else r.prefer = wantNight ? 'night' : (/白/.test(seg) ? 'day' : '');
                continue;
            }
            // ④ 日期 + 事项
            var type = '';
            for (var k = 0; k < LEAVE_WORDS.length; k++) { if (seg.indexOf(LEAVE_WORDS[k]) >= 0) { type = LEAVE_WORDS[k]; break; } }
            if (!type && /请假/.test(seg)) type = '事假';
            // 班次名里的数字（小夜班3 / 早班2）别当成日期
            var days = extractDays(seg.replace(/小夜班\s*3/g, '夜班').replace(/早班\s*2/g, '早班'));
            if (!days.length) continue;
            if (type) { days.forEach(function (d) { r.leave.push(d + ':' + type); }); continue; }
            if (/休息|休/.test(seg)) { r.off = dedup(r.off.concat(days)); continue; }
            if (/夜班|小夜|夜/.test(seg)) { days.forEach(function (d) { r.fix.push(d + ':小夜班3'); }); continue; }
            if (/白班|早班|白/.test(seg)) { days.forEach(function (d) { r.fix.push(d + ':白班'); }); continue; }
        }
        // 「其余夜班 / 其余白班」＝ 除已指定星期以外的所有星期
        if (r.nightAll && !r.weekNight.length) {
            for (var w2 = 1; w2 <= 7; w2++) if (r.weekDay.indexOf(w2) < 0) r.weekNight.push(w2);
        }
        if (r.dayAll && !r.weekDay.length) {
            for (var w3 = 1; w3 <= 7; w3++) if (r.weekNight.indexOf(w3) < 0) r.weekDay.push(w3);
        }
        r.leave = dedup(r.leave); r.fix = dedup(r.fix);
        return r;
    }

    function cnWeek(n) { return ['', '一', '二', '三', '四', '五', '六', '日'][parseInt(n, 10)] || ''; }

    // 把解析结果翻译成人话，给用户输入时即时确认
    function describeNeed(n) {
        var parts = [];
        if (n.leave.length) parts.push('假 ' + n.leave.join('、'));
        if (n.off.length) parts.push('休 ' + n.off.join('、') + '号');
        if (n.fix.length) parts.push('指定 ' + n.fix.join('、'));
        if (n.weekDay.length) parts.push('周' + n.weekDay.map(cnWeek).join('') + '白班');
        if (n.weekNight.length) parts.push('周' + n.weekNight.map(cnWeek).join('') + '夜班');
        if (n.prefer) parts.push(n.prefer === 'day' ? '偏白班' : '偏夜班');
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
    // people: [{cn,en,org,prefer,target,leave,off,fix}]  （active 已过滤）
    function buildInput(dates, people, rules, carry) {
        var P = people.length, T = dates.length;
        var fixed = [], leaveName = [], targets = [], prefers = [], nightBias = [];
        for (var p = 0; p < P; p++) {
            var fp = new Array(T).fill(FIX_FREE);
            var ln = new Array(T).fill('');
            var pe = people[p];
            parseEntries(pe.leave, dates, true).forEach(function (e) {
                fp[e.idx] = FIX_LEAVE;
                ln[e.idx] = e.value || '事假';
            });
            parseEntries(pe.off, dates, false).forEach(function (e) { fp[e.idx] = FIX_REST; });
            parseEntries(pe.fix, dates, true).forEach(function (e) {
                var v = String(e.value || '').trim();
                if (v.indexOf('夜') >= 0 || v.indexOf('小夜') >= 0) fp[e.idx] = FIX_NIGHT;
                else fp[e.idx] = FIX_DAY;
            });
            // 按星期固定班次（只在上班日生效，休息日不受影响）
            var wdDay = parseWeekdays(pe.weekDay), wdNight = parseWeekdays(pe.weekNight);
            for (var w = 0; w < T; w++) {
                if (fp[w] !== FIX_FREE) continue;
                var dow = dates[w].getDay();
                if (wdDay[dow]) fp[w] = FIX_DAY_IF_WORK;
                else if (wdNight[dow]) fp[w] = FIX_NIGHT_IF_WORK;
            }
            // 派生必休：某天固定白班，而前一天固定夜班 → 前一天只能休息（否则违反「小夜后不上白班」）
            for (var dv = 1; dv < T; dv++) {
                if (fp[dv] === FIX_DAY_IF_WORK && fp[dv - 1] === FIX_NIGHT_IF_WORK) fp[dv - 1] = FIX_REST;
            }
            // 注：不把「必休日」的前一天也强制设为休息 —— 那样两个人会在同一天休，
            // 当天上班人数就凑不够 4 人。改由构造阶段把他们的休息段错开（周二三 / 周三四）。
            if (fp[0] === FIX_DAY_IF_WORK && carry && carry[p] && carry[p].length && carry[p][carry[p].length - 1] === 2) fp[0] = FIX_REST;

            fixed.push(fp); leaveName.push(ln);
            targets.push(pe.target || rules.targetDays);
            nightBias.push(typeof pe.nightBias === 'number' ? pe.nightBias : 0.5);
            prefers.push(pe.prefer || '');
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

        return {
            dates: dates, people: people, rules: rules,
            nightTarget: nightTarget,
            fixed: fixed, leaveName: leaveName, targets: targets,
            prefers: prefers,
            weekend: dates.map(isWeekend),
            carry: carry || null
        };
    }

    // ═══════════ 可行性预检 ═══════════
    function precheck(input) {
        var T = input.dates.length, P = input.people.length;
        var rules = input.rules;
        var minTotal = rules.minDay + rules.minNight;
        var total = 0;
        for (var p = 0; p < P; p++) {
            var leaveCnt = 0, restCnt = 0;
            for (var d = 0; d < T; d++) {
                if (input.fixed[p][d] === FIX_LEAVE) leaveCnt++;
                if (input.fixed[p][d] === FIX_REST) restCnt++;
            }
            var tg = input.targets[p];
            total += tg;
            if (tg > T - leaveCnt - restCnt) {
                return { ok: false, reason: input.people[p].cn + '：需上班 ' + tg + ' 天，但请假 ' + leaveCnt + ' 天 + 指定休息 ' + restCnt + ' 天后只剩 ' + (T - leaveCnt - restCnt) + ' 天，排不下' };
            }
        }
        if (total < minTotal * T) {
            return { ok: false, reason: '总出勤 ' + total + ' 人次 < 最低保障需求 ' + minTotal * T + ' 人次（' + T + '天 × ' + minTotal + '人）' };
        }
        if (total > rules.maxStaff * T) {
            return { ok: false, reason: '总出勤 ' + total + ' 人次 > 容量上限 ' + rules.maxStaff * T + ' 人次（' + T + '天 × 最多' + rules.maxStaff + '人）' };
        }
        if (rules.minNight * T > total - rules.minDay * T) {
            return { ok: false, reason: '夜班最低需求（' + rules.minNight * T + ' 人次）与白班最低需求冲突，请下调最低人数或增加出勤天数' };
        }
        // 指定班次 vs 请假冲突
        for (var q = 0; q < P; q++) {
            for (var dd = 0; dd < T; dd++) {
                if (input.fixed[q][dd] >= FIX_DAY && input.fixed[q][dd] <= FIX_NIGHT) {
                    if (input.fixed[q][dd] === FIX_DAY && input.leaveName[q][dd]) {
                        return { ok: false, reason: input.people[q].cn + '：' + input.dates[dd].getDate() + '号同时填了请假和指定班次' };
                    }
                }
            }
        }
        return { ok: true, total: total, minTotal: minTotal };
    }

    // ═══════════ 求解器 ═══════════
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
        if (nt) soft += Math.abs(night - nt) * W.nightBias;
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
            if (nt) soft += Math.abs(night - nt) * W.nightBias;
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
                    if (wf === FIX_DAY || wf === FIX_NIGHT || wf === FIX_REST || wf === FIX_LEAVE) continue;
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
        for (var a = 0; a < 120 && feasibles.length < 5; a++) {
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
        for (var b = 0; b < Math.min(10, pool.length) && feasibles.length < 5; b++) {
            var st = pool[b].st, cc = pool[b].cost;
            for (var att = 0; att < 120 && cc.hard > 0; att++) {
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
                night: night, weekend: weekend, maxRun: maxRun
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
        var v = [], notes = [];
        var rules = input.rules;
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
            // 双休：休息日必须连着休两天（请假日不计）
            for (var dr = 1; dr < T - 1; dr++) {
                if (result.raw[p][dr] !== OFF) continue;
                if (input.fixed[p][dr] === FIX_LEAVE) continue;
                if (result.raw[p][dr - 1] !== OFF && result.raw[p][dr + 1] !== OFF) {
                    v.push(st.cn + ' ' + input.dates[dr].getDate() + '号是单休（前后都上班），未保证双休');
                }
            }
            for (var d2 = 0; d2 < T; d2++) {
                var f = input.fixed[p][d2];
                if ((f === FIX_REST || f === FIX_LEAVE) && result.raw[p][d2] !== OFF) v.push(st.cn + ' ' + input.dates[d2].getDate() + '号应休息但被排班');
                if (f === FIX_DAY && result.raw[p][d2] !== DAY) v.push(st.cn + ' ' + input.dates[d2].getDate() + '号未按要求上白班');
                if (f === FIX_NIGHT && result.raw[p][d2] !== NIGHT) v.push(st.cn + ' ' + input.dates[d2].getDate() + '号未按要求上夜班');
                if (f === FIX_DAY_IF_WORK && result.raw[p][d2] === NIGHT) v.push(st.cn + ' 周' + '一二三四五六日'.charAt((input.dates[d2].getDay() + 6) % 7) + '应白班，却排了夜班');
                if (f === FIX_NIGHT_IF_WORK && result.raw[p][d2] === DAY) v.push(st.cn + ' 周' + '一二三四五六日'.charAt((input.dates[d2].getDay() + 6) % 7) + '应夜班，却排了白班');
            }
        }
        for (var dd = 0; dd < T; dd++) {
            var ds = result.dayStats[dd];
            if (ds.day < rules.minDay) v.push(input.dates[dd].getDate() + '号白班 ' + ds.day + ' 人，低于最低 ' + rules.minDay);
            if (ds.night < rules.minNight) v.push(input.dates[dd].getDate() + '号夜班 ' + ds.night + ' 人，低于最低 ' + rules.minNight);
            if (ds.total > rules.maxStaff) v.push(input.dates[dd].getDate() + '号出勤 ' + ds.total + ' 人，超过上限 ' + rules.maxStaff);
        }
        return { errors: v, notes: notes };
    }

    // ═══════════ Excel 导出（复刻现有排班表格式） ═══════════
    function exportXlsx(input, result, fileName) {
        if (typeof XLSX === 'undefined') return false;
        var T = input.dates.length, P = input.people.length;
        var aoa = [];
        var r1 = ['排班原则：最低保障每天白班2人夜班2人', '', ''];
        input.dates.forEach(function (d) { r1.push(keyOf(d)); });
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
    var UI = { last: null, lastInput: null };

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
    function loadRules() {
        try {
            var raw = localStorage.getItem('scheduler_rules');
            if (raw) return JSON.parse(raw);
        } catch (e) { }
        return JSON.parse(JSON.stringify(DEFAULT_RULES));
    }
    function saveRules(r) {
        try { localStorage.setItem('scheduler_rules', JSON.stringify(r)); } catch (e) { }
    }

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
            inp.placeholder = '如：24号年假，8、9号休，15号白班，周四周五白班，其余夜班';
            inp.style.cssText = 'width:100%;min-width:320px';
            var td3 = el('td', 'sch-need-preview');
            function refresh() {
                var n = parseNeedText(inp.value);
                td3.textContent = describeNeed(n) || '—';
                td3.title = td3.textContent;
            }
            inp.addEventListener('input', function () { p.need = inp.value; savePeople(UI.people); refresh(); });
            td2.appendChild(inp); tr.appendChild(td2);
            refresh(); tr.appendChild(td3);
            tbody.appendChild(tr);
        });
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
    function loadCarry(people, dates) {
        var none = { carry: null, linked: false, gap: -1 };
        try {
            var raw = localStorage.getItem('scheduler_last');
            if (!raw) return none;
            var last = JSON.parse(raw);
            if (!last || !last.grid || !last.dates) return none;
            var endPrev = new Date(last.dates[last.dates.length - 1]);
            var startCur = dates[0];
            var diff = Math.round((startCur - endPrev) / 86400000);
            if (diff < 1 || diff > 7) return none; // 非相邻/近邻周期，不衔接
            var map = {};
            last.people.forEach(function (p, i) { map[p.en] = i; });
            var carry = [];
            people.forEach(function (p) {
                var i = map[p.en];
                if (i == null || !last.raw || !last.raw[i]) { carry.push([]); return; }
                var tail = last.raw[i].slice(-Math.min(8, last.raw[i].length));
                // 有空档时，把空档天按休息（0）补进衔接段，避免误判连班
                if (diff > 1) tail = tail.concat(new Array(diff - 1).fill(0));
                carry.push(tail);
            });
            return { carry: carry, linked: true, gap: diff };
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
        $('period-label').textContent = periodLabel(per.dates);
        $('btn-run').disabled = true;
        $('btn-run').textContent = '排班中…';
        // 结果区默认 display:none，必须点亮 active 才能显示预览
        box.classList.add('active');
        box.innerHTML = '<div class="sch-empty">⏳ 正在排班…</div>';
        try { box.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) { }
        setTimeout(function () {
            try {
                // 把每人的需求文字翻译成排班约束
                actives.forEach(function (p) {
                    var n = parseNeedText(p.need);
                    p.leave = n.leave.join(',');
                    p.off = n.off.join(',');
                    p.fix = n.fix.join(',');
                    p.weekDay = n.weekDay.join(',');
                    p.weekNight = n.weekNight.join(',');
                    if (n.prefer) p.prefer = n.prefer;
                });
                var carryInfo = loadCarry(actives, per.dates);
                var carry = carryInfo.carry;
                var input = buildInput(per.dates, actives, rules, carry);
                var res = solve(input);
                if (!res.a) {
                    // 需求本身自相矛盾（预检就过不去），没有可展示的班表
                    box.innerHTML = '<div class="sch-empty">❌ ' + esc(res.reason || '无解') + '</div>';
                    sumBox.classList.remove('active');
                    sumBox.innerHTML = '';
                    UI.last = null;
                    notify(res.reason || '无解', 'error');
                    return;
                }
                var result = buildResult(input, res.a);
                var vs = validate(input, result);
                UI.last = { input: input, result: result, dates: per.dates, year: per.year, month: per.month };
                UI.lastInput = input;
                renderResult(input, result, per.dates);
                renderSummary(input, result, vs, carryInfo);
                // 保存结果用于下期衔接
                try {
                    localStorage.setItem('scheduler_last', JSON.stringify({
                        dates: per.dates.map(keyOf),
                        people: actives.map(function (p) { return { en: p.en, cn: p.cn }; }),
                        raw: res.a
                    }));
                } catch (e) { }
                notify((vs.errors || vs).length
                    ? '排班完成，但有 ' + (vs.errors || vs).length + ' 项未满足，可再点「换个排法」'
                    : '排班完成，全部约束满足', (vs.errors || vs).length ? 'error' : 'success');
            } catch (err) {
                box.innerHTML = '<div class="sch-empty">❌ 求解出错：' + esc(err.message) + '</div>';
            } finally {
                $('btn-run').disabled = false;
                $('btn-run').textContent = '⚡ 生成排班';
            }
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
        ['出勤', '休', '小夜', '最长连班'].forEach(function (t) {
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
            tr.appendChild(el('td', 'sch-sum-col', '')); tr.appendChild(el('td', 'sch-sum-col', ''));
            tr.appendChild(el('td', 'sch-sum-col', '')); tr.appendChild(el('td', 'sch-sum-col', ''));
            tfoot.appendChild(tr);
        });
        // 争议值班行
        [['争议白班', result.dayDuty], ['争议夜班', result.nightDuty]].forEach(function (pair) {
            var tr = el('tr', 'sch-duty-row');
            tr.appendChild(el('td', 'sch-name-col', pair[0]));
            pair[1].forEach(function (n) { tr.appendChild(el('td', 'sch-cell duty', n ? n.slice(0, 3) : '')); });
            tr.appendChild(el('td', 'sch-sum-col', '')); tr.appendChild(el('td', 'sch-sum-col', ''));
            tr.appendChild(el('td', 'sch-sum-col', '')); tr.appendChild(el('td', 'sch-sum-col', ''));
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
                '、小夜后不上白班、休息均为连续两天（双休）'));
        }
        if (carryInfo && carryInfo.linked) {
            box.appendChild(el('div', 'sch-tip', carryInfo.gap === 1
                ? '已衔接上一周期末尾班段（连班计数与小夜限制跨周期生效）'
                : '已衔接上一周期末尾班段（中间空档 ' + (carryInfo.gap - 1) + ' 天按休息处理）'));
        } else {
            box.appendChild(el('div', 'sch-tip', '⚠ 未找到相邻的上期排班存档，本期未做跨周期衔接（连班计数与小夜限制仅在本周期内生效）'));
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
        ['姓名', '出勤', '休', '假', '小夜', '周末班', '最长连班'].forEach(function (t) { hr.appendChild(el('th', null, t)); });
        tbl.appendChild(hr);
        result.personStats.forEach(function (st) {
            var tr = el('tr');
            tr.appendChild(el('td', null, st.cn));
            tr.appendChild(el('td', null, String(st.work)));
            tr.appendChild(el('td', null, String(st.rest)));
            tr.appendChild(el('td', null, st.leave ? String(st.leave) : '-'));
            tr.appendChild(el('td', null, String(st.night)));
            tr.appendChild(el('td', null, String(st.weekend)));
            tr.appendChild(el('td', null, String(st.maxRun)));
            tbl.appendChild(tr);
        });
        box.appendChild(tbl);
    }

    var _notifTimer = null;
    function notify(msg, type) {
        var n = $('sch-notification');
        if (!n) return;
        // 子页面容器带 transform 动画，fixed 定位会相对它而不是视口 → 错位。
        // 把通知挂到 body 直下就没这个问题
        if (n.parentNode !== document.body) {
            var olds = document.body.querySelectorAll('#sch-notification');
            for (var i = 0; i < olds.length; i++) if (olds[i] !== n) olds[i].parentNode.removeChild(olds[i]);
            document.body.appendChild(n);
        }
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
        UI.people = loadPeople();
        UI.rules = loadRules();

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

        $('period-year').addEventListener('change', function () { $('period-label').textContent = periodLabel(currentPeriod().dates); });
        $('period-month').addEventListener('change', function () { $('period-label').textContent = periodLabel(currentPeriod().dates); });
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
        buildResult: buildResult,
        validate: validate,
        exportXlsx: exportXlsx,
        parseNeedText: parseNeedText,
        describeNeed: describeNeed,
        init: init
    };
})();

if (typeof module !== 'undefined' && module.exports) { module.exports = SCH; }
if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { SCH.init(); });
    else SCH.init();
}
