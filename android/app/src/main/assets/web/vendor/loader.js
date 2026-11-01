/**
 * 浏览器端垫片
 *
 * 1) 极简 CommonJS：给 vendor 里被包装的模块提供 require('js-yaml')
 * 2) 极简 Buffer：parser.js 只用到 Buffer.from(s,'base64').toString('utf8')
 *    WebView 没有 Node 的 Buffer，不补这里订阅解析会静默返回 0 个节点
 */
(function () {
  'use strict';

  window.__require = function (name) {
    if (name === 'js-yaml') {
      if (!window.jsyaml) throw new Error('js-yaml 未加载');
      return window.jsyaml;
    }
    throw new Error('模块不可用: ' + name);
  };

  window.V2P = window.V2P || {};

  /** UTF-8 字节 → 字符串（不依赖 TextDecoder） */
  function utf8Decode(bytes) {
    var out = '';
    var i = 0;
    while (i < bytes.length) {
      var c = bytes[i++];
      if (c < 0x80) {
        out += String.fromCharCode(c);
      } else if (c >= 0xc0 && c < 0xe0 && i < bytes.length) {
        out += String.fromCharCode(((c & 0x1f) << 6) | (bytes[i++] & 0x3f));
      } else if (c >= 0xe0 && c < 0xf0 && i + 1 < bytes.length) {
        out += String.fromCharCode(
          ((c & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f)
        );
      } else if (c >= 0xf0 && i + 2 < bytes.length) {
        var cp =
          ((c & 0x07) << 18) |
          ((bytes[i++] & 0x3f) << 12) |
          ((bytes[i++] & 0x3f) << 6) |
          (bytes[i++] & 0x3f);
        cp -= 0x10000;
        out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
      } else {
        out += '\ufffd';
      }
    }
    return out;
  }

  /** base64（含 URL-safe 变体与缺省 padding）→ 字节数组 */
  function base64ToBytes(input) {
    var s = String(input == null ? '' : input)
      .replace(/[-_]/g, function (m) {
        return m === '-' ? '+' : '/';
      })
      .replace(/[^A-Za-z0-9+/=]/g, '');
    while (s.length % 4 !== 0) s += '=';
    var bin = window.atob ? window.atob(s) : null;
    if (bin == null) throw new Error('atob 不可用');
    var bytes = new Array(bin.length);
    for (var i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function MiniBuffer(bytes) {
    this.bytes = bytes;
  }
  MiniBuffer.prototype.toString = function (enc) {
    if (!enc || /^utf-?8$/i.test(enc)) return utf8Decode(this.bytes);
    if (/^latin1$|^binary$/i.test(enc)) {
      return this.bytes.map(function (b) { return String.fromCharCode(b); }).join('');
    }
    if (/^hex$/i.test(enc)) {
      return this.bytes
        .map(function (b) { return (b < 16 ? '0' : '') + b.toString(16); })
        .join('');
    }
    return utf8Decode(this.bytes);
  };

  if (typeof window.Buffer === 'undefined') {
    window.Buffer = {
      from: function (input, enc) {
        if (enc === 'base64' || /^base64url$/i.test(enc || '')) {
          return new MiniBuffer(base64ToBytes(input));
        }
        if (enc === 'hex') {
          var s = String(input || '');
          var arr = [];
          for (var i = 0; i + 1 < s.length; i += 2) arr.push(parseInt(s.substr(i, 2), 16));
          return new MiniBuffer(arr);
        }
        // 普通字符串：按 UTF-8 取字节
        var str = String(input == null ? '' : input);
        var out = [];
        for (var j = 0; j < str.length; j += 1) {
          var c = str.charCodeAt(j);
          if (c < 0x80) out.push(c);
          else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
          else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
        }
        return new MiniBuffer(out);
      },
      isBuffer: function (o) {
        return o instanceof MiniBuffer;
      }
    };
  }
})();
