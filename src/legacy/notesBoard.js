/* 便签画板（画笔 + 文字 + 粘贴图片）：由 v1 index.html 原样迁移的遗留模块，阶段 2b 再改写为 Vue 组件。
   v2 变更：全局监听统一经 __on 登记，unmountBoard() 时全部移除（v1 每次进入页面都会累积监听）。 */
import { toast } from '../core/notify'
var __offs = [];
function __on(t, ev, fn, opt) { t.addEventListener(ev, fn, opt); __offs.push(function () { t.removeEventListener(ev, fn, opt); }); }
// ═══════════ 便签画板（画笔 + 文字备忘录） ═══════════
var board = {
  canvas: null, ctx: null, stage: null, panel: null,
  color: '#4f8ef7', size: 3, eraser: false, drawing: false, lastX: 0, lastY: 0,
  hasContent: false
};

function initBoard(){
  board.canvas = document.getElementById('board-canvas');
  if (!board.canvas) return;
  board.ctx = board.canvas.getContext('2d');
  board.stage = document.getElementById('board-stage');
  board.panel = document.getElementById('blank-canvas');
  var cv = board.canvas;

  // 模式切换
  var modeBtns = document.querySelectorAll('.board-mode-btn');
  var drawTools = document.getElementById('draw-tools');
  var textTools = document.getElementById('text-tools');
  modeBtns.forEach(function(btn){
    btn.addEventListener('click', function(){
      var mode = btn.getAttribute('data-mode');
      modeBtns.forEach(function(b){ b.classList.toggle('active', b === btn); });
      if (mode === 'text'){
        board.panel.classList.add('text');
        drawTools.style.display = 'none';
        textTools.style.display = 'flex';
        document.getElementById('board-hint').style.display = 'none';
      } else {
        board.panel.classList.remove('text');
        drawTools.style.display = 'flex';
        textTools.style.display = 'none';
        document.getElementById('board-hint').style.display = board.hasContent ? 'none' : '';
        updateEraserCursor();
        setTimeout(resizeBoard, 0);
      }
    });
  });

  // 颜色调色盘
  var colorInput = document.getElementById('board-color');
  var colorSwatch = document.getElementById('board-color-swatch');
  if (colorInput && colorSwatch){
    colorInput.addEventListener('input', function(e){
      board.color = e.target.value;
      board.eraser = false;
      document.getElementById('board-eraser').classList.remove('active');
      colorSwatch.style.background = board.color;
    });
  }

  // 备忘录文字颜色（具体应用到 memo 在 memo 定义之后）
  var textColorInput = document.getElementById('board-text-color');
  var textColorSwatch = document.getElementById('board-text-color-swatch');
  if (textColorInput && textColorSwatch){
    textColorInput.addEventListener('input', function(e){
      applyMemoColor(e.target.value);
      try { localStorage.setItem('board_memo_color', e.target.value); } catch(err){}
    });
  }

  // 橡皮擦
  var eraserBtn = document.getElementById('board-eraser');
  var boardCursor = document.getElementById('board-cursor');
  function updateEraserCursor(){
    if (!boardCursor) return;
    if (board.eraser){
      board.canvas.style.cursor = 'none';
      boardCursor.style.display = 'block';
      boardCursor.style.width = boardCursor.style.height = Math.max(board.size, 22) + 'px';
    } else {
      board.canvas.style.cursor = 'crosshair';
      boardCursor.style.display = 'none';
    }
  }
  if (eraserBtn && boardCursor){
  eraserBtn.addEventListener('click', function(){
    board.eraser = !board.eraser;
    eraserBtn.classList.toggle('active', board.eraser);
    updateEraserCursor();
  });
  // 圆形橡皮擦光标跟随鼠标
  cv.addEventListener('mousemove', function(e){
    if (!board.eraser) return;
    var rect = board.stage.getBoundingClientRect();
    boardCursor.style.left = (e.clientX - rect.left) + 'px';
    boardCursor.style.top = (e.clientY - rect.top) + 'px';
    boardCursor.style.width = boardCursor.style.height = Math.max(board.size, 22) + 'px';
  });
  cv.addEventListener('mouseleave', function(){ boardCursor.style.display = 'none'; });
  cv.addEventListener('mouseenter', function(){ if (board.eraser) boardCursor.style.display = 'block'; });
  // 粗细变化同步橡皮擦光标大小
  document.getElementById('board-size').addEventListener('input', function(e){
    board.size = parseInt(e.target.value, 10);
    if (board.eraser && boardCursor) boardCursor.style.width = boardCursor.style.height = Math.max(board.size, 22) + 'px';
  });
  } // end eraser guard

  // 清空
  document.getElementById('board-clear').addEventListener('click', function(){
    if (board.panel.classList.contains('text')){
      document.getElementById('board-memo').value = '';
      saveMemo();
      document.getElementById('board-hint').style.display = '';
    } else {
      clearBoardCanvas();
    }
  });

  // 文字备忘录
  var memo = document.getElementById('board-memo');
  memo.value = localStorage.getItem('board_memo') || '';
  memo.addEventListener('input', function(){
    saveMemo();
    document.getElementById('board-hint').style.display = memo.value ? 'none' : '';
  });
  if (memo.value) document.getElementById('board-hint').style.display = 'none';
  applyMemoColor(localStorage.getItem('board_memo_color') || '');

  // 粘贴图片功能
  initPastedImages();

  // 画布事件
  cv.addEventListener('mousedown', boardDown);
  cv.addEventListener('mousemove', boardMove);
  __on(window, 'mouseup', boardUp);
  cv.addEventListener('touchstart', function(e){ e.preventDefault(); boardDown(e); }, {passive:false});
  cv.addEventListener('touchmove', function(e){ e.preventDefault(); boardMove(e); }, {passive:false});
  cv.addEventListener('touchend', boardUp);

  // 折叠 / 展开：默认收起；手写内容等第一次展开、画布有尺寸后再还原（收起时画布是 0 尺寸，提前还原会把手写内容覆盖掉）
  board.restored = false;
  var head = document.getElementById('board-head');
  function headAction(){
    if (board.panel.classList.contains('is-max')) setBoardMax(false);          // 放大态点标题栏 → 回到小便签
    else setBoardCollapsed(!board.panel.classList.contains('collapsed'));
  }
  if (head){
    head.addEventListener('click', headAction);
    head.addEventListener('keydown', function(e){
      if (e.key === 'Enter' || e.key === ' '){ e.preventDefault(); headAction(); }
    });
  }
  // 右上角按钮：收起时「展开」（回到小便签，可直接写文字）；小便签时「放大」（铺成日历大小）；放大时「还原」
  var maxBtn = document.getElementById('board-max-btn');
  if (maxBtn){
    maxBtn.addEventListener('click', function(e){
      e.stopPropagation();
      if (board.panel.classList.contains('collapsed')) setBoardCollapsed(false);
      else setBoardMax(!board.panel.classList.contains('is-max'));
    });
  }
  __on(window, 'resize', function(){ placeBoardMax(); });
  var pageEl = document.querySelector('.page-content');
  if (pageEl) __on(pageEl, 'scroll', function(){ placeBoardMax(); });
  __on(document, 'keydown', function(e){
    if (e.key === 'Escape' && board.panel && board.panel.classList.contains('is-max')) setBoardMax(false);
  });
  var storedFold = null;
  try { storedFold = localStorage.getItem(BOARD_FOLD_KEY); } catch(e){}
  setBoardCollapsed(storedFold === '1');   // 默认展开成右栏小便签，可直接写文字

  __on(window, 'resize', function(){ resizeBoard(); });
}

