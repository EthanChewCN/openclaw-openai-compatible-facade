# GitHub Metadata

这个文件是给仓库公开发布时直接复制用的元信息草稿。

## 仓库名

推荐直接用当前名字：

`openclaw-openai-compatible-facade`

如果你想更强调“缓存恢复”这个点，也可以考虑：

- `openclaw-prompt-cache-facade`
- `openclaw-openai-facade-proxy`
- `openclaw-third-party-responses-facade`

## About 文案

### 中文版

不改 OpenClaw 源码，用本地 facade 让第三方 OpenAI-compatible Responses provider 在主 Agent 路径里恢复 prompt cache / cache read。

### 英文版

Restore prompt cache and cache-read behavior for third-party OpenAI-compatible Responses providers in OpenClaw without patching OpenClaw source.

## 仓库首页短介绍

### 版本 A

一个不改 OpenClaw 源码的本地 facade 方案，用来修复第三方 OpenAI-compatible `Responses` provider 在 OpenClaw 主 Agent 路径里的 prompt cache 丢失问题。

### 版本 B

如果你的第三方 provider 本身支持 `prompt_cache_key`，但 OpenClaw 主 Agent 路径里读不到缓存，这个仓库提供了一套可回滚、可脚本化、可分享的本地 facade 方案。

## 推荐 Topics

建议在 GitHub 仓库 Topics 里加入这些词：

- `openclaw`
- `openai-compatible`
- `responses-api`
- `prompt-cache`
- `reverse-proxy`
- `local-proxy`
- `mitm`
- `macos`
- `launchagent`
- `llm-infra`
- `openai-proxy`
- `agent-tools`

如果你想更保守一点，可以只保留这组核心 tags：

- `openclaw`
- `openai-compatible`
- `responses-api`
- `prompt-cache`
- `local-proxy`
- `macos`

## 社交预览文案

可以放在仓库截图或分享卡片上：

> 不改 OpenClaw 源码，恢复第三方 Responses Provider 的 Prompt Cache

或者：

> OpenClaw 第三方 Provider Cache Read 恢复方案

## 推荐置顶文案

如果你要把这个仓库放在个人主页 pinned repo 区域，推荐一句话：

> 给 OpenClaw 第三方 Responses provider 做的本地 facade 工具，不改源码恢复 cache read。

## 发布说明标题建议

首个 release 可以用：

`v0.1.0 - First public release`

如果你更想突出中文用户视角：

`v0.1.0 - 首个可公开分享版本`

## README 顶部一句话备用文案

下面这几句都适合放在 README 第一屏：

1. 不修改 OpenClaw 源码，让第三方 OpenAI-compatible `Responses` provider 恢复 prompt cache / cache read。
2. 一个面向 OpenClaw 的本地 facade 工具，用配置层和本地代理绕过第三方 provider 的 cache key 丢失问题。
3. 当 OpenClaw 主 Agent 里读不到第三方 provider 缓存时，这个仓库提供一套可脚本化、可回滚的修复方案。
