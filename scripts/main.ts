#!/usr/bin/env bun
// apimart-image-gen — GPT-Image-2.5 via api.apimart.ai（异步任务协议封装）
//
// 协议（非标准 OpenAI，异步三步）：
//   1. POST {base}/images/generations        → { data: [{ status:"submitted", task_id }] }
//   2. GET  {base}/tasks/{task_id}（轮询）    → status: submitted|processing|completed|failed
//   3. completed 后 data.result.images[].url[] 下载图片（URL 有过期时间，默认立即落盘）
//
// 本地参考图：生成接口已不再支持 base64 直传，先 POST {base}/uploads/images
// （multipart，字段 file）换公网 URL，再放进 image_urls。
//
// 鉴权：Bearer Token。Key 解析顺序：--api-key > APIMART_API_KEY > OPENAI_API_KEY（当
// OPENAI_BASE_URL 指向 api.apimart.ai 时复用，与 baoyu-image-gen 的 .env 共存）。

import { existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// ---------- 常量 ----------

const DEFAULT_BASE = "https://api.apimart.ai/v1";
const APIMART_HOST = "api.apimart.ai";
const RATIOS = new Set([
  "auto", "1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5",
  "16:9", "9:16", "2:1", "1:2", "3:1", "1:3", "21:9", "9:21",
]);
const RESOLUTIONS = new Set(["1k", "2k", "4k"]);
const QUALITIES = new Set(["low", "medium", "high", "xhigh", "max", "auto"]);
// 旧版习惯：--quality normal|2k|4k 实际是 resolution 档位，继续兼容
const LEGACY_QUALITY_TO_RESOLUTION: Record<string, string> = {
  normal: "1k", "1k": "1k", "2k": "2k", "4k": "4k",
};
const OUTPUT_FORMATS = new Set(["png", "jpeg", "webp"]);
const BACKGROUNDS = new Set(["transparent", "opaque", "auto"]);
const MODERATIONS = new Set(["auto", "low"]);
const MAX_REFS = 16;
const MODEL_ALIASES: Record<string, string> = {
  flare: "gpt-image-2.5-flare",
  sunburst: "gpt-image-2.5-sunburst",
  "gpt-image-2-ext": "gpt-image-2", // 旧别名
};
const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".gif": "image/gif",
};

// ---------- 参数 ----------

interface Args {
  prompt?: string;
  promptfiles: string[];
  image?: string;
  model: string;
  resolution: string;
  quality?: string;
  size?: string;
  sizeGiven: boolean;
  refs: string[];
  n: number;
  outputFormat: string;
  outputCompression?: number;
  background?: string;
  moderation?: string;
  nsfwCheck: boolean;
  officialFallback: boolean;
  responseFormat: "file" | "url";
  pollInterval: number;
  timeout: number;
  apiKey?: string;
  baseUrl?: string;
  json: boolean;
}

