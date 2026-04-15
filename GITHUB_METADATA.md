# GitHub Metadata

这个文件是给仓库发布时直接参考的元信息清单。

## 仓库名

`openclaw-openai-compatible-facade`

## About

### 中文

不改 OpenClaw 源码，用本地 facade 让第三方 OpenAI-compatible Responses provider 在主 Agent 路径里恢复 prompt cache / cache read。

### English

Restore prompt cache and cache-read behavior for third-party OpenAI-compatible Responses providers in OpenClaw without patching OpenClaw source.

## 建议 Topics

- `openclaw`
- `openai-compatible`
- `responses-api`
- `prompt-cache`
- `local-proxy`
- `reverse-proxy`
- `macos`
- `launchagent`

## Release 标题

`v0.1.0 - First public release`

## 简短对外说明

这是一个给 OpenClaw 用的本地 facade 工具。它不修改 OpenClaw 源码，而是在配置层和本地代理层修复第三方 OpenAI-compatible `Responses` provider 的 prompt cache 丢失问题。
