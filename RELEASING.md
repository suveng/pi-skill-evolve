# 发版流程（npm 可信发布 / OIDC，无 token）

npm 已于 2025-12 撤销长期 token，现有两条路：**可信发布（OIDC，推荐）** 与 90 天期的 Granular token（需定期轮换）。
本项目走 OIDC：CI 用 GitHub 的身份换一次性凭据，仓库里不存任何 npm 密钥。

## 一次性：首发

npm 只允许给**已存在**的包配置可信发布者，所以第一个版本必须手动发：

```bash
npm login --registry=https://registry.npmjs.org   # 会话凭据 2 小时有效，不进磁盘长期保存
npm publish --access public                        # 会要求 2FA / OTP
```

## 一次性：配置可信发布者

npmjs.com → 包 `pi-skill-evolve` → Settings → Trusted publishing → Add trusted publisher → GitHub Actions：

| 字段 | 值 |
|---|---|
| Organization or user | `suveng` |
| Repository | `pi-skill-evolve` |
| Workflow filename | `publish.yml`（只写文件名，不带路径） |
| Environment | 留空 |

⚠️ 新配的可信发布者**必须在 2 天内完成一次成功的 CI 发布**，否则配置过期作废（需删掉重建）。

## 每次发版

```bash
# 1. 改版本号（语义化）
npm version patch|minor|major --no-git-tag-version
git commit -am "chore: release v0.1.1"

# 2. 打 tag 并推（CI 会跑 523 条单测 → 校验版本 → npm publish）
git tag v0.1.1 && git push github main --tags
```

## 失败排查（npm 不会告诉你差在哪，全是 404 / ENEEDAUTH）

| 现象 | 原因 |
|---|---|
| `ENEEDAUTH` | workflow 缺 `id-token: write`，或运行时 npm < 11.15 |
| `404` | 可信发布者里的仓库 / 文件名对不上；用了 reusable workflow 却填了被调用的那个文件 |
| `404` / `ENEEDAUTH` | 设了 `NODE_AUTH_TOKEN`（哪怕是占位值），它会盖过 OIDC 交换 |
| provenance 缺失 | 源仓库不是 public，或跑在 self-hosted runner 上 |
