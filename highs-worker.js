/* ═══════════════════════════════════════════════════════════════
   highs-worker.js — 排班精确求解线程
   浏览器：scheduler.js 每次排班 new Worker('highs-worker.js')，排完即 terminate（释放 wasm 内存）
   Node：  单元测试用 child_process.fork 启动，同样的消息协议
   消息：  { id, lp: CPLEX LP 文本, options } → { id, result } | { id, error }
   依赖：  同目录 highs.js + highs.wasm（HiGHS，MIT 许可，见 HIGHS-LICENSE）
   ═══════════════════════════════════════════════════════════════ */
(function () {
    'use strict';
    var isNode = typeof process !== 'undefined' && process.versions && process.versions.node && typeof self === 'undefined';
    var factory, ready = null;
    if (isNode) {
        factory = require('./highs.js');
    } else {
        importScripts('highs.js');
        factory = self.Module;
    }
    function getHighs() {
        if (!ready) {
            ready = factory({
                locateFile: function (f) {
                    if (isNode) return require('path').join(__dirname, f);
                    return new URL(f, self.location.href).href;
                }
            });
        }
        return ready;
    }
    function handle(msg, reply) {
        if (!msg || msg.lp == null) return;
        getHighs().then(function (highs) {
            var res = highs.solve(msg.lp, msg.options || {});
            // 只回传需要的字段，避免结构化克隆不必要的大对象
            var cols = {};
            Object.keys(res.Columns || {}).forEach(function (k) { cols[k] = { Primal: res.Columns[k].Primal }; });
            reply({ id: msg.id, result: { Status: res.Status, ObjectiveValue: res.ObjectiveValue, Columns: cols } });
        }).catch(function (e) {
            reply({ id: msg.id, error: (e && e.message) ? e.message : String(e) });
        });
    }
    if (isNode) {
        process.on('message', function (m) { handle(m, function (r) { process.send(r); }); });
    } else {
        self.onmessage = function (ev) { handle(ev.data, function (r) { self.postMessage(r); }); };
    }
})();
