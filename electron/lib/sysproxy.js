'use strict';

/**
 * Windows 系统代理设置管理（WinINET / 系统「Internet 选项」）
 *
 * 关键点：
 * - 写的是当前用户注册表 HKCU\...\Internet Settings，**不需要管理员权限**
 * - 修改前把原始值完整备份到 dataDir/sysproxy-backup.json，关闭代理时原样还原
 * - 修改后通过 WinINET InternetSetOption + WM_SETTINGCHANGE 广播，让已运行的程序立即生效
 * - 异常退出（崩溃 / 断电）后，下次启动可凭备份文件还原，避免系统代理被锁死在失效端口
 */

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const REAL_REG_ROOT = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

const BACKUP_NAME = 'sysproxy-backup.json';
const REFRESH_SCRIPT = 'sysproxy-refresh.ps1';

const TRACKED = ['ProxyEnable', 'ProxyServer', 'ProxyOverride', 'AutoConfigURL', 'AutoDetect'];

const DEFAULT_BYPASS = [
  'localhost',
  '127.*',
  '10.*',
  '172.16.*',
  '172.17.*',
  '172.18.*',
  '172.19.*',
  '172.20.*',
  '172.21.*',
  '172.22.*',
  '172.23.*',
  '172.24.*',
  '172.25.*',
  '172.26.*',
  '172.27.*',
  '172.28.*',
  '172.29.*',
  '172.30.*',
  '172.31.*',
  '192.168.*',
  // IPv6 回环与局域网：<local> 只覆盖不含点的主机名，不管 IPv6 地址
  '[::1]',
  '<local>',
  // 注意：这里**不能**加 <-loopback>。
  // 它的语义是「取消 Windows 对回环地址的自动绕过」，
  // 加了之后 127.0.0.1 的请求也会被送进代理，本机服务（如 OpenCode 的本地端口）
  // 就会因为节点连不通 127.0.0.1 而返回 502。
].join(';');

/* ------------------------------------------------------------------ */
/* 底层工具                                                            */
/* ------------------------------------------------------------------ */

function run(file, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({
        ok: !err,
        code,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        error: err ? err.message : '',
      });
    });
  });
}

