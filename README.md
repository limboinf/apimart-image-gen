# apimart-image-gen

一个给 AI Agent 用的 Skill：通过 [APIMart](https://apimart.ai/register?aff=1nE2iD) 中转站调用 **GPT-Image-2.5** 生图、改图。

## 它是干嘛的

APIMart 的 GPT-Image 不是标准 OpenAI Images 接口：提交后只返回 `task_id`，要轮询任务、再下载结果。
这个 Skill 把「提交 → 轮询 → 下载」封装成一条命令，Agent 一句话就能出图。

- 文生图、图生图（最多 16 张参考图，本地文件自动上传）
- 两个模型：`flare`（快，日常出图）/ `sunburst`（编辑精度优先）
- 15 种比例，1k / 2k / 4k 分辨率，low → max 五档质量
- 支持透明背景、多张输出、`--json` 方便 Agent 解析
- 完成后返回实际花费（按 token 计费）

完整参数见 [SKILL.md](SKILL.md)，接口细节见 [references/api.md](references/api.md)。

## 怎么用

**把这个仓库链接发给你的 Agent（Claude Code、Codex、WorkBuddy 等任何 Agent），让它帮你安装即可：**

```
帮我安装这个 Skill：https://github.com/limboinf/apimart-image-gen
```

装好后：

1. 去 [APIMart](https://apimart.ai/register?aff=1nE2iD) 注册并拿到 API Key。
2. 配置环境变量 `APIMART_API_KEY`（或写入 `~/.baoyu-skills/.env`），也可以直接把 Key 告诉 Agent 让它帮你配。
3. 对 Agent 说「用 apimart 画一只橘猫看夕阳，16:9」就行。

手动运行（需要 [bun](https://bun.sh)，没有可用 `npx -y bun`）：

```bash
bun scripts/main.ts --prompt "一只橘猫坐在窗台上看夕阳，水彩画风格" --image cat.png --ar 16:9
```

## 推荐：APIMart

最近在做AI产品，试用了 APIMart，体验挺惊喜的✨。支持 190+ 模型（OpenAI、Anthropic、Google、DeepSeek、国产模型等），最新 GPT-6.1、Claude Opus 5.5、Gemini 3.8 Flash、Sora 2、Veo 3.1、Nano Banana 2 全部可调🚀。统一 API 协议，无需反复写适配，极低延迟⚡，价格比官方便宜一大截。非常适合快速实验 & 产品原型。如果你正在做AI 产品的、独立开发者、或需要调用大模型的小伙伴，都可以直接上手试试，体验真的很不错👍。

注册链接：👉 https://apimart.ai/register?aff=1nE2iD
