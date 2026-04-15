# v0.1.0

首个公开版本。

这个版本整理了一个可独立分享的本地 facade 工具，用来处理 OpenClaw 接第三方 OpenAI-compatible `Responses` provider 时的 prompt cache 丢失问题。目标是尽量把方案收敛在配置层和本地运行时，不要求维护 OpenClaw 源码 patch。

## 包含内容

- 一个通用的本地 facade 代理
- 面向 OpenClaw provider 的一键安装脚本
- 对应的一键回滚脚本
- macOS `LaunchAgent` 支持
- Debian / Ubuntu `systemd --user` 支持（实验性）
- 中文使用文档
- provider -> upstream 白名单校验
- 安装前 Gateway 环境快照与卸载恢复逻辑
- macOS 安装后会显式验证 facade 和 Gateway 已真正可达

## 这个版本解决什么

当第三方 provider 本身支持 `prompt_cache_key`，但 OpenClaw 主 Agent 路径里读不到缓存时，这个工具把 OpenClaw 的请求重新收敛到它认可的 OpenAI 路由，再由本地 facade 转发到真实第三方上游。这样可以避免在 OpenClaw 包内直接打补丁。

## 已验证情况

- `custom-beehears -> https://api.beehears.com`
  - 已完成主 Agent 端到端验证
  - 已确认出现真实 `cacheRead`

- `custom-memory -> https://api.beehears.com`
  - 已完成第二 provider 的 facade 路由验证
  - 已确认同一个 facade 可以按 provider header 路由多个上游映射

## 当前边界

- 这不是通用兼容层，只面向 OpenAI-compatible `Responses` provider
- provider 是否适合作为主聊天模型，仍取决于它自己的 key、模型配额、稳定性和能力边界
- Linux 支持已经进脚本，但当前仓库是在 macOS 环境下完成开发和自检的；如果要在 Debian 或 Ubuntu 上使用，建议先在测试机上跑完整安装、验证和回滚流程
- Gateway 仍然会全局带 `HTTP_PROXY` / `HTTPS_PROXY`，facade 仍是当前出站路径的一部分

## 升级和维护建议

- OpenClaw 升级后，建议重新做一次最小验证
- 如果未来 OpenClaw 原生支持这类第三方 `Responses` provider 的 prompt cache forwarding，这个仓库的价值会下降，届时更适合切回官方能力

## 当前实现补充

- facade 现在会校验 provider 与上游地址是否匹配，不再接受任意 header 指向任意第三方上游
- 安装脚本会把敏感配置备份到权限收紧的目录中
- 卸载脚本会按安装时记录的快照恢复 Gateway 环境，而不是写死回默认值
- macOS 安装流程不会在服务仍未 reachable 时误报成功

## 仓库说明

- README 面向使用者，解释安装、验证、回滚和限制
- CHANGELOG 记录版本级变化
