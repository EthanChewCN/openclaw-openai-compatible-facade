# OpenClaw OpenAI-Compatible Facade

不修改 OpenClaw 源码，让第三方 OpenAI-compatible `Responses` provider 在 OpenClaw 主 Agent 路径里恢复 prompt cache / cache read 的本地 facade 方案。

## 为什么值得分享

这个仓库解决的是一个很具体、但很常见的问题：

- 第三方 provider 明明自己支持 `prompt_cache_key`
- 本地 Codex / 其他直连客户端也确实能读缓存
- 但 OpenClaw 主 Agent 走到 provider 后，cache key 可能在请求链路里被剥掉

这个项目不碰 OpenClaw 源码，而是用“本地 facade + 配置层切换”把 OpenClaw 重新带回它认可的 OpenAI 原生路由。

## 亮点

- 不改 OpenClaw 源码，升级不需要重新 patch
- 支持多个第三方 provider 复用同一个本地 facade
- 已实测恢复主 Agent 的真实 `cacheRead`
- 安装和回滚都提供一键脚本
- 文档以中文为主，适合直接分享给中文用户

这是一个给 OpenClaw 用的本地 facade 方案，目标是：

- 不修改 OpenClaw 源码
- 让第三方 `OpenAI-compatible / Responses` 提供商也能走到 OpenClaw 认为的“原生 OpenAI 路由”
- 从而保住 `prompt_cache_key`
- 让提供商后台能看到真实的 cache read / prompt cache 命中

当前实现针对的是：

- OpenClaw 主对话 / Agent 路径
- 第三方 **OpenAI-compatible Responses** 提供商
- macOS + LaunchAgent 场景

## 解决了什么

OpenClaw 在处理自定义第三方 `openai-responses` endpoint 时，可能会把请求判定成 proxy-like route。这样一来，即使请求前面已经构造了 `prompt_cache_key`，后面也可能被 payload policy 剥掉，导致：

- 第三方提供商后台看不到 cache read
- OpenClaw 侧缓存命中率偏低
- 同样的 provider，在本地 Codex/其他直连客户端能读缓存，但在 OpenClaw 主 Agent 里不行

这个项目的做法不是改 OpenClaw 源码，而是：

1. 让 OpenClaw 继续以为自己在请求 `https://api.openai.com/v1`
2. 用本地 facade 对 `api.openai.com` 做进程级重定向
3. 再把流量转发到你的第三方提供商

这样 OpenClaw 看到的是“OpenAI 原生路由”，而真实上游仍然是第三方 provider。

## 工作原理

整体链路如下：

1. OpenClaw provider 的 `baseUrl` 被改成 `https://api.openai.com/v1`
2. Gateway 进程被注入 `HTTP_PROXY / HTTPS_PROXY`
3. 所有 HTTP(S) 流量先走本地 facade proxy
4. facade 对普通目标走透明 CONNECT 隧道
5. 只有对 `api.openai.com:443` 的请求，facade 才做本地 MITM
6. provider 级别通过 header `X-OpenClaw-Facade-Upstream` 指定真实第三方上游
7. facade 去掉内部 header，再把请求转发给真实 provider

你可以同时给多个 provider 开启这个方案，因为上游是按 header 路由，不是写死 Beehears。

## 已实测的多 provider 路由

下面这两类 provider 已经按同一套 facade 路由方式实测过：

- `custom-beehears -> https://api.beehears.com`
- `custom-memory -> https://api.beehears.com`

其中：

- `custom-beehears` 已完成 OpenClaw 主 Agent 端到端验证，并确认出现真实 `cacheRead`
- `custom-memory` 已完成通过通用 facade 的第二 provider 路由验证，确认请求能按 provider header 路由到同一第三方上游

注意：

- “第二个 provider 路由可用”不等于“第二个 provider 一定适合作为主聊天模型”
- 是否能直接挂到 `main` Agent 端到端跑通，还取决于这个 provider 的 key、模型配额、上游稳定性，以及它是否本来就适合主对话场景

这说明脚本的“多 provider 映射”能力是可工作的，不要求每个 provider 都单独启动一个本地代理服务。

## 适用范围

适合：

- 第三方 OpenAI-compatible **Responses** 提供商
- 你确认它本身支持 `prompt_cache_key`
- 你不想改 OpenClaw 源码

不适合：

- 非 Responses 协议的 provider
- 只支持 Chat Completions、不支持 Responses 的 provider
- 你无法接受 Gateway 进程通过本地 proxy 出站

## 一键安装

### 前置条件

- macOS
- 已安装 OpenClaw，且 Gateway 使用 LaunchAgent
- 已安装 `node`
- 已安装 `openssl`

### 命令

以 Beehears 为例：

```bash
cd openclaw-openai-compatible-facade
bash scripts/install.sh \
  --map custom-beehears=https://api.beehears.com
```

如果你要一次启用多个 provider：