var BOARD_FOLD_KEY = 'board_collapsed';
function boardPreviewText(){
  var parts = [];
  var memo = '';
  try { memo = (localStorage.getItem('board_memo') || '').trim(); } catch(e){}
  if (memo) parts.push(memo.split(/\n/)[0].slice(0, 24));
  var hasInk = board.hasContent;
  if (!hasInk){ try { hasInk = !!localStorage.getItem('board_canvas'); } catch(e){} }
  if (hasInk) parts.push('有手写');
  if (pastedImages && pastedImages.length) parts.push(pastedImages.length + ' 张图片');
  return parts.length ? parts.join(' · ') : '点开记点什么';
}
function updateBoardPreview(){
  var el = document.getElementById('board-preview');
  if (el) el.textContent = boardPreviewText();
}
function updateBoardToggleLabel(){
  var panel = document.getElementById('blank-canvas');
  var tg = document.getElementById('board-toggle');
  var btn = document.getElementById('board-max-btn');
  if (!panel || !tg) return;
  var collapsed = panel.classList.contains('collapsed');
  var maxed = panel.classList.contains('is-max');
  tg.textContent = collapsed ? '展开' : (maxed ? '还原' : '放大');
  if (btn){
    btn.title = collapsed ? '展开便签' : (maxed ? '还原到右栏小便签' : '放大到日历大小，方便画图');
    btn.setAttribute('aria-label', tg.textContent);
  }
}
function setBoardCollapsed(collapsed){
  var panel = document.getElementById('blank-canvas');
  if (!panel) return;
  if (collapsed){
    setBoardMax(false);            // 收起前先退出日历大小浮层，清掉内联尺寸
    panel.classList.add('collapsed');
  } else {
    panel.classList.remove('collapsed');   // 展开成右栏小便签，光标可直接写文字
  }
  var head = document.getElementById('board-head');
  if (head) head.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  try { localStorage.setItem(BOARD_FOLD_KEY, collapsed ? '1' : '0'); } catch(e){}
  updateBoardToggleLabel();
  updateBoardPreview();
  if (!collapsed) ensureBoardRestored(function(){ renderPastedImages(); });
}
// 放大 / 还原：放大后与日历卡片同尺寸同位置（右下角小卡片确实不适合画图）
function boardMaxRect(){
  var cal = document.getElementById('calendar');
  if (!cal) return null;
  var r = cal.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}
