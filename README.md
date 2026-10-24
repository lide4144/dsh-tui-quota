# dsh-tui-quota · 开发预览

克制的额度展示插件：**底栏看当前，`/quota` 看详情**。独立于 dsh-tui 本体，不替换 `/provider`，不安装代理，不生成模型请求。

```text
… · Projects · ▰▰▰▰▱ 82% (45m)
… · Projects · ¥42.50
… · Projects · 额度未知
```

示例为合成数据，不代表任何账号的真实额度。颜色使用宿主语义主题 `accent / warning / error / dim`，没有硬编码冰蓝或 ANSI 转义。

## 安装

当前是 GitHub 源码预览，**未发布 npm**：

```sh
dsh plugin --profile dsh-tui add github:lide4144/dsh-tui-quota
```

重启 dsh-tui 后输入 `/quota`。本机契约基准为 dsh-tui **0.17.0**、DSH **0.2.1-rc.3**、Node **22**；尚未做真实账号/交互界面的端到端验收。

默认仅启用伴生 [dsh-tui-antigravity](https://github.com/lide4144/dsh-tui-antigravity) 的额度读取。**安装即允许读取该插件自己的 auth.json，并向固定 Google HTTPS 端点发送只读额度请求。** 不扫描 Pi、CLI、其他代理的凭据，不创建账号、不 onboard、不刷新 token。

## 使用

```text
/quota          当前提供方详情，同时绑定当前会话
/quota all      已查询的全部提供方详情
/quota refresh  手动刷新所有已配置的数据源（遵守查询限流）
```

底栏通过公开 `ctx.tuiStatus.setField` 插入 `left-tail`，最多 32 cells，沿用原生分隔/主题。未配置当前提供方时保留“额度未配置”，不再静默清掉字段。

**命令能用但底栏不可见？** 先在 `/settings` 关闭“极简界面”（宿主在此模式强制隐藏插件字段），再检查 `statusBar.pluginFields` 已开启；如已有固定 `pluginFieldsOrder`，将 `quota:current` 加入显示名单。此为宿主可见性设置，插件不会擅自覆盖。

会话选择来自 `modelSelection` 投影和 `tui/session-switched`，请求时还会观察最终配置，但不改变它。**启动时若没有公开焦点事件，不猜测活跃会话**，先显示 `额度 · /quota`；执行一次 `/quota` 即绑定。旧宿主的部分 `/model` 内存切换可能在下一次请求时才同步。后台子代理不能抢占焦点。

## 数据源与配置

在 profile 的 `cordis.patch.yml` 为 bundle 行 `tui-quota` 设置完整 config（不要把密钥写入其中）：

```yaml
- id: tui-quota
  config:
    refreshMs: 300000
    sources:
      - kind: antigravity
        provider: antigravity
      - kind: deepseek-balance
        provider: deepseek-official
        keyEnv: DEEPSEEK_API_KEY
      - kind: moonshot-balance
        provider: moonshot
        keyEnv: MOONSHOT_API_KEY
```

`provider` 必须与你实际模型路由 ID 完全一致；不会猜别名、合并多账户或混用不同产品的凭据。余额 source 使用明确指定的环境变量，不读取全局 credentials.yaml。`sources: []` 可关闭全部数据源。

| 来源 | 显示内容 | 边界 |
| --- | --- | --- |
| Antigravity | 当前精确 model 的剩余百分比/重置时间；详情保留逐模型窗口 | 非公开稳定 Google API；默认读取 `$DSH_HOME/plugins/antigravity/auth.json`（未设时 `~/.dsh/...`），仅用 access/projectId，不使用 refresh。过期需先通过伴生模型插件刷新或重新登录 |
| DeepSeek API | 官方货币余额，多币种详情逐项保留 | 不是 DeepSeek 网页订阅或次数。底栏仅展示第一项币种 |
| Moonshot API | 官方 CNY 可用余额 | **不是 Kimi Code 订阅额度**，不可用 Moonshot key 冒充 Kimi Code OAuth |
| Claude / GPT / Kimi Code | 本预览版未实现 | 不虚构次数、百分比或“健康”状态；未来需要各自明确授权的 adapter |

不假设存在通用 `/v1/quota`。无法证明共享池的模型窗口不合并，当前模型有多个窗口时底栏显示其中最紧张的已披露窗口。没有分母就不显示 `28/45`；resetTime 已过时显示“待刷新”，不假设额度已恢复。

## 缓存与安全

- 默认 5 分钟后台刷新/成功缓存，配置最短 1 分钟；普通查看优先读缓存，显式刷新仍有 10 秒本地节流。每来源只有一个在途请求，10 秒超时，卸载即取消。
- 成功结果只存内存；失败保留旧值并标记 `~` / 缓存，未知不当作零。
- `429` 的重试时间仅用于**额度查询**，不声称生成请求也限流；尊重披露的 Retry-After，未披露时用本地重试退避，不伪造账号重置时间。
- 固定 HTTPS origin，禁止重定向和任意自定义 URL；响应体上限 1MiB，不回显原始上游错误、token、邮箱或项目 ID。
- 不自动路由模型，所以不显示虚构的 `[↪ AG]`。没有探测接口不能把“可连接”标成“有额度”。

## 为什么没有顶栏和 /provider 注入？

已安装公开接口提供底栏字段、独立命令与场景，没有核实到全局顶部会话 tab 的扩展口。`/provider` 也不能安全地靠重复注册扩展。此预览不猴补丁、不改核心、不假装它们已支持；全局信息集中在 `/quota all`。

## 开发与验证

```sh
npm run check
```

零生产依赖、原生 ESM，无构建步骤。离线测试覆盖模拟数据源、响应上限、限流/备用、余额精度、未知值、精确模型匹配、缓存/并发、会话隔离和卸载。不访问真实额度服务、不读取真实凭据；不能代替实际账户验收。

协议/接口出处：
- [DeepSeek balance](https://api-docs.deepseek.com/api/get-user-balance/)
- [Moonshot balance](https://platform.kimi.com/docs/api/balance.md)
- [Antigravity 第三方协议参考](https://github.com/V1ki/dsh-plugin-subscriptions/blob/a5b01068b7f0c0cdb6f38bafe700c345fdfee4ba/src/providers/antigravity.ts)（独立小型实现；未复制整套插件）
- [dsh-tui 插件指南](https://github.com/ccch1mneyyy/dsh-TUI/blob/main/docs/plugins.md)

MIT。非 Google、DeepSeek、Moonshot 或 dsh-tui 官方产品。
