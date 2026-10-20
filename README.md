# dsh-model-badges

大模型选单实测速度角标插件（DeepSeek Harness）。

每次启动 dsh 约 15 秒后自动跑一轮轻量基准测试，实测**大模型选单里的全部模型**的 TTFT/成功率，
并在对话输入框模型快速选单与设置页「模型体检」面板标注：

- 🟢 **快·稳** — TTFT < 3s 且实测高成功率
- 🟡 **中** — 可用但偏慢/偶发波动
- 🔴 **不可用** — 超时 / 限流 / 区域封锁 / 协议错误

## 覆盖范围

- 模型清单来自 dsh 本地 OpenAI 兼容网关 `http://127.0.0.1:8326/v1/models` 的**全量模型**
  （含 DeepSeek 账户模型、Kilo 通道、CodeArts、Buddy、opencode-free-model 等所有选单通道）
- 并补充 `our-free-model` / `opencode-free-model` 插件 catalog 中的简写 ID 与直写 ID
- 角标同时匹配完整模型 ID 和简写 ID，确保每个选单项都能显示

## 特性

- **完全独立**：不修改任何插件源码，不依赖外部脚本或平台。
- **自动跟随模型清单更新**：每次启动重新读取网关模型列表，dsh 新增/下架模型后无需任何操作，自动纳入测速与角标。
- **自包含数据**：评级写入 `~/.dsh/model-badges/perf-badges.json`，并镜像一份到
  `~/.dsh/our-free-model/perf-badges.json` 与 `~/.dsh/opencode-free-model/perf-badges.json`。
- **可手动重测**：设置页「模型体检」面板提供「立即重新测试」按钮。

## 安装

在 dsh 设置 → 插件 → **添加插件**，输入本仓库地址：

```
https://github.com/gj-gj15/dsh-model-badges
```

安装后点击「立即启用」，重启 dsh 生效。

## 评级规则

| 级别 | 条件 |
|---|---|
| 🟢 green | 实测成功率 ≥ 90% 且平均 TTFT < 3000ms |
| 🟡 yellow | 可用但 TTFT 3000~8000ms，或偶发失败/波动 |
| 🔴 red | 成功率 ≤ 60%、TTFT ≥ 8000ms、连续超时、限流、区域封锁 |

## 数据文件

- `~/.dsh/model-badges/perf-badges.json` — 本插件评级（滚动保留每模型最近 10 条样本）
- `~/.dsh/our-free-model/perf-badges.json`、`~/.dsh/opencode-free-model/perf-badges.json` — 镜像副本

## License

MIT