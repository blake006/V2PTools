'use strict';

/**
 * Windows 系统代理设置管理（WinINET / 系统「Internet 选项」）
 *
 * 关键点：
 * - 写的是当前用户注册表 HKCU\...\Internet Settings，**不需要管理员权限**
 * - 修改前把原始值完整备份到 dataDir/sysproxy-backup.json，关闭代理时原样还原
 * - 修改后通过 WinINET InternetSetOption + WM_SETTINGCHANGE 广播，让已运行的程序立即生效
 * - 异常退出（崩溃 / 断电）后，下次启动可凭备份文件还原，避免系统代理被锁死在失效端口
 * - 备份文件会随「删掉旧便携版 / 清空 userData」一起消失，所以另外在注册表
 *   HKCU\Software\V2PTools\ProxyOwner 写一个归属标记：只要系统代理是我们开的，
 *   哪怕配置全没了也能认出来并复位（1.5.0 之前正是这里漏了导致开机整机断网）
 */

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const REAL_REG_ROOT = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
/** 归属标记：不放在 Internet Settings 里，避免污染 IE/系统设置；独立于 userData */
const OWNER_KEY = 'HKCU\\Software\\V2PTools\\ProxyOwner';

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
  // 就会因为节点连不通 127.0.0.1 而返回 502；更糟的是本工具自己的
  // 控制器 /version、其它代理工具的本地 API 也全被劫持，表现为「谁都开不了代理」。
].join(';');

/**
 * 清洗用户自定义 bypass：
 *  - 去掉 <-loopback>（历史版本误加过，是「回环流量被劫持」的元凶；
 *    去掉它即恢复 Windows 默认的回环绕过，不需要额外补条目）
 *  - 去掉重复项
 * 只做减法、不擅自往用户的自定义列表里加内容，避免改掉用户精心配置的规则。
 */
