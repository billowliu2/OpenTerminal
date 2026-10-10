/* OpenTerminal 官网语言层
   选定语言的优先级（与 index.html 头部内联脚本完全一致）：
     1. URL 参数 ?lang=xx
     2. localStorage['openterminal.lang']
     3. navigator.language(s) 前缀匹配
     4. 默认 zh-CN
   index.html 头部内联脚本先按同一优先级把 <html lang> 定好（首帧防闪），
   本文件直接读 document.documentElement.lang 作为唯一事实源，不重复判定。

   应用规则：
   - [data-i18n="k"]        → textContent
   - [data-i18n-html="k"]   → innerHTML（字典是本地静态文件，非用户输入）
   - [data-i18n-attr="alt:k;title:k2"] → 逐对写属性，分号分隔
   缺键回落到 zh-CN；仍缺则保持 HTML 里的原文，不会把页面写空。

   语言切换后派发 document 事件 'openterminal:langchange'（detail.lang），
   页面尾部的内联脚本据此重刷主题按钮文案。 */
(function () {
  'use strict';

  var DICT = window.OPENTERMINAL_I18N || {};
  var STORAGE_KEY = 'openterminal.lang';
  var FALLBACK = 'zh-CN';
  var SUPPORTED = ['zh-CN', 'zh-TW', 'en', 'ja'];

  function normalize(tag) {
    if (!tag) return null;
    var t = String(tag).replace(/_/g, '-');
    if (/^zh-?(tw|hk|mo)/i.test(t)) return 'zh-TW';
    if (/^zh/i.test(t)) return 'zh-CN';
    if (/^ja/i.test(t)) return 'ja';
    if (/^en/i.test(t)) return 'en';
    return null;
  }

  function tableOf(lang) {
    return DICT[lang] || DICT[FALLBACK] || {};
  }

  function lookup(lang, key) {
    var table = tableOf(lang);
    if (Object.prototype.hasOwnProperty.call(table, key)) return table[key];
    var fb = DICT[FALLBACK] || {};
    if (Object.prototype.hasOwnProperty.call(fb, key)) return fb[key];
    return null;
  }

  function applyAttrs(lang) {
    var nodes = document.querySelectorAll('[data-i18n-attr]');
    for (var i = 0; i < nodes.length; i++) {
      var pairs = nodes[i].getAttribute('data-i18n-attr').split(';');
      for (var j = 0; j < pairs.length; j++) {
        var parts = pairs[j].split(':');
        if (parts.length < 2) continue;
        var attr = parts[0].trim();
        var key = parts.slice(1).join(':').trim();
        var val = lookup(lang, key);
        if (attr && val !== null) nodes[i].setAttribute(attr, val);
      }
    }
  }

  function applyText(lang) {
    var nodes = document.querySelectorAll('[data-i18n]');
    for (var i = 0; i < nodes.length; i++) {
      var val = lookup(lang, nodes[i].getAttribute('data-i18n'));
      if (val !== null) nodes[i].textContent = val;
    }
  }

  function applyHtml(lang) {
    var nodes = document.querySelectorAll('[data-i18n-html]');
    for (var i = 0; i < nodes.length; i++) {
      var val = lookup(lang, nodes[i].getAttribute('data-i18n-html'));
      if (val !== null) nodes[i].innerHTML = val;
    }
  }

  function clearPending() {
    document.documentElement.removeAttribute('data-i18n-pending');
  }

  function apply(lang, announce) {
    var target = normalize(lang) || FALLBACK;
    try {
      document.documentElement.lang = target;
      applyText(target);
      applyHtml(target);
      applyAttrs(target);
    } finally {
      // 任何异常都不能让 body 一直藏在 visibility:hidden 后面
      clearPending();
    }
    var sel = document.getElementById('lang-select');
    if (sel && sel.value !== target) sel.value = target;
    if (announce) {
      try {
        document.dispatchEvent(new CustomEvent('openterminal:langchange', { detail: { lang: target } }));
      } catch (e) {
        var ev = document.createEvent('Event');
        ev.initEvent('openterminal:langchange', true, true);
        ev.detail = { lang: target };
        document.dispatchEvent(ev);
      }
    }
    return target;
  }

  // 头部内联脚本已经定好语言；这里只是把它落到 DOM 上
  var current = apply(document.documentElement.lang || FALLBACK, false);

  var select = document.getElementById('lang-select');
  if (select) {
    select.value = current;
    select.addEventListener('change', function () {
      var next = normalize(select.value) || FALLBACK;
      try { localStorage.setItem(STORAGE_KEY, next); } catch (e) {}
      current = apply(next, true);
    });
  }

  window.OPENTERMINAL_SET_LANG = function (lang) {
    current = apply(lang, true);
    try { localStorage.setItem(STORAGE_KEY, current); } catch (e) {}
    return current;
  };
  window.OPENTERMINAL_I18N_SUPPORTED = SUPPORTED.slice();
})();