function usage(): string {
  return `apimart-image-gen — GPT-Image-2.5 via api.apimart.ai（异步任务：提交 → 轮询 → 下载）

用法：
  bun main.ts --prompt "一只橘猫" --image out.png
  bun main.ts --prompt "改成水彩风" --ref input.png --image out.png
  bun main.ts --prompt "..." --image out.png --ar 16:9 --resolution 2k --quality high --json
  bun main.ts --prompt "商品图，透明背景" --image out.png --background transparent --output-format png

参数：
  --prompt <s>            图像描述（与 --promptfiles 二选一）
  --promptfiles <f...>    从文件读提示词，多文件按空行拼接
  --image <path>          输出图片路径（--response-format url 时可省略）
  --model <id>            默认 gpt-image-2.5-flare；可写 flare / sunburst 简写；
                          兼容旧 gpt-image-2（但不支持 xhigh/max 档）
  --ar | --size <v>       15 种比例（如 16:9）、auto、或像素（如 1920x1088）；默认 1:1
                          像素须为 16 的倍数、单边 ≤3840、长短边 ≤3:1
                          有 --ref 且未指定时不传 size，输出跟随输入图比例
  --resolution <v>        1k|2k|4k（默认 1k，与比例共同决定输出像素）
  --quality <v>           low|medium|high|xhigh|max|auto（默认 medium）
                          xhigh/max 仅 GPT-Image-2.5 支持；auto 会按 max 预扣额度
                          旧写法 normal|2k|4k 仍视为 resolution 档位（兼容 baoyu 习惯）
  --ref <f...>            参考图（最多 16 张）：本地文件自动上传换 URL（接口已不支持
                          base64 直传），http(s) URL 原样传；单张 ≤20M
  --n <int>               生成张数（默认 1，1~4）
  --output-format <v>     png（默认）| jpeg | webp
  --output-compression <0-100>  压缩强度，仅 jpeg / webp 生效
  --background <v>        transparent | opaque | auto；transparent 仅 png/webp
  --moderation <v>        auto | low（接口默认 low）
  --response-format <v>   file=下载落盘（默认）；url=只返回图片 URL（注意过期时间）
  --poll-interval <sec>   轮询间隔，默认 3 秒
  --timeout <sec>         任务总超时，默认 600 秒
  --api-key <s>           覆盖环境变量
  --base-url <s>          覆盖默认 https://api.apimart.ai/v1
  --json                  stdout 只输出最终 JSON，进度走 stderr`;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    promptfiles: [], refs: [], n: 1, nsfwCheck: false, officialFallback: false,
    responseFormat: "file", pollInterval: 3, timeout: 600, json: false,
    model: process.env.APIMART_IMAGE_MODEL || "gpt-image-2.5-flare",
    resolution: (process.env.APIMART_IMAGE_RESOLUTION || "1k").toLowerCase(),
    quality: (process.env.APIMART_IMAGE_QUALITY || "medium").toLowerCase(),
    outputFormat: "png",
    sizeGiven: false,
  };
  const variadic = (i: number, push: (s: string) => void) => {
    while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) push(argv[++i]);
    return i;
  };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    const next = (): string => {
      if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) throw new Error(`${t} 缺少参数值`);
      return argv[++i];
    };
    switch (t) {
      case "--prompt": a.prompt = next(); break;
      case "--promptfiles": i = variadic(i, (s) => a.promptfiles.push(s)); break;
      case "--image": a.image = next(); break;
      case "--model": a.model = next(); break;
      case "--resolution": a.resolution = next().toLowerCase(); break;
      case "--quality": {
        const q = next().toLowerCase();
        if (LEGACY_QUALITY_TO_RESOLUTION[q]) {
          a.resolution = LEGACY_QUALITY_TO_RESOLUTION[q]; // 旧别名 → resolution
          a.quality = undefined;
        } else if (QUALITIES.has(q)) {
          a.quality = q;
        } else {
          throw new Error(`--quality 只支持 low|medium|high|xhigh|max|auto（旧别名 normal|2k|4k），收到 ${q}`);
        }
        break;
      }
      case "--ar": case "--size": a.size = next(); a.sizeGiven = true; break;
      case "--ref": i = variadic(i, (s) => a.refs.push(s)); break;
      case "--n": a.n = parseInt(next(), 10); break;
      case "--output-format": case "--format": a.outputFormat = next().toLowerCase(); break;
      case "--output-compression": a.outputCompression = parseInt(next(), 10); break;
      case "--background": a.background = next().toLowerCase(); break;
      case "--moderation": a.moderation = next().toLowerCase(); break;
      case "--nsfw-check": a.nsfwCheck = true; break;
      case "--official-fallback": a.officialFallback = true; break;
      case "--response-format": {
        const v = next();
        if (v !== "file" && v !== "url") throw new Error(`--response-format 只支持 file|url，收到 ${v}`);
        a.responseFormat = v;
        break;
      }
      case "--poll-interval": a.pollInterval = parseFloat(next()); break;
      case "--timeout": a.timeout = parseFloat(next()); break;
      case "--api-key": a.apiKey = next(); break;
      case "--base-url": a.baseUrl = next(); break;
      case "--json": a.json = true; break;
      case "-h": case "--help": console.log(usage()); process.exit(0);
      default: throw new Error(`未知参数 ${t}（--help 查看用法）`);
    }
  }
  return a;
}