/** 解析 `reg query` 的输出为 { 名称: { type, value } } */
function parseRegQuery(stdout) {
  const out = {};
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const m = /^\s{2,}(\S+)\s+(REG_[A-Z_]+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const name = m[1];
    const type = m[2];
    const raw = m[3].trim();
    let value = raw;
    if (type === 'REG_DWORD') {
      value = raw.toLowerCase().startsWith('0x') ? parseInt(raw, 16) : parseInt(raw, 10);
      if (Number.isNaN(value)) value = 0;
    }
    out[name] = { type, value };
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* SystemProxy                                                         */
/* ------------------------------------------------------------------ */

class SystemProxy {
  /**
   * @param {object} opts
   * @param {string} opts.dataDir  备份 / 刷新脚本的存放目录
   * @param {string} [opts.regRoot] 注册表键路径（测试时可指向临时键，避免动真实系统设置）
   * @param {string} [opts.platform]
   */
  constructor(opts = {}) {
    this.dataDir = opts.dataDir || process.cwd();
    this.regRoot = opts.regRoot || REAL_REG_ROOT;
    this.platform = opts.platform || process.platform;
    this.refreshEnabled = opts.refresh !== false;
    // 命令执行器，测试时可注入假实现
    this.run = opts.runner || run;
    this.expected = null; // { host, port }
    this.lastRefreshAt = 0;
    this.lastError = '';
  }

  get supported() {
    return this.platform === 'win32';
  }

  get backupPath() {
    return path.join(this.dataDir, BACKUP_NAME);
  }

  ensureDir() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
    } catch (e) {}
  }

  /* ---------------- 读取 ---------------- */

  /** 读取当前系统代理配置；非 Windows 返回 null */
  async read() {
    if (!this.supported) return null;
    const r = await this.run('reg', ['query', this.regRoot]);
    if (!r.ok) {
      // 键不存在（极少见）视为全部为空
      return {
        proxyEnable: 0,
        proxyServer: '',
        proxyOverride: '',
        autoConfigUrl: '',
        autoDetect: 0,
      };
    }
    const vals = parseRegQuery(r.stdout);
    const pick = (name) => (vals[name] ? vals[name].value : null);
    return {
      proxyEnable: pick('ProxyEnable') ? 1 : 0,
      proxyServer: pick('ProxyServer') || '',
      proxyOverride: pick('ProxyOverride') || '',
      autoConfigUrl: pick('AutoConfigURL') || '',
      autoDetect: pick('AutoDetect') ? 1 : 0,
    };
  }

  /* ---------------- 写入 ---------------- */

  async setValue(name, type, value) {
    const r = await this.run('reg', ['add', this.regRoot, '/v', name, '/t', type, '/d', String(value), '/f']);
    if (!r.ok) throw new Error(`写入注册表 ${name} 失败：${(r.stderr || r.error || '').trim()}`);
    return true;
  }

  async deleteValue(name) {
    await this.run('reg', ['delete', this.regRoot, '/v', name, '/f']);
    return true;
  }

  /** 把 read() 的结果整体写回注册表 */
  async writeSnapshot(snap) {
    if (!snap) return false;
    const put = async (name, type, value) => {
      if (value === null || value === undefined || value === '') {
        await this.deleteValue(name);
      } else {
        await this.setValue(name, type, value);
      }
    };
    await put('ProxyEnable', 'REG_DWORD', Number(snap.proxyEnable) ? 1 : 0);
    await put('ProxyServer', 'REG_SZ', snap.proxyServer);
    await put('ProxyOverride', 'REG_SZ', snap.proxyOverride);
    await put('AutoConfigURL', 'REG_SZ', snap.autoConfigUrl);
    // AutoDetect（WPAD 自动检测）必须一起还原：开启代理时我们会把它关掉，
    // 不还原的话用户原有的「自动检测设置」就被永久改了
    await put('AutoDetect', 'REG_SZ', snap.autoDetect ? '1' : '0');
    return true;
  }

  /* ---------------- 备份 ---------------- */

  readBackup() {
    try {
      return JSON.parse(fs.readFileSync(this.backupPath, 'utf8'));
    } catch (e) {
      return null;
    }
  }

  writeBackup(data) {
    this.ensureDir();
    const tmp = this.backupPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, this.backupPath);
  }

  clearBackup() {
    try {
      fs.unlinkSync(this.backupPath);
    } catch (e) {}
  }

  /* ---------------- 生效刷新 ---------------- */

  /**
   * 通知系统设置已变更：
   * InternetSetOption(INTERNET_OPTION_SETTINGS_CHANGED / REFRESH) + 广播 WM_SETTINGCHANGE
   * 走临时 .ps1 文件，避免多层引号转义问题；失败不影响主流程（多数程序会自行重读注册表）
   */
  async refresh() {
    if (!this.supported || !this.refreshEnabled) return false;
    this.ensureDir();
    const scriptPath = path.join(this.dataDir, REFRESH_SCRIPT);
    if (!fs.existsSync(scriptPath)) {
      const script = [
        "$ErrorActionPreference = 'SilentlyContinue'",
        '$src = @"',
        'using System;',
        'using System.Runtime.InteropServices;',
        'public class V2PWinInet {',
        '  [DllImport("wininet.dll", SetLastError = true, CharSet = CharSet.Auto)]',
        '  public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);',
        '  [DllImport("user32.dll", CharSet = CharSet.Auto)]',
        '  public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);',
        '}',
        '"@',
        'Add-Type -TypeDefinition $src',
        '[V2PWinInet]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0) | Out-Null',
        '[V2PWinInet]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0) | Out-Null',
        '$result = [UIntPtr]::Zero',
        "[V2PWinInet]::SendMessageTimeout([IntPtr]65535, 0x1A, [UIntPtr]::Zero, 'Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', 2, 1000, [ref]$result) | Out-Null",
        '',
      ].join('\r\n');
      fs.writeFileSync(scriptPath, script, 'utf8');
    }
    const r = await this.run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      20000
    );
    this.lastRefreshAt = Date.now();
    return r.ok;
  }

  /* ---------------- 对外操作 ---------------- */

  /**
   * 开启系统代理，指向本地网关端口
   * @param {object} opts { host, port, bypass, winhttp }
   */
  async apply(opts = {}) {
    if (!this.supported) throw new Error('系统代理设置仅支持 Windows');
    const host = opts.host || '127.0.0.1';
    const port = Number(opts.port);
    if (!port) throw new Error('缺少代理端口');
    const bypass = opts.bypass || DEFAULT_BYPASS;
    const server = `${host}:${port}`;

    // 已有备份说明是我们自己开的，不要用当前（已被我们改过的）值覆盖原始备份
    if (!this.readBackup()) {
      const current = await this.read();
      this.writeBackup({
        app: 'V2PTools',
        createdAt: new Date().toISOString(),
        regRoot: this.regRoot,
        target: server,
        values: current,
      });
    } else {
      const bk = this.readBackup();
      bk.target = server;
      bk.updatedAt = new Date().toISOString();
      this.writeBackup(bk);
    }

    try {
      await this.setValue('ProxyEnable', 'REG_DWORD', 1);
      await this.setValue('ProxyServer', 'REG_SZ', server);
      await this.setValue('ProxyOverride', 'REG_SZ', bypass);
      // PAC 脚本优先级高于固定代理，开启固定代理时先移除（原始值已备份）
      await this.deleteValue('AutoConfigURL');
      // WPAD 自动检测同样会抢走手动代理设置（部分程序优先用它），必须关掉；
      // 原值已备份，关闭代理时会还原
      await this.setValue('AutoDetect', 'REG_SZ', '0');
    } catch (err) {
      this.lastError = err.message;
      // 写入失败则尽量回滚，避免系统代理停在半配置状态
      await this.restore().catch(() => {});
      throw err;
    }

    this.expected = { host, port };
    await this.refresh();

    if (opts.winhttp) {
      const r = await this.run('netsh', ['winhttp', 'set', 'proxy', server, bypass.replace(/;/g, ' ')], 8000);
      if (r.ok) {
        this.winhttpApplied = true;
        const bk = this.readBackup();
        if (bk) {
          bk.winhttp = true;
          this.writeBackup(bk);
        }
      } else {
        this.lastError = 'WinHTTP 代理设置失败（通常需要管理员权限）：' + (r.stderr || r.error || '').trim();
      }
    }

    return this.status();
  }

  /** 还原为开启前的系统代理配置 */
  async restore() {
    if (!this.supported) return { ok: false, error: '仅支持 Windows' };
    const bk = this.readBackup();
    try {
      if (bk && bk.values) {
        await this.writeSnapshot(bk.values);
      } else {
        // 没有备份：只关掉开关，保留用户原有的 ProxyServer 值
        await this.setValue('ProxyEnable', 'REG_DWORD', 0);
      }
    } catch (err) {
      this.lastError = err.message;
      throw err;
    }
    this.clearBackup();
    this.expected = null;
    await this.refresh();

    // 只有我们真的改过 WinHTTP 才还原，避免误重置用户已有的 WinHTTP 代理
    if (this.winhttpApplied || (bk && bk.winhttp)) {
      const r = await this.run('netsh', ['winhttp', 'reset', 'proxy'], 8000);
      if (!r.ok) {
        /* 需要管理员权限，忽略 */
      }
      this.winhttpApplied = false;
    }
    return { ok: true };
  }

  /** 关闭系统代理（restore 的别名，语义更清楚） */
  async disable() {
    return this.restore();
  }

  /**
   * 启动时检查是否有上次异常退出遗留的代理设置
   * 只有当前 ProxyServer 正好等于我们写入的地址时才还原，避免误改用户手动设置的代理
   */
  async recoverIfStale() {
    const bk = this.readBackup();
    if (!bk || !bk.values) return { recovered: false };
    const cur = await this.read();
    if (!cur) return { recovered: false };
    const same = bk.target && cur.proxyServer === bk.target;
    if (!same) {
      // 用户已经自己改过代理，备份失效，直接丢弃备份
      this.clearBackup();
      return { recovered: false, dropped: true };
    }
    await this.restore();
    return { recovered: true, target: bk.target, original: bk.values };
  }

  /** 当前状态 */
  async status() {
    if (!this.supported) {
      return { supported: false, active: false, server: '', bypass: '', backup: null };
    }
    const cur = await this.read();
    const bk = this.readBackup();
    const server = cur ? cur.proxyServer : '';
    const active = !!(cur && cur.proxyEnable === 1 && server && bk && bk.target === server);
    return {
      supported: true,
      active,
      server,
      bypass: cur ? cur.proxyOverride : '',
      proxyEnable: cur ? cur.proxyEnable : 0,
      autoConfigUrl: cur ? cur.autoConfigUrl : '',
      backup: bk ? { createdAt: bk.createdAt, target: bk.target, original: bk.values } : null,
      lastError: this.lastError,
      refreshedAt: this.lastRefreshAt,
    };
  }
}

module.exports = { SystemProxy, DEFAULT_BYPASS, REAL_REG_ROOT, TRACKED, parseRegQuery };
