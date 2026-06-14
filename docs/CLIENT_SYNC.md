# 墨律客户端反馈与 Skill 同步

律师端 App 只负责**使用 + 反馈**；反馈经本地 outbox 队列上报同步服务；**服务端**完成反馈分析与 skill 发布；客户端自动拉取更新。

## 架构

```
律师 App → feedback_outbox → 同步服务 (C)
                              ↓
                    反馈运营 / 本地 AI 助手 (C.5)  ← docs/FEEDBACK_OPS.md
                              ↓
                    publish-skill → manifest (D)
                              ↓
         客户端自动下载 skill zip / Tauri updater (D/E)
```

Skill 优化在 `caocong1/ai-for-china-legal` 仓库完成（通过 `tools/feedback-refinement/SKILL.md`），不在律师电脑上运行 SkillOpt 管理面板。

## 客户端配置（设置 → 同步）

| 项 | 说明 |
|----|------|
| 同步服务地址 | 如 `http://127.0.0.1:8787` |
| API Key | 可选，与服务端 `SYNC_API_KEY` 一致 |
| 上传反馈 | 关闭则仅本地保存 |
| 上传回答全文 | 默认关闭，仅上传摘要（前 500 字） |
| Skills 通道 | stable / beta |

设备 ID 首次启动自动生成（匿名 UUID）。

## 开发

```bash
# 终端 1：同步服务
cd tools/sync-service && bun run dev

# 终端 2：App
bun run tauri dev

# 导出反馈（C.5）
curl -s "http://127.0.0.1:8787/api/feedback/export.md?rating=down" -o feedback-export.md
```

详见 [FEEDBACK_OPS.md](./FEEDBACK_OPS.md)。

## 生产构建注意

1. **SkillOpt 管理面板**（`Ctrl+Shift+O`）仅在 dev 构建可见
2. 运行 `tauri signer generate`，配置 `tauri.conf.json` 的 updater `pubkey` 与 `endpoints`
3. `bun run tauri build` 生成 signed updater artifacts
4. 发布 skill：`node tools/publish-skill.mjs --root <ai-for-china-legal> --version YYYY.MM.DD.N`
5. 勿将 GitHub token 或服务端密钥打包进 exe

## 评测 Gold Reference

`eval_cases.gold_reference_path` 指向律师审定样稿；`judge.rs` 对照 rubric + 律师审定样稿 + AI 输出三方评分。路径仅在 skill 项目/评测环境使用，不暴露给律师 UI。

## 隐私

- 默认不上传案情全文
- 反馈 payload 含评分、维度、skill 名、回答摘要、message metadata
- outbox 失败指数退避重试，设置页可查看待同步数量