// ---------- .env 加载（与 baoyu-image-gen v2.1.0 同源：<cwd>/.baoyu-skills/.env 与 ~/.baoyu-skills/.env）----------

function parseEnvFile(p: string): Record<string, string> {
  try {
    const out: Record<string, string> = {};
    for (const raw of readFileSync(p, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (m) {
        let v = m[2].trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        out[m[1]] = v;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function loadEnv(): void {
  const merged = {
    ...parseEnvFile(path.join(homedir(), ".baoyu-skills", ".env")),
    ...parseEnvFile(path.join(process.cwd(), ".baoyu-skills", ".env")),
  };
  for (const [k, v] of Object.entries(merged)) if (!process.env[k]) process.env[k] = v;
}

// ---------- HTTP ----------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const strip = (s: string) => s.replace(/\/+$/, "");

function httpErrorMessage(status: number, j: any, text: string): string {
  const apiMsg = j?.error?.message || j?.message || (text || "").slice(0, 200);
  switch (status) {
    case 400: return `参数错误(400)：${apiMsg}（检查 size/resolution/quality/像素是否合法）`;
    case 401: return `身份验证失败(401)：${apiMsg}。请检查 APIMART_API_KEY 或 OPENAI_API_KEY`;
    case 402: return `账户余额不足(402)：${apiMsg}`;
    case 413: return `文件过大(413)：${apiMsg}`;
    case 429: return `请求过于频繁(429)：${apiMsg}`;
    case 500: case 502: case 503: case 504: return `服务端错误(${status})：${apiMsg}`;
    default: return `HTTP ${status}：${apiMsg}`;
  }
}

/** 本地参考图 → POST /v1/uploads/images（multipart 字段 file）→ 公网 URL（72h 有效） */
async function uploadRefImage(base: string, key: string, ref: string, log: (s: string) => void): Promise<string> {
  const ext = path.extname(ref).toLowerCase();
  const mime = MIME_BY_EXT[ext];
  if (!mime) throw new Error(`参考图格式仅支持 jpg/png/webp/gif：${ref}`);
  const size = statSync(ref).size;
  if (size > 20 * 1024 * 1024) throw new Error(`参考图单张限 20M：${ref}（${(size / 1048576).toFixed(1)}M）`);

  let lastErr = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const fd = new FormData();
      fd.append("file", new Blob([readFileSync(ref)], { type: mime }), path.basename(ref));
      const res = await fetch(`${base}/uploads/images`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
        body: fd,
      });
      const text = await res.text();
      let j: any = null;
      try { j = JSON.parse(text); } catch { /* 非 JSON */ }
      const url = j?.url || j?.data?.url;
      if (res.ok && url) return url;
      if ([429, 500, 502, 503, 504].includes(res.status)) {
        lastErr = httpErrorMessage(res.status, j, text);
      } else {
        throw new Error(`上传参考图失败：${ref} → ${httpErrorMessage(res.status, j, text)}`);
      }
    } catch (e: any) {
      if (String(e?.message || e).startsWith("上传参考图失败")) throw e;
      lastErr = `网络错误：${e?.message || e}`;
    }
    log(`上传参考图失败（第 ${attempt}/3 次）：${ref}，${lastErr}`);
    if (attempt < 3) await sleep(attempt * 1500);
  }
  throw new Error(`上传参考图失败：${ref}，${lastErr}`);
}

/** 精确像素尺寸规则：16 的倍数、单边 ≤3840、长短边 ≤3:1、总像素 655,360~8,294,400 */
function validatePixelSize(s: string): void {
  const m = /^(\d{2,5})x(\d{2,5})$/.exec(s);
  if (!m) throw new Error(`--ar/--size 不合法：${s}（支持 15 种比例、WxH 像素或 auto）`);
  const [w, h] = [Number(m[1]), Number(m[2])];
  if (w % 16 !== 0 || h % 16 !== 0) throw new Error(`精确像素宽高必须是 16 的倍数：${s}`);
  if (w > 3840 || h > 3840) throw new Error(`单边像素不得超过 3840：${s}`);
  const [long, short] = w >= h ? [w, h] : [h, w];
  if (long > short * 3) throw new Error(`长短边之比不得超过 3:1：${s}`);
  const total = w * h;
  if (total < 655_360 || total > 8_294_400) {
    throw new Error(`总像素须在 655,360~8,294,400 之间：${s}（当前 ${total}）`);
  }
}

// ---------- 主流程 ----------

async function main() {
  const a = parseArgs(process.argv.slice(2));
  loadEnv();

  const log = (msg: string) => console.error(msg);

  // 模型归一化
  const model = MODEL_ALIASES[a.model.toLowerCase()] ?? a.model;
  const is25 = model.startsWith("gpt-image-2.5");

  // 提示词
  let prompt = a.prompt ?? "";
  if (!prompt && a.promptfiles.length) {
    prompt = a.promptfiles.map((f) => {
      if (!existsSync(f)) throw new Error(`提示词文件不存在：${f}`);
      return readFileSync(f, "utf8").trim();
    }).filter(Boolean).join("\n\n");
  }
  if (!prompt) throw new Error("必须提供 --prompt 或 --promptfiles");
  if (!Number.isInteger(a.n) || a.n < 1 || a.n > 4) throw new Error(`--n 取值 1~4，收到 ${a.n}`);
  if (!RESOLUTIONS.has(a.resolution)) throw new Error(`--resolution 只支持 1k|2k|4k，收到 ${a.resolution}`);
  if (a.quality && !QUALITIES.has(a.quality)) {
    throw new Error(`--quality 只支持 low|medium|high|xhigh|max|auto，收到 ${a.quality}`);
  }
  if (!is25 && (a.quality === "xhigh" || a.quality === "max")) {
    throw new Error(`quality xhigh/max 仅 GPT-Image-2.5 支持，当前模型 ${model}（会返回 400，不会自动降级）`);
  }
  if (a.sizeGiven && a.size) {
    const s = a.size.toLowerCase();
    if (!RATIOS.has(s)) validatePixelSize(s);
  }
  if (!OUTPUT_FORMATS.has(a.outputFormat)) {
    throw new Error(`--output-format 只支持 png|jpeg|webp，收到 ${a.outputFormat}`);
  }
  if (a.background && !BACKGROUNDS.has(a.background)) {
    throw new Error(`--background 只支持 transparent|opaque|auto，收到 ${a.background}`);
  }
  if (a.background === "transparent" && a.outputFormat === "jpeg") {
    throw new Error("transparent 背景仅支持 png/webp（JPEG 无 Alpha 通道）");
  }
  if (a.moderation && !MODERATIONS.has(a.moderation)) {
    throw new Error(`--moderation 只支持 auto|low，收到 ${a.moderation}`);
  }
  if (a.outputCompression !== undefined && (a.outputCompression < 0 || a.outputCompression > 100)) {
    throw new Error(`--output-compression 取值 0~100，收到 ${a.outputCompression}`);
  }
  if (a.outputCompression !== undefined && a.outputFormat === "png") {
    throw new Error("--output-compression 仅对 jpeg/webp 生效");
  }
  if (a.responseFormat === "file" && !a.image) throw new Error("file 模式必须提供 --image 输出路径");
  if (a.refs.length > MAX_REFS) throw new Error(`参考图最多 ${MAX_REFS} 张，收到 ${a.refs.length}`);

  // base / key 解析
  const base = strip(a.baseUrl || process.env.APIMART_BASE_URL || "").length
    ? strip(a.baseUrl || process.env.APIMART_BASE_URL!)
    : (process.env.OPENAI_BASE_URL || "").includes(APIMART_HOST)
      ? strip(process.env.OPENAI_BASE_URL!)
      : DEFAULT_BASE;
  const key = a.apiKey
    || process.env.APIMART_API_KEY
    || (base.includes(APIMART_HOST) ? process.env.OPENAI_API_KEY : undefined);
  if (!key) {
    throw new Error(
      "缺少 API Key：设置 APIMART_API_KEY，或在 ~/.baoyu-skills/.env 配置指向 apimart 的 OPENAI_BASE_URL + OPENAI_API_KEY",
    );
  }

  // 参考图：本地文件先上传换 URL（生成接口已不支持 base64）；URL 原样
  const imageUrls: string[] = [];
  for (const ref of a.refs) {
    if (/^https?:\/\//i.test(ref)) {
      imageUrls.push(ref);
      continue;
    }
    if (!existsSync(ref)) throw new Error(`参考图不存在：${ref}`);
    log(`上传参考图：${ref}`);
    imageUrls.push(await uploadRefImage(base, key, ref, log));
  }

  // 请求体：有参考图且未显式指定 size 时不传（输出跟随输入比例，与官方文档一致）
  const body: Record<string, unknown> = {
    model, prompt, n: a.n, resolution: a.resolution,
    quality: a.quality ?? "auto", output_format: a.outputFormat,
  };
  if (a.sizeGiven && a.size) body.size = a.size;
  else if (!imageUrls.length) body.size = "1:1";
  if (imageUrls.length) body.image_urls = imageUrls;
  if (a.outputCompression !== undefined) body.output_compression = a.outputCompression;
  if (a.background) body.background = a.background;
  if (a.moderation) body.moderation = a.moderation;
  if (a.nsfwCheck) body.nsfw_check = true;
  if (a.officialFallback) body.official_fallback = true;

  // 1. 提交任务（网络错误 / 429 / 5xx 重试 3 次）
  log(
    `提交任务：${model} | size=${body.size ?? "跟随参考图"} | resolution=${a.resolution}` +
    ` | quality=${body.quality}${imageUrls.length ? ` | 参考图×${imageUrls.length}` : ""}`,
  );
  let taskId = "";
  let directDataUrls: string[] = [];
  let lastErr = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    let outcome:
      | { kind: "ok" } | { kind: "retry"; msg: string } | { kind: "fatal"; msg: string };
    try {
      const res = await fetch(`${base}/images/generations`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      let j: any = null;
      try { j = JSON.parse(text); } catch { /* 非 JSON */ }
      if (res.ok && j?.data?.[0]?.task_id) {
        taskId = j.data[0].task_id;
        outcome = { kind: "ok" };
      } else if (res.ok && (j?.data?.[0]?.url || j?.data?.[0]?.b64_json)) {
        // 防御：若中转将来改回标准 OpenAI 同步格式
        directDataUrls = j.data[0].b64_json
          ? [`data:image/png;base64,${j.data[0].b64_json}`]
          : [j.data[0].url];
        outcome = { kind: "ok" };
      } else if (res.ok) {
        outcome = { kind: "fatal", msg: `响应中没有 task_id 或图片：${JSON.stringify(j).slice(0, 200)}` };
      } else if ([429, 500, 502, 503, 504].includes(res.status)) {
        outcome = { kind: "retry", msg: httpErrorMessage(res.status, j, text) };
      } else {
        outcome = { kind: "fatal", msg: httpErrorMessage(res.status, j, text) };
      }
    } catch (e: any) {
      outcome = { kind: "retry", msg: `网络错误：${e?.message || e}` };
    }
    if (outcome.kind === "ok") break;
    if (outcome.kind === "fatal") throw new Error(outcome.msg);
    lastErr = outcome.msg;
    log(`提交失败（第 ${attempt}/3 次）：${lastErr}`);
    if (attempt < 3) await sleep(attempt * 1500);
  }
  if (!taskId && !directDataUrls.length) throw new Error(`提交任务失败：${lastErr}`);
  if (taskId) log(`任务已提交：${taskId}`);

  // 2. 轮询任务
  let task: any = null;
  if (taskId) {
    const deadline = Date.now() + a.timeout * 1000;
    let lastProgress = -1;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${base}/tasks/${taskId}`, {
          headers: { Authorization: `Bearer ${key}` },
        });
        const text = await res.text();
        let j: any = null;
        try { j = JSON.parse(text); } catch { /* 非 JSON */ }
        if (!res.ok) throw new Error(httpErrorMessage(res.status, j, text));
        const d = j?.data;
        if (d?.status === "completed") { task = d; break; }
        if (d?.status === "failed") {
          throw new Error(`任务失败：${d?.error?.message || JSON.stringify(d).slice(0, 200)}`);
        }
        const prog = typeof d?.progress === "number" ? d.progress : -1;
        if (prog !== lastProgress) {
          log(`状态：${d?.status ?? "unknown"}${prog >= 0 ? ` ${prog}%` : ""}${d?.estimated_time ? `（预计 ${d.estimated_time}s）` : ""}`);
          lastProgress = prog;
        }
      } catch (e: any) {
        log(`查询任务失败（继续轮询）：${e?.message || e}`);
      }
      await sleep(a.pollInterval * 1000);
    }
    if (!task) {
      throw new Error(`任务超时（>${a.timeout}s）。task_id=${taskId}，可稍后手动查询：GET ${base}/tasks/${taskId}`);
    }
    log(`任务完成：耗时 ${task.actual_time ?? "?"}s，费用 $${task.cost ?? "?"}（${task.credits_cost ?? "?"} credits）`);
  }

  // 3. 收集图片 URL
  let urls: string[] = directDataUrls;
  let expiresAt: number | undefined;
  if (task) {
    const resultImages = task?.result?.images ?? [];
    urls = resultImages.flatMap((im: any) => im?.url ?? []);
    expiresAt = resultImages[0]?.expires_at;
  }
  if (!urls.length) throw new Error(`任务完成但未取到图片 URL：${JSON.stringify(task?.result ?? task).slice(0, 200)}`);

  // 4. 输出
  if (a.responseFormat === "url") {
    console.log(JSON.stringify({
      ok: true, taskId, urls, expiresAt: expiresAt ? new Date(expiresAt * 1000).toISOString() : null,
      cost: task?.cost ?? null, creditsCost: task?.credits_cost ?? null, usage: task?.usage ?? null,
      actualTime: task?.actual_time ?? null, model,
      size: body.size ?? null, resolution: a.resolution, quality: body.quality ?? null,
    }, null, 2));
    return;
  }

  const ext = path.extname(a.image!) || `.${a.outputFormat}`;
  const stem = a.image!.slice(0, a.image!.length - ext.length);
  const outputs = urls.length <= 1 ? [a.image!] : urls.map((_, i) => `${stem}-${i + 1}${ext}`);
  for (let i = 0; i < urls.length; i++) {
    const u = urls[i];
    if (u.startsWith("data:")) {
      writeFileSync(outputs[i], Buffer.from(u.split(",")[1], "base64"));
    } else {
      const res = await fetch(u);
      if (!res.ok) throw new Error(`下载图片失败 HTTP ${res.status}：${u.slice(0, 120)}`);
      writeFileSync(outputs[i], Buffer.from(await res.arrayBuffer()));
    }
    log(`已保存：${outputs[i]}`);
  }
  console.log(JSON.stringify({
    ok: true, taskId, savedImages: outputs, model,
    size: body.size ?? null, resolution: a.resolution, quality: body.quality ?? null,
    expiresAt: expiresAt ? new Date(expiresAt * 1000).toISOString() : null,
    cost: task?.cost ?? null, creditsCost: task?.credits_cost ?? null, usage: task?.usage ?? null,
    actualTime: task?.actual_time ?? null, prompt,
  }, null, 2));
}

main().catch((e: any) => {
  console.error(`Error: ${e?.message || e}`);
  process.exit(1);
});