```bash
bash scripts/install.sh \
  --map custom-beehears=https://api.beehears.com \
  --map custom-right=https://right.codes/codex
```

## 安装脚本做了什么

安装脚本会自动：

1. 在 `~/.openclaw/local-proxies/openai-compatible-facade` 下生成运行目录
2. 生成本地 CA 和 `api.openai.com` 叶子证书
3. 安装本地 facade LaunchAgent
4. 修改 OpenClaw Gateway 的 LaunchAgent 环境变量：
   - `NODE_EXTRA_CA_CERTS`
   - `HTTP_PROXY`
   - `HTTPS_PROXY`
   - `NO_PROXY`
5. 修改 `~/.openclaw/openclaw.json` 对应 provider：
   - `baseUrl = https://api.openai.com/v1`
   - `api = openai-responses`
   - `request.proxy.mode = env-proxy`
   - `request.allowPrivateNetwork = true`
   - 注入 `X-OpenClaw-Facade-Upstream`
6. 尝试同步 `~/.openclaw/agents/main/agent/models.json`
7. 重载 facade 和 Gateway 两个 LaunchAgent

## OpenClaw 配置会被改成什么样

例如：

```json
{
  "models": {
    "providers": {
      "custom-beehears": {
        "baseUrl": "https://api.openai.com/v1",
        "api": "openai-responses",
        "request": {
          "proxy": {
            "mode": "env-proxy"
          },
          "allowPrivateNetwork": true
        },
        "headers": {
          "X-OpenClaw-Facade-Upstream": "https://api.beehears.com",
          "X-OpenClaw-Facade-Provider": "custom-beehears"
        }
      }
    }
  }
}
```

## 验证方法

### 1. 看 Gateway 是否正常

```bash
openclaw status
```

### 2. 直接打 main Agent

```bash
openclaw agent --agent main --message "reply with exactly ok" --json --timeout 60
```

### 3. 看 facade 日志

```bash
tail -f ~/.openclaw/logs/openai-compatible-facade.log
```

正常情况下，你会看到：

- 普通目标是 `generic connect tunnel`
- 命中 OpenAI facade 的请求会出现 `facade request`

### 4. 看缓存是否真的回来

同一会话跑两次后，再看：

```bash
openclaw status
```

如果成功，主会话的 token 信息里应该会出现明显的 cached 比例；`openclaw agent --json` 的 `lastCallUsage.cacheRead` 也会出现非 0 值。

## 卸载 / 回滚

回滚时需要告诉脚本 provider 原本的真实上游地址：

```bash
bash scripts/uninstall.sh \
  --map custom-beehears=https://api.beehears.com
```

它会做这些事情：

- 把 provider 的 `baseUrl` 改回真实上游
- 删除 facade 注入的 header
- 删除 `HTTP_PROXY / HTTPS_PROXY / NO_PROXY`
- 把 `NODE_EXTRA_CA_CERTS` 重置为 `/etc/ssl/cert.pem`
- 停掉 facade LaunchAgent
- 重载 Gateway

## 注意事项

### 1. 这不是“任意 OpenAI-compatible provider 全兼容”

这套方案主要解决的是：

- 第三方 `Responses` provider
- OpenClaw 在 custom route 上剥离 `prompt_cache_key`

如果你的 provider：

- 不支持 `prompt_cache_key`
- 不兼容 OpenAI Responses 请求结构
- 自己对缓存有额外前提

那么这个方案也不会神奇生效。

### 2. Gateway 会全局带 proxy 环境

Gateway 进程现在会带：

- `HTTP_PROXY`
- `HTTPS_PROXY`

因此 facade 不能停。  
不过 facade 对非 `api.openai.com` 目标会透明转发，不会只服务于某一个 provider。

### 3. 这套方案依赖本地 MITM 证书

这里的 CA 不是导入系统钥匙串，而是只通过 `NODE_EXTRA_CA_CERTS` 注入给 Gateway 进程。  
所以影响面只在 OpenClaw Gateway，不会改系统全局 HTTPS 信任。

### 4. 目前是 macOS 方案

脚本基于：

- LaunchAgent
- `launchctl`
- `/usr/libexec/PlistBuddy`

Linux / systemd 还没做。

### 5. OpenClaw 升级后要重新验证

因为这个方法利用的是“配置层 + 外部代理”绕过，不是官方内建开关。  
如果未来 OpenClaw 改了 OpenAI 路由识别、SSRF 策略、或者 prompt cache policy，建议升级后重新跑一次验证。

## 推荐的分享标题

你发 GitHub 时可以直接用类似标题：

`不改 OpenClaw 源码，让第三方 OpenAI-compatible Responses Provider 恢复 Prompt Cache 的本地 Facade 方案`

## 推荐的最短示例

```bash
bash scripts/install.sh \
  --map custom-beehears=https://api.beehears.com
openclaw status
openclaw agent --agent main --message "reply with exactly ok" --json --timeout 60
```
