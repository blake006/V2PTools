// Package mihomo 是 mihomo 内核的 gomobile 入口。
//
// 为什么需要它：Android 的 VPN 必须由 VpnService 提供 TUN fd，并且内核自己发出的
// socket 必须逐个 VpnService.protect()，否则流量会回环进自己的 TUN、直接断网。
// 独立 mihomo 二进制做不到这两点，只能编成 AAR 在同进程里跑。
//
// gomobile bind 会生成 mihomo.Mihomo（静态方法）和 mihomo.Protector（接口）。
package mihomo

import (
	"errors"
	"syscall"

	"github.com/metacubex/mihomo/component/dialer"
	"github.com/metacubex/mihomo/constant"
	"github.com/metacubex/mihomo/hub/executor"
)

// Protector 由 Kotlin 侧实现，内部转调 VpnService.protect(fd)。
type Protector interface {
	Protect(fd int) bool
}

var protector Protector

// SetProtector 必须在 Start 之前调用；为空时不做 socket 保护（仅适合非 VPN 场景）。
func SetProtector(p Protector) {
	protector = p
}

// SetHomeDir 设置内核工作目录（放 geo 数据、缓存）。AAR 没有「当前目录」概念，必须显式给。
func SetHomeDir(dir string) {
	constant.SetHomeDir(dir)
}

// Start 解析配置并启动内核。
// fd > 0 时进入 VPN 模式：把 fd 写进 tun 配置，并装上 socket 保护钩子。
func Start(config string, fd int) error {
	if fd > 0 {
		dialer.DefaultSocketHook = func(network, address string, c syscall.RawConn) error {
			p := protector
			if p == nil {
				return nil
			}
			var perr error
			if err := c.Control(func(f uintptr) {
				if !p.Protect(int(f)) {
					perr = errors.New("protect socket failed")
				}
			}); err != nil {
				return err
			}
			return perr
		}
	}

	cfg, err := executor.ParseWithBytes([]byte(config))
	if err != nil {
		return err
	}

	if fd > 0 {
		// fd 由 VpnService 提供，路由/网卡都由系统侧配好，内核不要再去动
		cfg.General.Tun.Enable = true
		cfg.General.Tun.FileDescriptor = fd
		cfg.General.Tun.AutoRoute = false
		cfg.General.Tun.AutoDetectInterface = false
	}

	executor.ApplyConfig(cfg, true)
	return nil
}

// Stop 关闭内核并释放监听端口。
func Stop() {
	executor.Shutdown()
	dialer.DefaultSocketHook = nil
}
