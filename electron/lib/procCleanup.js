'use strict';

/**
 * 内核子进程的「残留清理」。
 *
 * Windows 不会在父进程被强杀（任务管理器结束 / 崩溃 / 蓝屏前的异常退出）时
 * 自动回收子进程，mihomo 会变成孤儿继续占着端口和内存。这里用 pid 文件记录，
 * 下次启动时把「上次遗留、且进程名确实是 mihomo」的进程清掉。
 *
 * 关键安全约束：**只杀 pid 对得上、且进程名匹配的进程**。
 * pid 会被系统复用，若只凭 pid 就 kill，可能误杀用户刚打开的其它程序。
 */

const fs = require('fs');
const { execFileSync } = require('child_process');

/** 读取 pid 文件，返回正整数 pid；文件缺失/内容非法返回 0 */
function readPid(file) {
  try {
    const n = parseInt(String(fs.readFileSync(file, 'utf8')).trim(), 10);
    return Number.isInteger(n) && n > 0 ? n : 0;
  } catch (e) {
    return 0;
  }
}

function removePid(file) {
  try {
    fs.unlinkSync(file);
  } catch (e) {}
}

/** 进程是否存活（发送信号 0 仅探测，不真正杀） */
function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM'; // 存在但无权限，也算活着
  }
}

/** 进程名是否包含关键字（查不到就返回 false，宁可不杀） */
function nameMatches(pid, keyword) {
  const kw = String(keyword || '').toLowerCase();
  if (!kw) return false;
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
        timeout: 3000,
        windowsHide: true,
        encoding: 'utf8',
      });
      return String(out || '').toLowerCase().includes(kw);
    }
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], {
      timeout: 3000,
      encoding: 'utf8',
    });
    return String(out || '').toLowerCase().includes(kw);
  } catch (e) {
    return false;
  }
}

/**
 * 清理 pid 文件指向的残留内核。
 * 返回 1 表示确实杀掉了一个残留进程，0 表示没有（或无法安全确认）。
 */
function cleanupStale(pidFile, keyword = 'mihomo') {
  const pid = readPid(pidFile);
  if (!pid) {
    removePid(pidFile);
    return 0;
  }
  if (!isAlive(pid) || !nameMatches(pid, keyword)) {
    removePid(pidFile);
    return 0;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch (e) {
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/F'], { timeout: 3000, windowsHide: true });
    } catch (e2) {}
  }
  removePid(pidFile);
  return 1;
}

/** 写入当前进程 pid（启动内核后调用） */
function writePid(file, pid) {
  try {
    fs.writeFileSync(file, String(pid), 'utf8');
  } catch (e) {}
}

module.exports = { readPid, removePid, isAlive, nameMatches, cleanupStale, writePid };
