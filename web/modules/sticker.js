// module: sticker (表情) —— 表情商店 + 自定义表情收藏
(function () {
  'use strict';
  if (window.SecureChatStickers) return;

  function esc(s) { return window.escapeHtml ? window.escapeHtml(s) : String(s == null ? '' : s); }
  function toastMsg(m, k) { if (window.toast) window.toast(m, k || 'info'); }

  var STORAGE_KEY = 'sc_custom_stickers';

  function loadCustom() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch (e) { return []; }
  }
  function saveCustom(list) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); } catch (e) {}
  }

  var EMOJI_SETS = {
    '表情': ['😀','😁','😂','🤣','😃','😄','😅','😆','😉','😊','😋','😎','😍','😘','🥰','😗','😙','😚','🙂','🤗','🤩','🤔','🤨','😐','😑','😶','🙄','😏','😣','😥','😮','🤐','😯','😪','😫','🥱','😴','😌','😛','😜','😝','🤤','😒','😓','😔','🙃','🤑','😲','☹️','🙁','😖','😞','😟','😤','😢','😭','😦','😧','😨','😩','🤯','😬','😰','😱','🥵','🥶','😳','🤪','😵','🥴','😠','😡','🤬','😷','🤒','🤕','🤢','🤮','🥵','🥳','🥺','🤠','🤡','🤥','🤫','🤭','🧐','🤓','😈','👿','👹','👺','💀','👻','👽','🤖','💩'],
    '动物': ['🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐽','🐸','🐵','🙈','🙉','🙊','🐒','🐔','🐧','🐦','🐤','🐣','🐥','🦆','🦅','🦉','🦇','🐺','🐗','🐴','🦄','🐝','🐛','🦋','🐌','🐞','🐜','🦂','🐢','🐍','🦎','🦖','🦕','🐙','🦑','🦐','🦞','🦀','🐡','🐠','🐟','🐬','🐳','🐋','🦈','🐊','🐅','🐆','🦓','🦍','🦧','🐘','🦛','🦏','🐪','🐫','🦒','🦘','🐃','🐂','🐄','🐎','🐖','🐏','🐑','🐐','🦌','🐕','🐩','🦮','🐈','🐓','🦃','🦚','🦜','🦢'],
    '美食': ['🍎','🍐','🍊','🍋','🍌','🍉','🍇','🍓','🫐','🍈','🍒','🍑','🥭','🍍','🥥','🥝','🍅','🍆','🥑','🥦','🥬','🥒','🌶','🌽','🥕','🧄','🧅','🥔','🍠','🥐','🥯','🍞','🥖','🥨','🧀','🥚','🍳','🧈','🥞','🧇','🥓','🥩','🍗','🍖','🦴','🌭','🍔','🍟','🍕','🥪','🥙','🧆','🌮','🌯','🥗','🥘','🥫','🍝','🍜','🍲','🍛','🍣','🍱','🥟','🦪','🍤','🍙','🍚','🍘','🍥','🥠','🥮','🍢','🍡','🍧','🍨','🍦','🥧','🧁','🍰','🎂','🍮','🍭','🍬','🍫','🍩','🍪','🌰','🥜','🍯','🥛','🍼','☕','🍵','🧃','🥤','🍶','🍺','🍻','🥂','🍷','🥃','🍸','🍹','🍾'],
    '活动': ['⚽','🏀','🏈','⚾','🥎','🎾','🏐','🏉','🥏','🎱','🪀','🏓','🏸','🏒','🏑','🥍','🏏','🥅','⛳','🪁','🏹','🎣','🤿','🥊','🥋','🎽','🛹','🛼','🛷','⛸','🥌','🎿','⛷','🏂','🪂','🏋️','🤼','🤸','⛹️','🤺','🤾','🏌️','🏇','🧘','🏄','🏊','🤽','🚣','🧗','🚵','🚴','🏆','🥇','🥈','🥉','🏅','🎖','🏵','🎗','🎫','🎟','🎪','🤹','🎭','🩰','🎨','🎬','🎤','🎧','🎼','🎹','🥁','🪘','🎷','🎺','🎸','🪕','🎻','🎲','♟','🎯','🎳','🎮','🎰','🧩'],
    '旅行': ['🚗','🚕','🚙','🚌','🚎','🏎','🚓','🚑','🚒','🚐','🚚','🚛','🚜','🦯','🦽','🦼','🛴','🚲','🛵','🏍','🛺','🚨','🚔','🚍','🚘','🚖','🚡','🚠','🚟','🚃','🚋','🚞','🚝','🚄','🚅','🚈','🚂','🚆','🚇','🚊','🚉','✈️','🛫','🛬','🛩','💺','🛰','🚀','🛸','🚁','🛶','⛵','🚤','🛥','🛳','⛴','🚢','⚓','⛽','🚧','🚦','🚥','🚏','🗺','🗿','🗽','🗼','🏰','🏯','🏟','🎡','🎢','🎠','⛲','⛱','🏖','🏝','🏜','🌋','⛰','🏔','🗻','🏕','⛺','🏠','🏡','🏘','🏚','🏗','🏭','🏢','🏬','🏣','🏤','🏥','🏦','🏨','🏪','🏫','🏩','💒','🏛','⛪','🕌','🕍','🛕','🕋','⛩'],
    '物品': ['⌚','📱','📲','💻','⌨️','🖥','🖨','🖱','🖲','🕹','🗜','💽','💾','💿','📀','📼','📷','📸','📹','🎥','📽','🎞','📞','☎️','📟','📠','📺','📻','🎙','🎚','🎛','🧭','⏱','⏲','⏰','🕰','⌛','⏳','📡','🔋','🔌','💡','🔦','🕯','🪔','🧯','🛢','💸','💵','💴','💶','💷','💰','💳','💎','⚖️','🧰','🔧','🔨','⚒','🛠','⛏','🔩','⚙️','🧱','⛓','🧲','🔫','💣','🧨','🪓','🔪','🗡','⚔️','🛡','🚬','⚰️','⚱️','🏺','🔮','📿','🧿','💈','⚗️','🔭','🔬','🕳','🩹','🩺','💊','💉','🩸','🧬','🦠','🧫','🧪','🌡','🧹','🧺','🧻','🚽','🚰','🚿','🛁','🛀','🧼','🧽','🧴','🛎','🔑','🗝','🚪','🪑','🛋','🛏','🛌','🧸','🖼','🛍','🛒','🎁','🎈','🎏','🎀','🪄','🪅','🎊','🎉','🎎','🏮','🎐','🧧'],
  };

  var customStickers = loadCustom();
  var curTab = '表情';

  function mount(host) {
    host.className = (host.className || '') + ' sticker-panel';
    var tabKeys = Object.keys(EMOJI_SETS);
    host.innerHTML =
      '<div class="sticker-head">' +
        '<div class="sticker-title">表情</div>' +
        '<div class="sticker-tabs">' +
          tabKeys.map(function (k) { return '<button class="sticker-tab' + (k === curTab ? ' active' : '') + '" data-tab="' + esc(k) + '">' + esc(k) + '</button>'; }).join('') +
          '<button class="sticker-tab" data-tab="收藏">收藏(' + customStickers.length + ')</button>' +
        '</div>' +
      '</div>' +
      '<div class="sticker-grid"></div>';

    var grid = host.querySelector('.sticker-grid');

    function render() {
      if (curTab === '收藏') {
        if (!customStickers.length) {
          grid.innerHTML = '<div class="sticker-empty">还没有收藏表情<br>在下方表情列表中点击 ☆ 收藏</div>';
          return;
        }
        grid.innerHTML = customStickers.map(function (e, i) {
          return '<button class="sticker-item custom" data-emoji="' + esc(e) + '">' + e + '<span class="sticker-del" data-idx="' + i + '">✕</span></button>';
        }).join('');
        grid.querySelectorAll('.sticker-del').forEach(function (btn) {
          btn.onclick = function (e) {
            e.stopPropagation();
            var idx = Number(btn.dataset.idx);
            customStickers.splice(idx, 1);
            saveCustom(customStickers);
            render();
            host.querySelector('.sticker-tab[data-tab="收藏"]').textContent = '收藏(' + customStickers.length + ')';
          };
        });
      } else {
        var set = EMOJI_SETS[curTab] || [];
        grid.innerHTML = set.map(function (e) {
          var isFav = customStickers.indexOf(e) >= 0;
          return '<button class="sticker-item" data-emoji="' + esc(e) + '">' + e +
            '<span class="sticker-fav' + (isFav ? ' active' : '') + '" data-emoji="' + esc(e) + '">' + (isFav ? '★' : '☆') + '</span>' +
          '</button>';
        }).join('');

        grid.querySelectorAll('.sticker-fav').forEach(function (btn) {
          btn.onclick = function (e) {
            e.stopPropagation();
            var emoji = btn.dataset.emoji;
            var idx = customStickers.indexOf(emoji);
            if (idx >= 0) { customStickers.splice(idx, 1); btn.classList.remove('active'); btn.textContent = '☆'; }
            else { customStickers.push(emoji); btn.classList.add('active'); btn.textContent = '★'; }
            saveCustom(customStickers);
            host.querySelector('.sticker-tab[data-tab="收藏"]').textContent = '收藏(' + customStickers.length + ')';
          };
        });
      }

      grid.querySelectorAll('.sticker-item').forEach(function (btn) {
        btn.onclick = function (e) {
          if (e.target.classList.contains('sticker-fav') || e.target.classList.contains('sticker-del')) return;
          var emoji = btn.dataset.emoji;
          sendEmoji(emoji);
        };
      });
    }

    host.querySelectorAll('.sticker-tab').forEach(function (tab) {
      tab.onclick = function () {
        host.querySelectorAll('.sticker-tab').forEach(function (t) { t.classList.remove('active'); });
        tab.classList.add('active');
        curTab = tab.dataset.tab;
        render();
      };
    });

    render();
  }

  function sendEmoji(emoji) {
    var input = document.getElementById('desktopInput') || document.getElementById('input');
    if (input && input.style.display !== 'none') {
      var pos = (input.selectionStart == null) ? input.value.length : input.selectionStart;
      input.value = input.value.substring(0, pos) + emoji + input.value.substring(pos);
      input.focus();
      input.selectionStart = input.selectionEnd = pos + emoji.length;
    } else {
      toastMsg('表情：' + emoji);
    }
  }

  function openPanel() {
    var mask = document.createElement('div');
    mask.className = 'modal-mask';
    var box = document.createElement('div');
    box.className = 'modal';
    box.style.cssText = 'width:min(520px,94vw);max-height:80vh;overflow:auto';
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

  window.SecureChatStickers = { name: '表情', label: '表情', icon: '☺', open: openPanel, mount: mount, sendEmoji: sendEmoji };
  if (window.SecureChatExt && typeof window.SecureChatExt.registerFeature === 'function') {
    window.SecureChatExt.registerFeature('stickers', { name: '表情', label: '表情', icon: '☺', open: openPanel, mount: mount, sendEmoji: sendEmoji });
  }
}());