function placeBoardMax(){
  var panel = document.getElementById('blank-canvas');
  if (!panel || !panel.classList.contains('is-max')) return;
  var r = boardMaxRect();
  if (!r) return;
  panel.style.top = r.top + 'px';
  panel.style.left = r.left + 'px';
  panel.style.width = r.width + 'px';
  panel.style.height = r.height + 'px';
}
function setBoardMax(on){
  var panel = document.getElementById('blank-canvas');
  if (!panel) return;
  if (on){
    panel.classList.add('is-max');
    placeBoardMax();
  } else {
    panel.classList.remove('is-max');
    panel.style.top = panel.style.left = panel.style.width = panel.style.height = '';
  }
  updateBoardToggleLabel();
  ensureBoardRestored(function(){
    resizeBoard(function(){ renderPastedImages(); });
    setTimeout(function(){ resizeBoard(function(){ renderPastedImages(); }); }, 60);
  });
}
// 第一次展开时还原手写内容：按比例缩放、居中，不拉伸变形
function ensureBoardRestored(done){
  if (board.restored){ resizeBoard(done); return; }
  var saved = null;
  try { saved = localStorage.getItem('board_canvas'); } catch(e){}
  if (!saved){ board.restored = true; resizeBoard(done); return; }
  var img = new Image();
  img.onload = function(){
    resizeBoard(function(){
      var w = board.stage.clientWidth, h = board.stage.clientHeight;
      if (!w || !h){ if (done) done(); return; }   // 仍不可见，下次展开再还原
      var s = Math.min(w / img.width, h / img.height);
      var dw = img.width * s, dh = img.height * s;
      board.ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
      board.hasContent = true;
      board.restored = true;
      var hint = document.getElementById('board-hint');
      if (hint) hint.style.display = 'none';
      if (done) done();
    });
  };
  img.onerror = function(){ board.restored = true; resizeBoard(done); };
  img.src = saved;
}

