# V2PTools · 代理体检 + 一键系统代理

在 [IPHealth](https://github.com/blake006/IPHealth) 基础上扩展的 Windows 桌面工具：

**导入代理 → 批量体检 → 挑一条好线路 → 一键把系统代理切过去。**

原版 IPHealth 只做检测、明确不碰系统代理；V2PTools 补上了「选中的节点直接变成电脑的系统代理」这一段，
用内置 mihomo 内核起一个本地 mixed 端口（HTTP + SOCKS 同端口），再把 Windows 的 Internet 选项指过去。

---

## 与原版 IPHealth 的差异

| | IPHealth | V2PTools |
|---|---|---|
| 代理池导入 / 体检 / 分组筛选 | ✅ | ✅（原样保留） |
| 修改系统代理 | ❌ 明确不做 | ✅ 工具栏按钮 / 行内按钮 / 详情抽屉 |
| 内核用途 | 每节点一个监听端口，仅用于检测 | 检测内核 + **独立的系统代理内核**（互不干扰） |
| 退出行为 | 关内核 | 关内核 **并还原系统代理** |

新增文件：

```
electron/lib/sysproxy.js    Windows 系统代理读写（注册表 + 备份还原 + 生效刷新）
electron/lib/gateway.js     系统代理专用内核（单 mixed 端口 + MATCH,PROXY）
scripts/test-sysproxy.js    系统代理模块测试（31 项）
scripts/test-gateway.js     网关配置 + 真实内核启动测试（24 项）
```

改动文件：`electron/main.js`、`electron/preload.js`、`electron/lib/store.js`、
`renderer/index.html`、`renderer/app.js`、`renderer/style.css`、`package.json`、`build/portable.nsi`。

---

## 使用

1. `npm install` → `npm run fetch-core` → `npm start`
   （或直接用打包好的 `V2PTools-<版本>-win-x64-portable.exe`）
2. 「导入代理」：批量链接 / 订阅地址 / 单条添加 / 文件导入，格式自动识别。
3. 「全面检测」：延迟、抖动、速度、出口 IP 归属地、DNSBL、健康度评分。
4. 挑一条线路，三种方式开启系统代理：
   - 工具栏「系统代理」按钮（作用于勾选的节点，或列表里唯一的节点）
   - 表格行末的电源图标
   - 详情抽屉里的「设为系统代理」
5. 已开启时点其它节点的电源图标 = **无缝换节点**（端口不变，不重新写注册表）。

开启后标题栏徽标变绿，显示当前出口节点；工具栏按钮显示 `代理 :7890`。再点一次即关闭并还原。

---

## 工作原理

```
应用进程
 ├── CoreManager（检测用内核，每节点一个端口）      ← 与系统代理完全隔离
 └── Gateway（系统代理内核）
       mihomo: mixed-port 7890 → proxies[PROXY] → 选中节点
                │
                └── Windows 系统代理 = 127.0.0.1:7890
```

* **写入位置**：`HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`
  - `ProxyEnable = 1`
  - `ProxyServer = 127.0.0.1:<端口>`
  - `ProxyOverride = localhost;127.*;10.*;172.16.*;…;192.168.*;<local>`
  - `AutoConfigURL` 临时移除（PAC 优先级高于固定代理，原值会备份）
* **写当前用户键，不需要管理员权限**，不改系统级设置，不动 `HKLM`。
* **立即生效**：`wininet.dll!InternetSetOption`（`SETTINGS_CHANGED` + `REFRESH`）+ 广播 `WM_SETTINGCHANGE`，
  让已运行的浏览器 / 客户端马上改用新代理，不用重启。
* **WinHTTP 可选**：设置里可勾选同时写入 WinHTTP 代理（影响系统服务，通常需要管理员权限，默认关闭）。

---

## 安全设计（重点）

改系统代理最怕「改完没还原，电脑上不了网」。这里做了五层兜底：

1. **先备份后修改**：改之前把 `ProxyEnable / ProxyServer / ProxyOverride / AutoConfigURL` 原样存到
   `<userData>\sysproxy\sysproxy-backup.json`，还原时逐字段写回（原本不存在的值会被删除，不会留空值污染）。
2. **关闭即还原**：点关闭 → 先还原注册表，再停内核（顺序反了会有短暂断网）。
3. **退出即还原**：`before-quit` 里强制还原再退出，拦截默认退出流程。
4. **内核异常退出自动还原**：代理内核崩了会立刻还原系统代理并弹提示，不会让电脑指着死端口。
5. **崩溃残留恢复**：上次被强杀 / 断电，下次启动检测到备份文件且当前代理地址正是我们写的那个，自动还原；
   如果地址已被用户改过（说明用户自己设了别的代理），只丢弃备份，**绝不覆盖用户的手动设置**。

另外：代理内核启动失败时会回滚注册表，不会留下半配置状态。

---

## 设置项

设置 →「系统代理」：

| 项 | 说明 |
|---|---|
| 本地监听端口 | 默认 `7890`，被占用自动顺延，实际端口以界面显示为准 |
| 绕过代理的地址 | 分号分隔，留空用默认内网列表 |
| WinHTTP 代理 | 可选，需管理员权限 |

---

## 已知限制

- 仅支持 **Windows**（macOS / Linux 需要各自的 `networksetup` / `gsettings` 实现，未做）。
- **UWP / Microsoft Store 应用**默认禁止访问 `127.0.0.1`，需要执行一次回环豁免：
  `CheckNetIsolation LoopbackExempt -a -n=<包名>`（本工具不会自动改，避免动系统策略）。
- 部分企业安全策略会把 `reg.exe` 拉黑，此时开启会失败并明确提示「写入注册表失败」。
- 生效刷新依赖 PowerShell；若被拦截则跳过刷新（多数程序会在新连接时自行重读注册表，但已开的程序可能要重启）。

---

## 开发

```bash
npm install
npm run fetch-core        # 下载 mihomo 内核到 vendor/mihomo.exe
npm start                 # 运行
npm run dev               # 带 DevTools

npm run test-sysproxy     # 系统代理逻辑（31 项；沙箱禁用 reg.exe 时自动切内存注册表模式）
npm run test-gateway      # 网关配置 + 真实内核启动（24 项）
node scripts/test-parser.js   # 原有：21 种导入格式
node scripts/test-filter.js   # 原有：筛选逻辑
```

调试：`V2P_DEBUG=1` 会在 `<userData>` 下写 `boot.log`（启动阶段）与 `smoke.json`（界面自检）；
`V2P_EXIT_AFTER=8000` 启动 8 秒后自动退出（走完整还原流程）。打包版没有控制台，靠这两个文件排错。

### 打包

```bash
npx electron-builder --win zip      # → dist/V2PTools-<版本>-win-x64.zip + dist/win-unpacked/
makensis build/portable.nsi         # → dist/V2PTools-<版本>-win-x64-portable.exe（单文件）
```

`npm run dist:exe` 等价于第二条，但要求 `makensis` 在 PATH 里。
若没装 NSIS，可以直接用 electron-builder 自带的那份：

```bash
"$LOCALAPPDATA/electron-builder/Cache/nsis-3.0.4.1/bin/makensis.exe" build/portable.nsi
```

单文件便携版的机制：启动时把内置文件解压到 `%TEMP%\V2PTools-<版本>` 再运行，
所以每次启动有几秒解压时间；配置仍存在 `%APPDATA%\V2PTools`，与安装版共用。

> 注意：如果当前 shell 里存在 `ELECTRON_RUN_AS_NODE=1`，打包后的 exe 会被当成 Node 运行
> （表现为 `V2PTools.exe --version` 输出 `v20.18.1` 而不是 Electron 版本、界面不出现）。
> 用 `env -u ELECTRON_RUN_AS_NODE` 启动，或直接在资源管理器里双击。


---

## License

MIT，基于 [IPHealth](https://github.com/blake006/IPHealth)（MIT, © black-ant）扩展。
原项目结构与检测逻辑保持不变，新增部分同样以 MIT 发布。
