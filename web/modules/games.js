// module: games (游戏) —— 小游戏中心
(function () {
  'use strict';
  if (window.SecureChatGames) return;

  function esc(s) { return window.escapeHtml ? window.escapeHtml(s) : String(s == null ? '' : s); }
  function toastMsg(m, k) { if (window.toast) window.toast(m, k || 'info'); }

  var STORAGE_KEY = 'sc_game_scores';

  function getScores() { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch (e) { return {}; } }
  function saveScores(s) { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch (e) {} }

  var GAMES = [
    { id: 'guess', name: '猜数字', icon: '🔢', desc: '猜 1-100 之间的数字，看看你几次能猜中', color: '#3498db' },
    { id: '2048', name: '2048', icon: '🎮', desc: '经典数字合并游戏，挑战 2048', color: '#e67e22' },
    { id: 'reaction', name: '反应力测试', icon: '⚡', desc: '测试你的反应速度，越快越好', color: '#e74c3c' },
    { id: 'memory', name: '记忆翻牌', icon: '🃏', desc: '翻牌找对子，考验记忆力', color: '#2ecc71' },
    { id: 'typing', name: '打字速度', icon: '⌨️', desc: '测试你的打字速度（WPM）', color: '#9b59b6' },
    { id: 'tictactoe', name: '井字棋', icon: '❌', desc: '和 AI 对战井字棋', color: '#1abc9c' },
  ];

  function mount(host) {
    host.className = (host.className || '') + ' games-panel';
    var scores = getScores();
    host.innerHTML =
      '<div class="games-head"><div class="games-title">游戏中心</div></div>' +
      '<div class="games-grid">' +
        GAMES.map(function (g) {
          var score = scores[g.id];
          return '<div class="game-card" data-id="' + g.id + '" style="border-top:3px solid ' + g.color + '">' +
            '<div class="game-card-icon">' + g.icon + '</div>' +
            '<div class="game-card-info">' +
              '<div class="game-card-name">' + esc(g.name) + '</div>' +
              '<div class="game-card-desc">' + esc(g.desc) + '</div>' +
              (score != null ? '<div class="game-card-score">最佳：' + score + '</div>' : '') +
            '</div>' +
            '<button class="game-play">开始</button>' +
          '</div>';
        }).join('') +
      '</div>';

    host.querySelectorAll('.game-card').forEach(function (card) {
      card.onclick = function () {
        var id = card.dataset.id;
        var game = GAMES.find(function (g) { return g.id === id; });
        if (game) openGame(game);
      };
    });
  }

  function openGame(g) {
    var mask = document.createElement('div');
    mask.className = 'modal-mask';
    var box = document.createElement('div');
    box.className = 'modal game-modal';
    box.style.cssText = 'width:min(480px,94vw);max-height:88vh;overflow:auto';
    box.innerHTML = '<div class="game-modal-head"><span>' + esc(g.name) + '</span><button class="modal-x" type="button">&times;</button></div><div class="game-modal-body"></div>';
    mask.appendChild(box);
    document.body.appendChild(mask);
    box.querySelector('.modal-x').onclick = function () { mask.remove(); };
    mask.addEventListener('click', function (e) { if (e.target === mask) mask.remove(); });
    var body = box.querySelector('.game-modal-body');

    if (g.id === 'guess') startGuess(body, g);
    else if (g.id === '2048') start2048(body, g);
    else if (g.id === 'reaction') startReaction(body, g);
    else if (g.id === 'memory') startMemory(body, g);
    else if (g.id === 'typing') startTyping(body, g);
    else if (g.id === 'tictactoe') startTicTacToe(body, g);
  }

  function saveScore(gId, score) {
    var scores = getScores();
    if (scores[gId] == null || (gId === 'guess' ? score < scores[gId] : score > scores[gId])) {
      scores[gId] = score;
      saveScores(scores);
    }
  }

  function startGuess(body, g) {
    var target = Math.floor(Math.random() * 100) + 1;
    var tries = 0;
    body.innerHTML = '<div class="game-area"><p>猜一个 1-100 的数字</p><div class="game-hint">输入数字开始</div><input type="number" class="game-input" min="1" max="100" placeholder="1-100" /><button class="game-btn">猜</button></div>';
    var input = body.querySelector('.game-input');
    var btn = body.querySelector('.game-btn');
    var hint = body.querySelector('.game-hint');
    function guess() {
      var n = parseInt(input.value);
      if (!n || n < 1 || n > 100) { hint.textContent = '请输入 1-100 的数字'; return; }
      tries++;
      if (n === target) {
        hint.innerHTML = '猜对了！用了 ' + tries + ' 次';
        saveScore('guess', tries);
        toastMsg('猜对了！' + tries + ' 次');
        btn.textContent = '再来一局';
        btn.onclick = function () { startGuess(body, g); };
      } else if (n < target) { hint.textContent = '太小了，再大一点（第' + tries + '次）'; }
      else { hint.textContent = '太大了，再小一点（第' + tries + '次）'; }
      input.value = '';
    }
    btn.onclick = guess;
    input.onkeydown = function (e) { if (e.key === 'Enter') guess(); };
    input.focus();
  }

  function start2048(body, g) {
    var grid = [];
    for (var i = 0; i < 4; i++) { grid[i] = [0, 0, 0, 0]; }
    var score = 0;
    function addTile() {
      var empty = [];
      for (var r = 0; r < 4; r++) for (var c = 0; c < 4; c++) if (!grid[r][c]) empty.push([r, c]);
      if (!empty.length) return;
      var p = empty[Math.floor(Math.random() * empty.length)];
      grid[p[0]][p[1]] = Math.random() < 0.9 ? 2 : 4;
    }
    function render() {
      var colors = { 0: '#cdc1b4', 2: '#eee4da', 4: '#ede0c8', 8: '#f2b179', 16: '#f59563', 32: '#f67c5f', 64: '#f65e3b', 128: '#edcf72', 256: '#edcc61', 512: '#edc850', 1024: '#edc53f', 2048: '#edc22e' };
      var html = '<div class="g2048-score">得分：' + score + '</div><div class="g2048-grid">';
      for (var r = 0; r < 4; r++) for (var c = 0; c < 4; c++) {
        var v = grid[r][c];
        var bg = colors[v] || '#3c3a32';
        var color = v <= 4 ? '#776e65' : '#fff';
        html += '<div class="g2048-cell" style="background:' + bg + ';color:' + color + '">' + (v || '') + '</div>';
      }
      html += '</div><p class="game-tip">用方向键或滑动操作</p>';
      body.innerHTML = html;
    }
    function move(dir) {
      var moved = false;
      var rotate = function (g, n) { for (var i = 0; i < n; i++) { var t = g; g = []; for (var c = 0; c < 4; c++) { g[c] = []; for (var r = 3; r >= 0; r--) g[c].push(t[r][c]); } } return g; };
      var original = JSON.parse(JSON.stringify(grid));
      if (dir === 'left') {} else if (dir === 'right') { grid = rotate(grid, 2); } else if (dir === 'up') { grid = rotate(grid, 3); } else if (dir === 'down') { grid = rotate(grid, 1); }
      for (var r = 0; r < 4; r++) {
        var row = grid[r].filter(function (x) { return x; });
        for (var i = 0; i < row.length - 1; i++) { if (row[i] === row[i + 1]) { row[i] *= 2; score += row[i]; row.splice(i + 1, 1); } }
        while (row.length < 4) row.push(0);
        grid[r] = row;
      }
      if (dir === 'right') grid = rotate(grid, 2); else if (dir === 'up') grid = rotate(grid, 1); else if (dir === 'down') grid = rotate(grid, 3);
      moved = JSON.stringify(grid) !== JSON.stringify(original);
      if (moved) { addTile(); render(); }
      if (score > 0) saveScore('2048', score);
    }
    addTile(); addTile(); render();
    body.tabIndex = 0;
    body.focus();
    body.onkeydown = function (e) {
      var map = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
      if (map[e.key]) { e.preventDefault(); move(map[e.key]); }
    };
  }

  function startReaction(body, g) {
    body.innerHTML = '<div class="game-area"><p>点击下方区域，绿色时尽快点击</p><div class="reaction-box" style="background:#e74c3c">点击开始</div><div class="reaction-result"></div></div>';
    var box = body.querySelector('.reaction-box');
    var result = body.querySelector('.reaction-result');
    var startTime = 0;
    var timeoutId = null;
    var waiting = false;
    box.onclick = function () {
      if (!waiting) {
        box.style.background = '#e74c3c';
        box.textContent = '等待…';
        result.textContent = '';
        waiting = true;
        var delay = 1000 + Math.random() * 3000;
        timeoutId = setTimeout(function () {
          box.style.background = '#2ecc71';
          box.textContent = '快点击！';
          startTime = Date.now();
        }, delay);
      } else if (box.style.background === 'rgb(46, 204, 113)' || box.style.background === '#2ecc71') {
        var reaction = Date.now() - startTime;
        result.textContent = '反应时间：' + reaction + 'ms';
        saveScore('reaction', reaction);
        toastMsg('反应时间 ' + reaction + 'ms');
        waiting = false;
        box.style.background = '#e74c3c';
        box.textContent = '再试一次';
      } else {
        clearTimeout(timeoutId);
        waiting = false;
        box.style.background = '#e74c3c';
        box.textContent = '太早了！点击重新开始';
        result.textContent = '太早了！';
      }
    };
  }

  function startMemory(body, g) {
    var emojis = ['🍎','🍌','🍇','🍒','🍓','🍑','🍊','🍋'];
    var cards = emojis.concat(emojis).sort(function () { return Math.random() - 0.5; });
    var flipped = [];
    var matched = 0;
    var moves = 0;
    var lock = false;
    function render() {
      var html = '<div class="game-area"><p>翻牌找对子，移动次数：' + moves + '</p><div class="memory-grid">';
      cards.forEach(function (c, i) {
        var isFlipped = flipped.indexOf(i) >= 0;
        var isMatched = cards[i] === null;
        html += '<div class="memory-card' + (isFlipped || isMatched ? ' flipped' : '') + (isMatched ? ' matched' : '') + '" data-idx="' + i + '">' + (isFlipped || isMatched ? c : '?') + '</div>';
      });
      html += '</div></div>';
      body.innerHTML = html;
      body.querySelectorAll('.memory-card').forEach(function (el) {
        if (el.classList.contains('matched')) return;
        el.onclick = function () {
          if (lock) return;
          var idx = Number(el.dataset.idx);
          if (flipped.indexOf(idx) >= 0) return;
          flipped.push(idx);
          render();
          if (flipped.length === 2) {
            moves++;
            lock = true;
            if (cards[flipped[0]] === cards[flipped[1]]) {
              matched += 2;
              var f0 = flipped[0], f1 = flipped[1];
              setTimeout(function () { cards[f0] = null; cards[f1] = null; flipped = []; lock = false; render(); if (matched >= cards.length) { saveScore('memory', moves); toastMsg('完成！' + moves + ' 步'); } }, 500);
            } else {
              setTimeout(function () { flipped = []; lock = false; render(); }, 800);
            }
          }
        };
      });
    }
    render();
  }

  function startTyping(body, g) {
    var texts = [
      'The quick brown fox jumps over the lazy dog',
      'SecureChat is a modern instant messaging application',
      'Programming is the art of telling another human what one wants the computer to do',
      'Technology is best when it brings people together',
      'The best way to predict the future is to invent it',
    ];
    var text = texts[Math.floor(Math.random() * texts.length)];
    var startTime = 0;
    var started = false;
    body.innerHTML = '<div class="game-area"><p>点击输入框开始计时，打完自动结束</p><div class="typing-text">' + esc(text) + '</div><textarea class="typing-input" placeholder="点击此处开始打字…"></textarea><div class="typing-result"></div></div>';
    var input = body.querySelector('.typing-input');
    var result = body.querySelector('.typing-result');
    input.oninput = function () {
      if (!started) { started = true; startTime = Date.now(); }
      if (input.value === text) {
        var elapsed = (Date.now() - startTime) / 1000;
        var wpm = Math.round((text.split(' ').length / elapsed) * 60);
        result.textContent = '完成！速度：' + wpm + ' WPM（' + elapsed.toFixed(1) + '秒）';
        saveScore('typing', wpm);
        toastMsg(wpm + ' WPM');
        input.disabled = true;
      }
    };
    input.focus();
  }

  function startTicTacToe(body, g) {
    var board = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    var gameOver = false;
    function render() {
      var symbols = { 0: '', 1: '✕', 2: '◯' };
      body.innerHTML = '<div class="game-area"><p>你（✕）vs AI（◯）</p><div class="ttt-grid">' + board.map(function (c, i) {
        return '<div class="ttt-cell' + (c ? ' taken' : '') + '" data-idx="' + i + '">' + symbols[c] + '</div>';
      }).join('') + '</div><div class="ttt-status"></div></div>';
      body.querySelectorAll('.ttt-cell').forEach(function (el) {
        if (el.classList.contains('taken') || gameOver) return;
        el.onclick = function () {
          var idx = Number(el.dataset.idx);
          if (board[idx]) return;
          board[idx] = 1;
          render();
          var w = checkWin(board);
          if (w) { gameOver = true; body.querySelector('.ttt-status').textContent = w === 1 ? '你赢了！' : '平局'; saveScore('tictactoe', w === 1 ? 1 : 0); return; }
          setTimeout(function () {
            var best = bestMove(board);
            if (best >= 0) board[best] = 2;
            render();
            var w2 = checkWin(board);
            if (w2) { gameOver = true; body.querySelector('.ttt-status').textContent = w2 === 2 ? 'AI 获胜' : '平局'; }
          }, 300);
        };
      });
    }
    function checkWin(b) {
      var lines = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
      for (var i = 0; i < lines.length; i++) { var l = lines[i]; if (b[l[0]] && b[l[0]] === b[l[1]] && b[l[1]] === b[l[2]]) return b[l[0]]; }
      if (b.every(function (x) { return x; })) return 3;
      return 0;
    }
    function bestMove(b) {
      for (var i = 0; i < 9; i++) if (!b[i]) { b[i] = 2; if (checkWin(b) === 2) { b[i] = 0; return i; } b[i] = 0; }
      for (var i = 0; i < 9; i++) if (!b[i]) { b[i] = 1; if (checkWin(b) === 1) { b[i] = 0; return i; } b[i] = 0; }
      if (!b[4]) return 4;
      var corners = [0, 2, 6, 8].filter(function (i) { return !b[i]; });
      if (corners.length) return corners[Math.floor(Math.random() * corners.length)];
      for (var i = 0; i < 9; i++) if (!b[i]) return i;
      return -1;
    }
    render();
  }

  function openPanel() {
    var mask = document.createElement('div');
    mask.className = 'modal-mask';
    var box = document.createElement('div');
    box.className = 'modal';
    box.style.cssText = 'width:min(520px,94vw);max-height:88vh;overflow:auto';
    box.innerHTML = '<div class="oa-container"></div>';
    mask.appendChild(box);
    document.body.appendChild(mask);
    var closeX = document.createElement('button');
    closeX.className = 'modal-x'; closeX.innerHTML = '&times;';
    box.appendChild(closeX);
    closeX.onclick = function () { mask.remove(); };
    mask.addEventListener('click', function (e) { if (e.target === mask) mask.remove(); });
    mount(box.querySelector('.oa-container'));
  }

  window.SecureChatGames = { name: '游戏', label: '游戏', icon: '游', open: openPanel, mount: mount };
  if (window.SecureChatExt && typeof window.SecureChatExt.registerFeature === 'function') {
    window.SecureChatExt.registerFeature('games', { name: '游戏', label: '游戏', icon: '游', open: openPanel, mount: mount });
  }
}());
