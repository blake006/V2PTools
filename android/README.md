# V2PTools · Android

桌面版 [V2PTools](../V2PTools) 的安卓实现。**导入代理 → 批量体检 → 挑好线路 → 一键走代理。**

界面用 WebView 承载（复用桌面端已验证的解析 / 筛选 / 导出逻辑），
原生层负责 mihomo 内核进程、真实网络请求与 VPN。

---

## 功能对照

| 桌面版 | 安卓版 | 说明 |
|---|---|---|
| 批量链接 / 订阅 / 单条 / 文件导入 | ✅ | 复用 `parser.js`，格式自动识别 |
| 延迟 / 抖动 | ✅ | 每节点独立端口并发测 |
| 下载测速 | ✅ | 可配字节数 |
| 出口 IP + 归属地 | ✅ | ip-api，走被测节点 |
| DNSBL 黑名单 | ✅ | DoH 查询 zen.spamhaus.org |
| 健康度评分 | ✅ | 延迟 40 + 抖动 20 + 速度 25 + 干净 15 |
| 分组 / 筛选 / 搜索 | ✅ | 复用 `filter.js` |
| 全局 / 绕过大陆 / 仅名单 | ✅ | 同一套规则文件（11 万条 CN 域名） |
| 导出 CSV / JSON / TXT / Clash | ✅ | Clash 配置可直接给内核用 |
| 系统代理 | ✅ 两种方式 | 见下方「代理的两种模式」 |
| 6 态代理状态显示 | ✅ 简化版 | 顶部状态徽标 |

---

## 代理的两种模式

### 1. 代理模式（始终可用）

mihomo 起一个 mixed 端口（默认 7890），你在 **设置 → WLAN → 当前网络 → 代理 → 手动**
里填 `127.0.0.1` + `7890`。这是 Android 上最接近桌面「系统代理」的做法，
浏览器和遵循系统代理的应用都会走。

App 里点「开启代理」后会提示端口号，也可一键跳到 Wi-Fi 设置。

### 2. VPN 模式（需要额外集成 libcore）

Android 的全局代理只能通过 `VpnService` 建 TUN，再把 TUN 的 fd 交给用户态网络栈。
**mihomo 作为独立进程无法接收外部 fd**（配置里没有 fd 字段），所以必须用
gomobile 编出来的 `libcore`。

集成方法：

```bash
# 1. 准备 gomobile
go install golang.org/x/mobile/cmd/gomobile@latest
gomobile init

# 2. 取 mihomo 的 android 库源码
git clone https://github.com/MetaCubeX/mihomo
cd mihomo && git checkout <你的版本>

# 3. 编译（需要 Android NDK）
gomobile bind -target=android/arm64 -androidapi 26 -o libcore.aar ./constant/... 
# 具体包路径以 mihomo 仓库的 mobile 入口为准

# 4. 放到项目里
cp libcore.aar android/app/libs/
```

放进去后 Gradle 会自动引入（`app/build.gradle.kts` 里有条件判断），
`LibcoreBridge` 通过反射调用 `startTUN(fd, home, config)`。若签名不匹配，
`vpnHint` 会显示具体原因，按提示调整 `LibcoreBridge.kt` 里的候选签名即可。

> 没有 libcore 时 App **仍可正常编译运行**，只是 VPN 按钮置灰 —— 这是刻意设计，
> 避免把可选的原生依赖变成编译门槛。

---

## 构建

```bash
cd android

# 1. 下载 mihomo 安卓内核（约 15-20MB）
node scripts/fetch-core.js
#   或手动：https://github.com/MetaCubeX/mihomo/releases
#   解压后放到 app/src/main/jniLibs/arm64-v8a/libmihomo.so

# 2. 同步桌面端的共享逻辑与规则文件
node scripts/sync-web.js

# 3. 构建
./gradlew assembleDebug
# 产物：app/build/outputs/apk/debug/app-debug.apk
```

要求：JDK 17、Android SDK 34、NDK 不需要（除非自己编 libcore）。

> 仓库里只带了 `gradle-wrapper.properties`，没有 `gradle-wrapper.jar`（二进制）。
> 用 Android Studio「Open」打开本目录，它会自动补全 wrapper；
> 或者本地执行一次 `gradle wrapper --gradle-version 8.7` 生成。

