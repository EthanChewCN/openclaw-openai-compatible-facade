# v0.1.1

这个版本是一次收口性质的维护更新，重点不在新增功能，而在把现有方案的安全边界、回滚对称性和安装完成判定做得更稳。

## 这次改了什么

- facade 现在会校验 provider 和上游地址是否匹配，不再接受任意 header 指向任意第三方上游
- 安装脚本会记录 Gateway 环境快照
- 卸载脚本会按快照恢复 Gateway 环境，而不是写死回默认值
- 生成的运行时文件、快照和备份文件权限已经收紧
- macOS 安装流程增加了服务可达性校验，避免在 facade 或 Gateway 还没真正起来时误报成功

## 为什么要发这个版本

`v0.1.0` 已经把整体思路跑通了，但项目层还存在几个需要收口的点：

- facade 路由边界不够严
- 回滚不是严格对称
- 安装成功和服务真正可用之间还存在空档

这一版就是把这些问题补掉。

## 当前状态

- 方案主路径仍然不改 OpenClaw 源码
- `custom-beehears` 主 Agent 链路保持可用
- `custom-memory` 的多 provider 路由能力仍然保留
- Debian / Ubuntu 的 `systemd --user` 支持继续保留为实验性支持

## 仍然需要知道的边界

- Gateway 依然会全局带 `HTTP_PROXY` / `HTTPS_PROXY`
- facade 仍然是当前 Gateway 出站链路的一部分
- 这套方案依然只面向第三方 OpenAI-compatible `Responses` provider

## 升级建议

如果你已经在用 `v0.1.0`：

1. 拉取最新代码
2. 重新运行安装脚本
3. 再做一次最小验证：
   - `openclaw status`
   - `openclaw agent --agent main --message "reply with exactly ok" --json --timeout 60`