function boardDown(e){
  var p;
  if (e.touches && e.touches.length) p = getBoardPos(e);
  else if (e.changedTouches && e.changedTouches.length) p = getBoardPos(e);
  else p = { x: e.offsetX, y: e.offsetY };
  board.drawing = true;
  board.lastX = p.x; board.lastY = p.y;
  board.ctx.globalCompositeOperation = board.eraser ? 'destination-out' : 'source-over';
  board.ctx.beginPath();
  board.ctx.fillStyle = board.color;
  var dotSize = board.eraser ? Math.max(board.size, 22) : board.size;
  board.ctx.arc(p.x, p.y, dotSize / 2, 0, Math.PI * 2);
  board.ctx.fill();
  board.hasContent = true;
  document.getElementById('board-hint').style.display = 'none';
}
function boardMove(e){
  if (!board.drawing) return;
  var p;
  if (e.touches && e.touches.length) p = getBoardPos(e);
  else if (e.changedTouches && e.changedTouches.length) p = getBoardPos(e);
  else p = { x: e.offsetX, y: e.offsetY };
  board.ctx.globalCompositeOperation = board.eraser ? 'destination-out' : 'source-over';
  board.ctx.strokeStyle = board.color;
  board.ctx.lineWidth = board.eraser ? Math.max(board.size, 22) : board.size;
  board.ctx.lineCap = 'round';
  board.ctx.lineJoin = 'round';
  board.ctx.beginPath();
  board.ctx.moveTo(board.lastX, board.lastY);
  board.ctx.lineTo(p.x, p.y);
  board.ctx.stroke();
  board.lastX = p.x; board.lastY = p.y;
  board.hasContent = true;
  document.getElementById('board-hint').style.display = 'none';
}
function boardUp(){
  if (!board.drawing) return;
  board.drawing = false;
  saveBoardCanvas();
}
function clearBoardCanvas(){
  board.ctx.clearRect(0, 0, board.canvas.width, board.canvas.height);
  board.hasContent = false;
  document.getElementById('board-hint').style.display = '';
  localStorage.removeItem('board_canvas');
  board.restored = true;
  updateBoardPreview();
}
function saveBoardCanvas(){
  if (!board.restored) return;   // 手写内容还没还原，不能用空画布覆盖已保存的内容
  try { localStorage.setItem('board_canvas', board.canvas.toDataURL('image/png')); updateBoardPreview(); } catch(err){
    // 存储空间不足时提示用户，不再静默失败
    console.warn('画板保存失败（可能超出 localStorage 限制）:', err.message);
    notifyStorageFull('手写内容');
  }
}
// 浏览器存储满时提示一次（原来只打 console.warn，用户不知道内容没保存上）
var storageFullNotified = 0;
function notifyStorageFull(what){
  var now = Date.now();
  if (now - storageFullNotified < 10000) return;
  storageFullNotified = now;
  if (true) toast('⚠ ' + what + '未能保存：浏览器存储空间已满，请删除部分便签图片后重试', 'error');
}
function saveMemo(){
  try { localStorage.setItem('board_memo', document.getElementById('board-memo').value); }
  catch(err){ notifyStorageFull('便签文字'); }
  updateBoardPreview();
}
function applyMemoColor(color){
  var memoEl = document.getElementById('board-memo');
  var sw = document.getElementById('board-text-color-swatch');
  var inp = document.getElementById('board-text-color');
  if (memoEl) memoEl.style.color = color || '';          // 空值 = 跟随主题文字色
  if (sw) sw.style.background = color || 'var(--text-primary)';
  if (inp && color) inp.value = color;
}
// 粘贴图片
var pastedImages = [];
var dragImg = null, dragIdx = -1, dragSX = 0, dragSY = 0, dragOX = 0, dragOY = 0;
var resizeImg = null, resizeIdx = -1, resizeSX = 0, resizeSY = 0, resizeSW = 100;
function loadPastedImages(){
  try { pastedImages = JSON.parse(localStorage.getItem('board_images') || '[]'); }
  catch(e){ pastedImages = []; }
}
function saveImages(){
  try { localStorage.setItem('board_images', JSON.stringify(pastedImages)); updateBoardPreview(); }
  catch(err){ console.warn('图片保存失败（可能超出 localStorage 限制）:', err.message); notifyStorageFull('粘贴的图片'); }
}
function renderPastedImages(){
  if (!board.stage) return;
  board.stage.querySelectorAll('.board-img').forEach(function(el){ el.remove(); });
  var stageW = board.stage.clientWidth, stageH = board.stage.clientHeight;
  pastedImages.forEach(function(item, idx){
    var wrap = document.createElement('div');
    wrap.className = 'board-img';
    var w = item.w, x = item.x, y = item.y;
    if (stageW && stageH){
      w = Math.min(w, Math.max(60, stageW - 16));
      x = Math.min(Math.max(0, x), Math.max(0, stageW - w));
      y = Math.min(Math.max(0, y), Math.max(0, stageH - 40));
    }
    wrap.style.left = x + 'px';
    wrap.style.top = y + 'px';
    wrap.style.width = w + 'px';
    var img = document.createElement('img');
    img.src = item.src;
    var del = document.createElement('button');
    del.className = 'board-img-del';
    del.type = 'button';
    del.textContent = '×';
    del.addEventListener('mousedown', function(ev){ ev.stopPropagation(); });
    del.addEventListener('click', function(ev){
      ev.stopPropagation();
      pastedImages.splice(idx, 1);
      saveImages();
      renderPastedImages();
    });
    wrap.appendChild(img);
    wrap.appendChild(del);
    var resize = document.createElement('span');
    resize.className = 'board-img-resize';
    wrap.appendChild(resize);
    wrap.addEventListener('mousedown', function(e){
      if (e.target === del) return;
      if (e.target === resize) return;
      dragImg = wrap; dragIdx = idx;
      dragSX = e.clientX; dragSY = e.clientY;
      dragOX = parseFloat(wrap.style.left) || 0;
      dragOY = parseFloat(wrap.style.top) || 0;
      e.preventDefault(); e.stopPropagation();
    });
    resize.addEventListener('mousedown', function(e){
      e.preventDefault(); e.stopPropagation();
      resizeImg = wrap; resizeIdx = idx;
      resizeSX = e.clientX; resizeSY = e.clientY;
      resizeSW = parseFloat(wrap.style.width) || 100;
    });
    board.stage.appendChild(wrap);
  });
}
function initPastedImages(){
  loadPastedImages();
  renderPastedImages();
  __on(window, 'mousemove', function(e){
    if (dragImg){
      dragImg.style.left = (dragOX + e.clientX - dragSX) + 'px';
      dragImg.style.top = (dragOY + e.clientY - dragSY) + 'px';
    }
    if (resizeImg){
      var nw = Math.max(40, resizeSW + (e.clientX - resizeSX));
      resizeImg.style.width = nw + 'px';
    }
  });
  __on(window, 'mouseup', function(){
    if (dragImg){
      pastedImages[dragIdx].x = parseFloat(dragImg.style.left) || 0;
      pastedImages[dragIdx].y = parseFloat(dragImg.style.top) || 0;
      saveImages();
      dragImg = null; dragIdx = -1;
    }
    if (resizeImg){
      pastedImages[resizeIdx].w = parseFloat(resizeImg.style.width) || 100;
      saveImages();
      resizeImg = null; resizeIdx = -1;
    }
  });
  __on(document, 'paste', function(e){
    if (!board.panel || board.panel.offsetParent === null) return;
    var cd = e.clipboardData || window.clipboardData;
    if (!cd || !cd.items) return;
    var hasImage = false;
    for (var hi = 0; hi < cd.items.length; hi++){ if (cd.items[hi].type && cd.items[hi].type.indexOf('image') === 0) hasImage = true; }
    if (hasImage && board.panel.classList.contains('collapsed')) setBoardCollapsed(false);
    for (var i = 0; i < cd.items.length; i++){
      if (cd.items[i].type && cd.items[i].type.indexOf('image') === 0){
        var blob = cd.items[i].getAsFile();
        if (!blob) return;
        var reader = new FileReader();
        reader.onload = function(ev){
          var src = ev.target.result;
          var stageW = board.stage.clientWidth || 400;
          var stageH = board.stage.clientHeight || 400;
          var w = Math.min(200, stageW * 0.55);
          pastedImages.push({ src: src, x: (stageW - w) / 2, y: stageH * 0.08, w: w });
          saveImages();
          renderPastedImages();
        };
        reader.readAsDataURL(blob);
        e.preventDefault();
        return;
      }
    }
  });
}
function getBoardPos(e){
  var rect = board.canvas.getBoundingClientRect();
  if (e.touches && e.touches.length){
    return { x: e.touches[0].clientX - rect.left, y: e.touches[0].clientY - rect.top };
  }
  if (e.changedTouches && e.changedTouches.length){
    return { x: e.changedTouches[0].clientX - rect.left, y: e.changedTouches[0].clientY - rect.top };
  }
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}
function resizeBoard(done){
  if (!board.stage || !board.canvas) { if (done) done(); return; }
  var rect = board.stage.getBoundingClientRect();
  if (!rect.width || !rect.height){ if (done) done(); return; }
  var dpr = window.devicePixelRatio || 1;
  // 保存原始画板尺寸，resize 时按原始比例还原（不拉伸变形）
  var prevW = board.canvas.width / dpr;
  var prevH = board.canvas.height / dpr;
  var prev = null;
  if (board.canvas.width && board.canvas.height && board.hasContent){
    prev = board.canvas.toDataURL('image/png');
  }
  board.canvas.width = rect.width * dpr;
  board.canvas.height = rect.height * dpr;
  board.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (prev){
    var img = new Image();
    img.onload = function(){
      // 按原始比例居中绘制，不拉伸
      var scale = Math.min(rect.width / prevW, rect.height / prevH);
      var drawW = prevW * scale;
      var drawH = prevH * scale;
      var offsetX = (rect.width - drawW) / 2;
      var offsetY = (rect.height - drawH) / 2;
      board.ctx.drawImage(img, offsetX, offsetY, drawW, drawH);
      if (done) done();
    };
    img.src = prev;
  } else {
    if (done) done();
  }
}

// ═════════════════════════════════════
// 主题：默认 Aurora 暗色，可切到 Paper 亮色，选择记在本地
// ═════════════════════════════════════

export function mountBoard() { initBoard(); }
export function unmountBoard() {
  try { if (board.panel && board.panel.classList.contains('is-max')) setBoardMax(false); } catch (e) { }
  __offs.splice(0).forEach(function (f) { f(); });
  board.canvas = null; board.ctx = null; board.stage = null; board.panel = null;
}
export function listenerCount() { return __offs.length; }
export { resizeBoard };
