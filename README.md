# OpenClaw OpenAI-Compatible Facade

这个项目提供一套本地 facade 方案，用来处理 OpenClaw 接第三方 OpenAI-compatible `Responses` provider 时的 prompt cache 丢失问题。

目标很简单：

- 不改 OpenClaw 源码
- 通过配置层和本地代理把请求带回 OpenClaw 认可的 OpenAI 路由
- 让第三方 provider 后台重新看到真实的 cache read

目前这套方案面向：

- OpenClaw 主对话 / Agent 路径
- 第三方 OpenAI-compatible `Responses` provider
- macOS + LaunchAgent 环境

## 背景

有些第三方 provider 本身支持 `prompt_cache_key`，直连时也能正常读缓存；但 OpenClaw 在处理自定义 `openai-responses` endpoint 时，可能会把请求判定成 proxy-like route。这样一来，请求前面虽然已经构造了 `prompt_cache_key`，后面仍可能被 payload policy 剥掉。

实际现象通常是：

- provider 后台看不到 cache read
- OpenClaw 会话缓存命中率偏低
- 同一个 provider，在本地 Codex 或其他直连客户端上能读缓存，但在 OpenClaw 主 Agent 里不行

这个仓库的处理办法不是 patch OpenClaw，而是在本地放一个 facade，把 OpenClaw 的请求伪装成发往 `https://api.openai.com/v1`，再由 facade 转发到真实第三方上游。

## 工作方式

链路如下：

1. OpenClaw 中目标 provider 的 `baseUrl` 改成 `https://api.openai.com/v1`
2. Gateway 进程注入 `HTTP_PROXY` / `HTTPS_PROXY`
3. 所有 HTTP(S) 流量先经过本地 facade
4. facade 对普通目标走透明 CONNECT 隧道
5. 只有发往 `api.openai.com:443` 的请求，facade 才做本地 MITM
6. provider 通过请求头 `X-OpenClaw-Facade-Upstream` 指定真实上游地址
7. facade 去掉内部头后，再把请求转发到第三方 provider

这样 OpenClaw 看到的是 OpenAI 原生路由，真实上游仍然是你自己的 provider。

## 适用范围

适合：

- 第三方 OpenAI-compatible `Responses` provider
- provider 本身支持 `prompt_cache_key`
- 你不想维护 OpenClaw 源码 patch

不适合：

- 非 `Responses` 协议 provider
- 只支持 Chat Completions、但不支持 Responses 的上游
- 不能接受 Gateway 进程走本地 proxy 的场景

## 快速开始

### 前置条件

- macOS
- OpenClaw 已安装，且 Gateway 通过 LaunchAgent 运行
- 已安装 `node`
- 已安装 `openssl`

### 单 provider 示例

```bash
cd openclaw-openai-compatible-facade
bash scripts/install.sh \
  --map custom-beehears=https://api.beehears.com
```

### 多 provider 示例

```bash
bash scripts/install.sh \
  --map custom-beehears=https://api.beehears.com \
  --map custom-memory=https://api.beehears.com
```

### 安装后验证

```bash
openclaw status
openclaw agent --agent main --message "reply with exactly ok" --json --timeout 60
```

## 安装脚本会修改什么

安装脚本会做这些事情：

1. 在 `~/.openclaw/local-proxies/openai-compatible-facade` 下创建运行目录
2. 生成本地 CA 和 `api.openai.com` 叶子证书
3. 安装 facade 的 LaunchAgent
4. 修改 OpenClaw Gateway 的 LaunchAgent 环境变量：
   - `NODE_EXTRA_CA_CERTS`
   - `HTTP_PROXY`
   - `HTTPS_PROXY`
   - `NO_PROXY`
5. 修改 `~/.openclaw/openclaw.json` 中对应 provider：
   - `baseUrl = https://api.openai.com/v1`
   - `api = openai-responses`
   - `request.proxy.mode = env-proxy`
   - `request.allowPrivateNetwork = true`
   - 注入 `X-OpenClaw-Facade-Upstream`
   - 注入 `X-OpenClaw-Facade-Provider`
6. 尝试同步 `~/.openclaw/agents/main/agent/models.json`
7. 重载 facade 和 Gateway 两个 LaunchAgent

## 配置结果示例

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

### 查看 Gateway 状态

```bash
openclaw status
```

### 直接打一轮主 Agent

```bash
openclaw agent --agent main --message "reply with exactly ok" --json --timeout 60
```

### 查看 facade 日志

```bash
tail -f ~/.openclaw/logs/openai-compatible-facade.log
```

正常情况下，你会看到：

- 普通目标显示为 `generic connect tunnel`
- 命中 facade 的请求显示为 `facade request`

### 查看缓存是否真正回来

同一会话跑两次后，再看：

```bash
openclaw status
```

如果链路成功，主会话的 token 信息里应该会出现明显的 cached 比例；`openclaw agent --json` 的 `lastCallUsage.cacheRead` 也会出现非 0 值。

## 已验证情况

这套 facade 已验证过下面两类映射：

- `custom-beehears -> https://api.beehears.com`
- `custom-memory -> https://api.beehears.com`

当前结论是：

- `custom-beehears` 已完成主 Agent 端到端验证，并确认出现真实 `cacheRead`
- `custom-memory` 已完成第二 provider 的路由验证，确认请求可以按 provider header 转发到同一第三方上游

需要额外说明的是：

- 第二个 provider 能路由成功，不等于它一定适合作为主聊天模型
- 某个 provider 能不能直接挂到 `main` Agent 长期稳定使用，还取决于它自己的 key、模型配额、上游稳定性和适用场景

## 卸载 / 回滚

回滚时需要告诉脚本 provider 原本的真实上游地址：

```bash
bash scripts/uninstall.sh \
  --map custom-beehears=https://api.beehears.com
```

卸载脚本会：

- 把 provider 的 `baseUrl` 改回真实上游
- 删除 facade 注入的请求头
- 删除 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`
- 把 `NODE_EXTRA_CA_CERTS` 重置为 `/etc/ssl/cert.pem`
- 停掉 facade LaunchAgent
- 重载 Gateway

## 限制与注意事项

### 1. 这不是通用兼容层

这套方案主要解决的是：

- 第三方 `Responses` provider
- OpenClaw 在自定义 route 上剥离 `prompt_cache_key`

如果你的 provider：

- 不支持 `prompt_cache_key`
- 不兼容 OpenAI Responses 请求结构
- 自己还有额外缓存前提

那么这套 facade 也不会自动把它变成“完全兼容”。

### 2. Gateway 会全局带 proxy 环境

Gateway 进程会带：

- `HTTP_PROXY`
- `HTTPS_PROXY`

所以 facade 不能停。  
不过 facade 对非 `api.openai.com` 目标只做透明转发，不会只服务某一个 provider。

### 3. 依赖本地 MITM 证书

这里的 CA 不会导入系统钥匙串，而是只通过 `NODE_EXTRA_CA_CERTS` 注入给 Gateway 进程。  
影响范围只在 OpenClaw Gateway，不会改系统全局 HTTPS 信任。

### 4. 当前仅支持 macOS

脚本依赖：

- LaunchAgent
- `launchctl`
- `/usr/libexec/PlistBuddy`

Linux / systemd 暂未支持。

### 5. OpenClaw 升级后建议重新验证

这套方法利用的是“配置层 + 外部代理”绕过，不是官方内建能力。  
如果未来 OpenClaw 改了 OpenAI 路由识别、SSRF 策略、或 prompt cache policy，建议升级后重新跑一次验证。
