---
name: apimart-image-gen
description: Generate or edit images with GPT-Image-2.5 (flare/sunburst) via the api.apimart.ai relay. Use when the user asks to generate/create/draw an image, edit a photo, or use GPT-Image-2.5 / GPT-Image-2 / "GPT 图" / "apimart" / "中转站" — especially when baoyu-image-gen's openai provider fails on apimart with "No image in response" (apimart uses an async task protocol, not the standard synchronous OpenAI Images response). Wraps submit → poll task_id → download into one command. Supports text-to-image, reference-image editing (up to 16 refs; local files auto-uploaded via /v1/uploads/images since base64 is deprecated), 15 aspect ratios, 1k/2k/4k resolution tiers, and low/medium/high/xhigh/max quality tiers.
version: 2.0.0
metadata:
  openclaw:
    requires:
      anyBins:
        - bun
        - npx
---

# apimart-image-gen（api.apimart.ai 版 GPT-Image-2.5）

api.apimart.ai 中转站的 GPT-Image **不是**标准 OpenAI Images 接口：提交后只返回
`task_id`，需要轮询 `GET /v1/tasks/{task_id}`，完成后从 `result.images[].url[]` 取图。
本 skill 把这套异步协议封装成一条命令。API 细节见 `references/api.md`。

## 模型

| 模型 | 定位 |
|---|---|
| `gpt-image-2.5-flare`（默认） | 快，日常出图 / 批量 / 快速原型 |
| `gpt-image-2.5-sunburst` | 编辑精度优先，商品图 / 投放创意 / 多轮精修 |

`--model sunburst` / `flare` 可简写；两者同价。旧 `gpt-image-2` 仍可指定，但不支持
`xhigh` / `max` 质量档（会直接 400，不自动降级）。

## 运行时

`{baseDir}` = 本 SKILL.md 所在目录。用 `bun {baseDir}/scripts/main.ts ...` 运行；
没有 bun 时用 `npx -y bun ...`（`brew install oven-sh/bun/bun` 可装）。

## 鉴权与配置

优先级：CLI 参数 > 环境变量 > `<cwd>/.baoyu-skills/.env` > `~/.baoyu-skills/.env`
（与 baoyu-image-gen v2.1.0 的加载路径一致）。

- 首选：`APIMART_API_KEY`（+ 可选 `APIMART_BASE_URL`，默认 `https://api.apimart.ai/v1`）
- 兼容：`.env` 里已有指向 apimart 的 `OPENAI_BASE_URL` + `OPENAI_API_KEY` 时自动复用，
  无需新配置（与 baoyu-image-gen 共用同一份 `~/.baoyu-skills/.env`）
- 可选环境变量：`APIMART_IMAGE_MODEL`（默认模型）、`APIMART_IMAGE_QUALITY`（默认质量档）、
  `APIMART_IMAGE_RESOLUTION`（默认分辨率档）

## 用法

```bash
# 文生图（最简，默认 1:1 / 1k / medium / flare）
bun {baseDir}/scripts/main.ts --prompt "一只橘猫坐在窗台上看夕阳，水彩画风格" --image cat.png

# 指定比例 + 分辨率 + 质量（按 token 计费，quality 档位决定单价大头）
bun {baseDir}/scripts/main.ts --prompt "a corgi astronaut on the moon" \
  --image out.png --ar 16:9 --resolution 2k --quality high --json

# 图生图：本地参考图自动上传换 URL（base64 直传已被官方废弃）；不传 --ar 时输出跟随输入图比例
bun {baseDir}/scripts/main.ts --prompt "把这张照片变成水彩画风格" \
  --ref photo.jpg --image out.png

# 精修：切 sunburst + xhigh 档
bun {baseDir}/scripts/main.ts --prompt "保留主体和包装文字，换成米白摄影棚背景" \
  --ref product.png --image out.png --model sunburst --quality xhigh

# 多参考图（本地 + URL 混填，最多 16 张，单张 ≤20M）
bun {baseDir}/scripts/main.ts --prompt "以第一张商品为主体，参考第二张布景" \
  --ref a.png https://example.com/b.jpg --image poster.png --ar 4:3 --resolution 2k

# 透明背景（仅 png/webp）
bun {baseDir}/scripts/main.ts --prompt "白色运动鞋电商产品图" \
  --image shoe.png --background transparent --output-format png

# 只要 URL 不落盘（注意 URL 会过期，约 24h）
bun {baseDir}/scripts/main.ts --prompt "..." --response-format url
```