---

## 用 GitHub Actions 构建（推荐，不用本地装工具链）

仓库带了 `.github/workflows/android.yml`：推到 `main` 或手动触发，
云端会自动装 JDK 17 + Android SDK 34、下内核、编 APK，产物在
Actions 页面的 Artifacts 里下载（保留 30 天）。

手动触发：Actions → **Build Android APK** → Run workflow。

好处是不用本地装 JDK/SDK；编译错误也会直接出现在日志里。
默认只编 `arm64-v8a`（绝大多数手机），需要 32 位可选 `all`。

---

## 目录

```
app/src/main/
├── java/com/v2ptools/android/
│   ├── App.kt              Application + 通知渠道
│   ├── MainActivity.kt     WebView 宿主 + JS 桥（文件选择/保存/异步回调）
│   ├── ProxyService.kt     前台服务：持有内核进程，继承 VpnService
│   ├── MihomoCore.kt       内核二进制解析、配置落盘、启停、状态
│   ├── Probe.kt            延迟/抖动/速度/出口IP/DNSBL（走指定端口）
│   ├── LibcoreBridge.kt    VPN 适配（反射，可选依赖）
│   └── Store.kt            SharedPreferences KV
├── assets/
│   ├── rules/              三份分流规则（11 万条 CN 域名等）
│   └── web/
│       ├── index.html      移动端界面
│       ├── app.js          导入/体检调度/代理/导出
│       ├── style.css
│       └── vendor/         parser / filter / merge / clash / configgen / js-yaml
└── res/
```

`assets/web/vendor/` 里除了 `configgen.js` 和 `loader.js` 是安卓独有，
其余都是 `scripts/sync-web.js` 从桌面项目复制并包装的，**不要手改**。

---

## 关键设计：每节点一个监听端口

mihomo 配置里给每个节点开一个 listener：

```yaml
listeners:
  - name: probe-0
    type: mixed
    port: 20000
    listen: 127.0.0.1
    proxy: HK-01        # 绑死到该节点，绕过分流规则
```

好处是测速可以**并发**，不用反复切换 selector（切换只能串行，慢且易错）。

这个字段是否真的生效**必须验证** —— 如果内核忽略 `proxy`，所有节点都会测出
主出口的结果，看起来全绿实际全错。`scripts/verify-listeners.js` 就是干这个的：
绑一个 `direct` 节点（应通）和一个死节点（应不通），两者行为不同才说明字段生效。

---

## 测试

```bash
# 配置生成 + mihomo -t 语法校验（15 项）
node scripts/test-config.js

# listeners[].proxy 是否真的生效（3 项，决定性验证）
node scripts/verify-listeners.js

# 浏览器包冒烟：模拟 WebView 加载顺序，验证解析/筛选/导出/配置生成（22 项）
node scripts/test-web-bundle.js
```

`test-web-bundle` 在 Node 的 `vm` 沙箱里模拟 `window`/`atob`/`URL`，
按 `index.html` 的顺序加载 vendor 脚本，跑真实的解析与配置生成。
安卓端 WebView 里跑的就是这套代码，所以这个测试很有意义。

---

## 已验证 / 未验证

**已验证（本机可跑）**

- 配置生成正确性，`mihomo -t` 通过（含 `listeners[].proxy`）
- `listeners[].proxy` 真实生效（决定性对比实验）
- 浏览器包：订阅解析、筛选、合并去重、Clash 导出、配置生成
- 三种分流模式生成的规则顺序与 provider 正确

**未验证（本机没有 JDK / Android SDK，无法编译）**

- Kotlin 代码能否编译（按标准 API 写的，但没跑过编译器）
- APK 实际运行表现
- VPN 模式（还依赖 libcore，反射签名需按实际 AAR 调整）

第一次构建如果报编译错误，大概率是小的 API 差异，按提示改即可。

---

## 已知限制

- 代理模式依赖用户手动设置 Wi-Fi 代理，不是真正「一键全局」
- VPN 模式需要自行编译 libcore.aar
- 测速端口从 20000 起，最多 200 个节点（超过的部分不参与体检）
- DNSBL 用 DoH，部分网络环境下可能查不通，此时该节点记为「未查」而非「干净」