function sanitizeBypass(raw) {
  const parts = String(raw || '')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s && s !== '<-loopback>');
  return [...new Set(parts)].join(';');
}

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
    // 归属标记键可注入：单测指向临时键，绝不碰真实 HKCU\Software\V2PTools
    this.ownerKey = opts.ownerKey || OWNER_KEY;
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
      autoDetect: Number(pick('AutoDetect')) ? 1 : 0,
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
    // 不还原的话用户原有的「自动检测设置」就被永久改了。
    // 类型是 REG_DWORD，不能写成 REG_SZ —— 之前写错类型会让 read() 把 '0' 当成真值。
    await put('AutoDetect', 'REG_DWORD', snap.autoDetect ? 1 : 0);
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

  /* ---------------- 归属标记 ---------------- */

  /**
   * 「这次系统代理是我开的」写进注册表。
   * 必须先写标记再改 ProxyEnable：万一写到一半进程被杀，
   * 下次启动至少还能据此认出这个 127.0.0.1:xxxx 是孤儿。
   */
  async markOwner(server, extra = {}) {
    if (!this.supported) return false;
    const vals = {
      Target: server,
      StartedAt: new Date().toISOString(),
      Pid: String(process.pid),
      Winhttp: extra.winhttp ? '1' : '0',
    };
    for (const [name, value] of Object.entries(vals)) {
      // eslint-disable-next-line no-await-in-loop
      await this.run('reg', ['add', this.ownerKey, '/v', name, '/t', 'REG_SZ', '/d', value, '/f']);
    }
    return true;
  }

  async readOwner() {
    if (!this.supported) return null;
    const r = await this.run('reg', ['query', this.ownerKey]);
    if (!r.ok) return null;
    const vals = parseRegQuery(r.stdout);
    const target = vals.Target ? String(vals.Target.value) : '';
    if (!target) return null;
    return {
      target,
      startedAt: vals.StartedAt ? String(vals.StartedAt.value) : '',
      pid: vals.Pid ? Number(vals.Pid.value) || 0 : 0,
      winhttp: !!(vals.Winhttp && String(vals.Winhttp.value) === '1'),
    };
  }

  async clearOwner() {
    if (!this.supported) return false;
    const r = await this.run('reg', ['delete', this.ownerKey, '/f']);
    return r.ok;
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
    // 用户自定义里可能残留历史版本的 <-loopback>，必须清掉：
    // 它会让 127.0.0.1 也走代理，连本工具自己的控制器和其它代理工具的本地 API 都连不上
    const bypass = sanitizeBypass(opts.bypass || DEFAULT_BYPASS);
    const server = `${host}:${port}`;

    // 先写归属标记，再动 ProxyEnable。中途被强杀也能靠它认出孤儿设置。
    await this.markOwner(server, { winhttp: !!opts.winhttp });

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
      await this.setValue('AutoDetect', 'REG_DWORD', 0);
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
    const owner = await this.readOwner();
    try {
      if (bk && bk.values) {
        await this.writeSnapshot(bk.values);
      } else {
        // 备份丢了（删掉旧便携版 / 清空 userData）：不能只关开关就完事。
        // ProxyServer 若还指向我们那个已经死掉的端口，某些程序/下次开机仍会去连它。
        await this.forceDirect(owner ? owner.target : '');
      }
    } catch (err) {
      this.lastError = err.message;
      // 兜底：哪怕 writeSnapshot 半路失败，也先把开关关掉，
      // 绝不能把用户留在「系统代理指向死端口」的整机断网状态
      await this.setValue('ProxyEnable', 'REG_DWORD', 0).catch(() => {});
      await this.refresh().catch(() => {});
      throw err;
    }
    this.clearBackup();
    await this.clearOwner();
    this.expected = null;
    await this.refresh();

    // 只有我们真的改过 WinHTTP 才还原，避免误重置用户已有的 WinHTTP 代理
    if (this.winhttpApplied || (bk && bk.winhttp) || (owner && owner.winhttp)) {
      const r = await this.run('netsh', ['winhttp', 'reset', 'proxy'], 8000);
      if (!r.ok) {
        this.lastError = 'WinHTTP 代理还原失败（通常需要管理员权限），可在「一键修复网络」里重试';
      }
      this.winhttpApplied = false;
    }
    return { ok: true };
  }

  /**
   * 无备份时的强制直连：只清理「确定是我们留下的」痕迹，不碰用户其它设置。
   *  - ProxyEnable 归零
   *  - ProxyServer 只在等于我们的 target（或本工具默认端口段）时删除
   *  - ProxyOverride 去掉 <-loopback>，避免回环继续被劫持
   *  - AutoConfigURL 指向本机且已失效时删除
   */
  async forceDirect(target = '') {
    const cur = await this.read();
    await this.setValue('ProxyEnable', 'REG_DWORD', 0);
    if (cur && cur.proxyServer) {
      const isOurs = (target && cur.proxyServer === target) || /^127\.0\.0\.1:789\d$/.test(cur.proxyServer);
      if (isOurs) await this.deleteValue('ProxyServer');
    }
    if (cur && cur.proxyOverride && /<-loopback>/i.test(cur.proxyOverride)) {
      await this.setValue('ProxyOverride', 'REG_SZ', sanitizeBypass(cur.proxyOverride));
    }
    // 只清本工具的 PAC：用户自己 / 公司内网部署的本地 PAC 不能动
    if (
      cur &&
      cur.autoConfigUrl &&
      (/v2ptools/i.test(cur.autoConfigUrl) || /^https?:\/\/(?:127\.0\.0\.1|localhost):789\d/i.test(cur.autoConfigUrl))
    ) {
      await this.deleteValue('AutoConfigURL');
    }
    await this.clearOwner();
    await this.refresh();
    return true;
  }

  /** 关闭系统代理（restore 的别名，语义更清楚） */
  async disable() {
    return this.restore();
  }

  /**
   * 启动时检查是否有上次异常退出遗留的代理设置。
   *
   * 归属标记优先级高于备份文件：备份会随 userData 一起被删掉（用户删了旧便携版就发生过），
   * 但注册表标记还在，仍能认出「这个 127.0.0.1 是我们开的」并复位。
   * 只有当前 ProxyServer 正好等于我们写入的地址时才动，避免误改用户手动设置的代理。
   */
  async recoverIfStale() {
    const bk = this.readBackup();
    const owner = await this.readOwner();
    const target = (bk && bk.target) || (owner && owner.target) || '';
    if (!target) return { recovered: false };
    const cur = await this.read();
    if (!cur) return { recovered: false };
    const same = cur.proxyServer === target;
    if (!same) {
      // 用户已经自己改过代理，两个标记都失效，清掉免得以后误判
      this.clearBackup();
      await this.clearOwner();
      return { recovered: false, dropped: true };
    }
    await this.restore();
    return { recovered: true, target, original: bk && bk.values ? bk.values : null, viaOwner: !bk };
  }

  /** 当前状态 */
  async status() {
    if (!this.supported) {
      return { supported: false, active: false, server: '', bypass: '', backup: null };
    }
    const cur = await this.read();
    const bk = this.readBackup();
    const owner = await this.readOwner();
    const server = cur ? cur.proxyServer : '';
    const ourTarget = (bk && bk.target) || (owner && owner.target) || '';
    const active = !!(cur && cur.proxyEnable === 1 && server && ourTarget && ourTarget === server);
    return {
      supported: true,
      active,
      server,
      bypass: cur ? cur.proxyOverride : '',
      proxyEnable: cur ? cur.proxyEnable : 0,
      autoConfigUrl: cur ? cur.autoConfigUrl : '',
      autoDetect: cur ? cur.autoDetect : 0,
      backup: bk ? { createdAt: bk.createdAt, target: bk.target, original: bk.values } : null,
      owner: owner || null,
      lastError: this.lastError,
      refreshedAt: this.lastRefreshAt,
    };
  }
}

module.exports = { SystemProxy, DEFAULT_BYPASS, REAL_REG_ROOT, OWNER_KEY, TRACKED, sanitizeBypass, parseRegQuery };