## 参数

| 参数 | 说明 |
|---|---|
| `--prompt` / `--promptfiles` | 提示词，二选一；多文件按空行拼接 |
| `--image <path>` | 输出路径；多张时自动加 `-1` `-2` 后缀 |
| `--model` | `gpt-image-2.5-flare`（默认）/ `gpt-image-2.5-sunburst`，可简写 `flare` / `sunburst`；兼容 `gpt-image-2` |
| `--ar` / `--size` | 15 种比例（`1:1`…`21:9`）、`auto`、或像素如 `1920x1088`（16 倍数、单边 ≤3840、比例 ≤3:1） |
| `--resolution` | `1k` / `2k` / `4k`（默认 1k；`--quality normal\|2k\|4k` 旧写法仍映射到本档） |
| `--quality` | `low` / `medium`（默认）/ `high` / `xhigh` / `max` / `auto`；`xhigh`/`max` 仅 2.5 模型 |
| `--ref <f...>` | 参考图：本地文件（自动上传换 URL）或 http(s) URL，最多 16 张、单张 20M |
| `--n <int>` | 张数（默认 1，1~4） |
| `--output-format` | `png`（默认）/ `jpeg` / `webp` |
| `--output-compression` | 0~100，仅 jpeg/webp |
| `--background` | `transparent` / `opaque` / `auto`；transparent 仅 png/webp |
| `--moderation` | `auto` / `low`（默认 low） |
| `--response-format` | `file`（默认，下载落盘）/ `url`（返回 URL + 过期时间） |
| `--poll-interval` / `--timeout` | 轮询间隔（默认 3s）/ 总超时（默认 600s） |
| `--json` | stdout 只输出最终 JSON（进度走 stderr，适合 agent 解析） |

比例 × 档位的实际像素对照、各档 token 计费表见 `references/api.md`（如 `16:9` + `4k` = 3840×2160）。

## 行为要点

- **异步耗时**：提交后通常 30–120 秒完成，进度（`processing N%`）打在 stderr；
  超时默认 600s，超时后报错并附手动查询 URL，**task_id 可用于事后补查**。
- **计费**：按实际 token 用量计费（图片输出 $30/M tok、输入 $8/M tok、文本 $5/M tok），
  quality 档位是成本大头——1:1 下 `low`≈$0.006 / `medium`≈$0.013 / `high`≈$0.053 /
  `xhigh`≈$0.094 / `max`≈$0.21。完成后返回 `cost` / `credits_cost` / `usage`，会打进 JSON 结果。
  `quality auto` 会按 `max` 预扣额度（完成后退差），余额敏感时显式指定档位——本 skill 默认 `medium`。
- **本地参考图**：先上传 `POST /v1/uploads/images` 换公网 URL（72h 有效）再提交，
  生成接口已不再支持 base64 直传；上传失败会带原因报错。
- **只返回 URL**：接口不支持 `response_format=b64_json`；默认模式会立即下载落盘，
  结果 URL 约 24 小时过期（`expiresAt` 字段）。
- `--nsfw-check` / `--official-fallback` 为旧版透传参数，2.5 文档未定义，默认关。

## 常见错误

| 报错 | 含义 |
|---|---|
| `身份验证失败(401)` | Key 无效或未配置 |
| `账户余额不足(402)` | apimart 余额耗尽，去 apimart.ai 充值 |
| `请求过于频繁(429)` | 已自动重试 3 次仍失败，稍后再试 |
| `参数错误(400)` | size/resolution/quality/像素不合法；`xhigh`/`max` 配了旧模型 |
| `上传参考图失败：…(413)` | 本地图超 20M |
| `任务失败：…` | 上游生成失败，看 error.message，换提示词重试（费用自动退回） |
| `任务超时` | task_id 仍有效，可手动 `GET /v1/tasks/{task_id}` 补查 |

## 与 baoyu-image-gen 的关系

同一份 `.env`、相近的参数风格（`--prompt/--image/--ref/--ar/--json`），但只做
apimart 这一条渠道。用户要 apimart / GPT-Image-2.5 / GPT 图出图时优先用本 skill；
Gemini / 通义 / 豆包（Seedream）仍走 baoyu-image-gen。
