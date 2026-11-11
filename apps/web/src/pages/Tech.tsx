import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowRightIcon, ShieldIcon } from "../components/Icon";
import { useT } from "../i18n";

// 技术说明 / Technical notes: how a request is executed (worker nodes, TUI mode) and why some relay-detector items
// differ from a direct API call. Replaces the former "Verify" page (its HMAC check could never pass, X-4).
// Long-form copy lives here per language rather than in the i18n dictionaries.

interface DetectorRow {
  item: string;
  seen: string;
  why: string;
}

interface Copy {
  title: string;
  sub: string;
  summaryTitle: string;
  summary: string[];
  pathTitle: string;
  pathSteps: string[];
  workerTitle: string;
  workerIntro: string;
  worker: { h: string; p: string }[];
  tuiTitle: string;
  tuiIntro: string;
  tui: { h: string; p: string }[];
  detectTitle: string;
  detectIntro: string;
  detectHead: [string, string, string];
  detect: DetectorRow[];
  whyTitle: string;
  why: string[];
  checkTitle: string;
  check: string[];
  fitTitle: string;
  fit: string[];
  docsCta: string;
  poolCta: string;
}

const zh: Copy = {
  title: "技术说明",
  sub: "请求是怎么被执行的，节点怎么运转，以及为什么有些「中转检测」项在我们这里对不上。",
  summaryTitle: "先说结论",
  summary: [
    "你的请求不是被我们原样转发给官方 API 的。它由节点上运行的官方 Claude Code 客户端，以订阅账号的身份执行；模型是官方模型，你拿到的响应是我们把 Claude Code 的输出翻译回 API 格式的结果。",
    "因此，逐字段对比「是否和直连官方 API 一模一样」的检测工具，在消息 ID、思考签名、Token 用量等几项上会报不一致。这些差异来自执行方式，不代表模型被替换。",
    "这些项我们有意不去「修」：让它们通过不会让模型更真、输出更好，却要么得伪造字段，要么得改动发给上游的请求形态——后者是账号被停用的直接原因。所有取舍只有一个目的：不烧号。",
  ],
  pathTitle: "一次请求的路径",
  pathSteps: [
    "网关收到请求，校验 Key、余额和并发。",
    "调度为这段对话选一个订阅账号。同一段对话会尽量一直落在同一个账号上，上下文和缓存才连续。",
    "请求经控制面下发到该账号所在的节点。",
    "节点上的官方 Claude Code 用该账号执行这一轮，经该账号固定的出口连到 Anthropic。",
    "网关把 Claude Code 的输出翻译成 Messages / Chat Completions 格式，流式返回给你，并按用量结算。",
  ],
  workerTitle: "Worker 节点怎么运转",
  workerIntro: "Worker 节点是实际执行请求的机器。每台节点上跑着很多个相互隔离的 Claude Code 进程，每个账号的环境是固定的：",
  worker: [
    { h: "一号一出口", p: "每个账号绑定一条固定的出口线路，上游看到的 IP 始终是同一个。线路不通时账号直接冻结，等人工处理；不会临时换 IP，也不会绕过线路直连。" },
    { h: "一号一设备", p: "每个账号有自己固定的设备标识、机器特征和工作目录，更新节点程序、更换服务器都不会改变它们。" },
    { h: "组织之间隔离", p: "不同组织的账号在节点上用不同的系统用户运行，文件和进程互相不可见。" },
    { h: "你的 system 是追加的", p: "Claude Code 自带系统提示。你传的 system 追加在它后面，而不是替换它，所以模型知道自己运行在 Claude Code 里。" },
    { h: "你的工具由你执行", p: "你在请求里定义的 tools 会作为外部工具交给 Claude Code。节点不执行任何工具：模型发起调用时，这一轮以 tool_use 结束并交还给你，你执行后把 tool_result 发回，同一个会话继续。" },
    { h: "不换模型", p: "你请求的模型被上游拒绝或暂时不可用时，我们把原始结果返回给你，不会悄悄换成别的模型。" },
    { h: "额度窗口", p: "订阅账号有 5 小时和每周两个额度窗口。账号用到接近上限就停止接新请求，等窗口重置；这期间你的对话可能要等，或返回 503。" },
  ],
  tuiTitle: "TUI 节点（交互模式）怎么运转",
  tuiIntro: "Claude Code 有两种运行方式：非交互（脚本式，一问一答后退出）和交互式（人坐在终端前用的那种界面，简称 TUI）。目前节点默认使用交互模式。",
  tui: [
    { h: "怎么做的", p: "节点在一个虚拟终端里启动交互式 Claude Code，把你的消息输入进去，再从它的会话记录和响应流里读出结果。我们只读它的输出，不改它发给上游的请求。" },
    { h: "为什么用交互模式", p: "非交互方式在上游被计作 Agent SDK 入口：我们实测同样的任务消耗的订阅额度明显更多，官方也已公告要把这类用法移出订阅额度。交互式是 Claude Code 最标准的使用形态。用它，同样的账号能服务更多请求，也更不容易被风控。" },
    { h: "代价", p: "每个会话是一个常驻进程：新开会话要启动几秒，首字比直连 API 慢；偶尔会启动失败并返回 502。已经输出给你的内容我们不会重放，请直接重试。" },
    { h: "仍走非交互的情况", p: "少数交互模式接不住的请求（例如一次性的极短会话，或被上游拒绝后的当轮重试）会回落到非交互方式执行，对你是透明的。" },
  ],
  detectTitle: "常见检测项：为什么对不上",
  detectIntro: "下面是中转检测工具常报的几项，以及各自的真实原因。",
  detectHead: ["检测项", "你会看到什么", "原因"],
  detect: [
    { item: "消息 ID 不符", seen: "响应里的 id（msg_…）、工具调用 id（toolu_…）格式与官方一致，但拿去和官方记录比对对不上。", why: "这些 ID 是我们的翻译层生成的。你的一次请求在上游对应的是 Claude Code 会话里的一条或多条消息，没有一一对应的原始 ID 可以给你。" },
    { item: "思考签名不符 / 校验未通过", seen: "开启 thinking 时能收到 thinking 块和签名，但思考正文可能是空的；把带签名的历史 thinking 块回传给我们，也不会被用于校验。", why: "Claude Code 模式下上游只下发签名、不下发思考正文。别处产生的带签名 thinking 历史我们不会送进上游会话，所以依赖「回传签名」的检测不会通过。" },
    { item: "Token 用量有偏差", seen: "usage 里的输入 Token 与你自己用 count_tokens 算的略有出入。", why: "Claude Code 自带的系统提示和工具定义会计入上游的输入。我们按校准值把这部分平台开销扣掉，只向你计你自己的内容，因此会有小幅偏差。" },
    { item: "模型自述 / 身份", seen: "问「你是谁」，模型可能说自己是 Claude Code。", why: "它确实运行在 Claude Code 里，而且你的 system 是追加而不是替换。" },
    { item: "采样参数不生效", seen: "temperature、top_p、top_k 被忽略；assistant 预填不会被接着写。", why: "Claude Code 没有这些开关。我们不在它外面再包一层去模拟。" },
    { item: "首字延迟偏高", seen: "首字时间比直连 API 长，新开对话更明显。", why: "中间多了一个 Claude Code 进程，新会话需要启动。" },
  ],
  whyTitle: "为什么不去把这些分数「修」上去",
  why: [
    "没有正收益。这些检测项通过与否，不改变你用到的模型，也不改变输出质量。分数好看，服务并不会更好。",
    "让它们通过只有两条路。一是在响应里伪造字段，比如编一个看起来能对上的签名——这是骗检测工具，我们不做。二是绕开 Claude Code，自己拼请求、改请求头和提示词，让响应看起来像直连——每一处偏离官方客户端的地方，上游都看得见。",
    "偏离的代价是账号。我们吃过亏：一次只改了首条消息里几个字符的发布，几十分钟内让一整个组织的账号被停用。账号被烧，损失的是所有用户共用的额度。",
    "所以原则是：凡是上游看得见的东西，保持官方客户端原样；只为讨好检测工具的改动，一律不做。",
  ],
  checkTitle: "更有意义的验证方式",
  check: [
    "用你自己的真实任务对比输出质量，而不是比对响应头和 ID。",
    "测长上下文、工具调用、图片和 PDF 这些只有真模型才撑得住的能力。",
    "看用量：缓存读、缓存写、输出分别计了多少，是否与你的使用方式相符。",
    "账号池的实时状态在「账号池」页公开（脱敏）。",
  ],
  fitTitle: "什么情况不适合用我们",
  fit: [
    "业务依赖 temperature / top_p、assistant 预填，或要求响应与官方 API 逐字段一致。",
    "需要保留并回传带签名的思考内容做校验。",
    "对首字延迟极其敏感。这些场景请直接使用官方 API。",
  ],
  docsCta: "查看 API 文档",
  poolCta: "查看账号池",
};

const en: Copy = {
  title: "Technical notes",
  sub: "How a request is executed, how the nodes run, and why some relay-detector checks do not line up here.",
  summaryTitle: "The short version",
  summary: [
    "Your request is not forwarded byte-for-byte to the official API. It is executed by the official Claude Code client running on a node, under a subscription account. The model is the official model; the response you receive is Claude Code's output translated back into API format.",
    "Tools that compare every field against a direct API call will therefore report differences in message IDs, thinking signatures, token usage and a few other items. Those differences come from how the request is executed, not from a swapped model.",
    "We deliberately do not \"fix\" these items. Passing them would not make the model any more genuine or the output any better; it would require either fabricating fields or changing the shape of what we send upstream, and the latter is exactly what gets accounts suspended. Every trade-off here has one purpose: keeping accounts alive.",
  ],
  pathTitle: "The path of one request",
  pathSteps: [
    "The gateway receives the request and checks the key, balance and concurrency.",
    "The scheduler picks a subscription account for the conversation. A conversation stays on the same account whenever possible, so context and cache stay continuous.",
    "The request is dispatched through the control plane to the node that hosts that account.",
    "The official Claude Code on that node runs the turn with that account and reaches Anthropic through the account's fixed exit.",
    "The gateway translates Claude Code's output into Messages / Chat Completions format, streams it to you and settles usage.",
  ],
  workerTitle: "How worker nodes run",
  workerIntro: "Worker nodes are the machines that actually execute requests. Each runs many isolated Claude Code processes, and every account has a fixed environment:",
  worker: [
    { h: "One account, one exit", p: "Each account is bound to one fixed exit line, so upstream always sees the same IP. If the line goes down the account is frozen until an operator acts; we never switch IPs on the fly or bypass the line." },
    { h: "One account, one device", p: "Each account has its own fixed device identifier, machine profile and working directory. Updating the node software or moving servers does not change them." },
    { h: "Organizations are isolated", p: "Accounts of different organizations run as different system users on the node and cannot see each other's files or processes." },
    { h: "Your system prompt is appended", p: "Claude Code has its own system prompt. Yours is appended after it rather than replacing it, so the model knows it is running inside Claude Code." },
    { h: "You execute your tools", p: "The tools you define are handed to Claude Code as external tools. The node executes nothing: when the model calls one, the turn ends with tool_use and returns to you; you run it and send the tool_result back, and the same session continues." },
    { h: "No model substitution", p: "If the model you asked for is refused or unavailable upstream, you get the original result back. We do not silently switch models." },
    { h: "Quota windows", p: "Subscription accounts have a five-hour and a weekly quota window. An account close to its limit stops taking new requests until the window resets; meanwhile your conversation may wait or receive a 503." },
  ],
  tuiTitle: "How TUI nodes (interactive mode) run",
  tuiIntro: "Claude Code can run non-interactively (script style: one question, one answer, exit) or interactively (the terminal UI a person uses, TUI for short). Nodes now use interactive mode by default.",
  tui: [
    { h: "How it works", p: "The node starts interactive Claude Code in a virtual terminal, types your message into it, and reads the result from its session record and response stream. We only read its output; we do not alter what it sends upstream." },
    { h: "Why interactive mode", p: "Upstream counts the non-interactive form as an Agent SDK entry point: in our measurements the same work drains noticeably more subscription quota, and Anthropic has announced it will move that usage out of subscription limits. Interactive use is the most standard form of Claude Code. With it the same accounts serve more requests and are less likely to trip risk controls." },
    { h: "The cost", p: "Every session is a long-lived process: a new session takes a few seconds to start, so the first token is slower than a direct API call, and occasionally a start fails with a 502. We never replay output you have already received; just retry." },
    { h: "When non-interactive is still used", p: "A few requests interactive mode cannot carry (very short one-off sessions, or a same-turn retry after an upstream refusal) fall back to non-interactive execution. This is transparent to you." },
  ],
  detectTitle: "Common detector items and why they differ",
  detectIntro: "These are the items relay detectors most often flag, with the real reason for each.",
  detectHead: ["Item", "What you see", "Reason"],
  detect: [
    { item: "Message ID mismatch", seen: "The response id (msg_…) and tool call ids (toolu_…) have the official format but do not match any official record.", why: "Those IDs are generated by our translation layer. One of your requests maps to one or more messages inside a Claude Code session upstream, so there is no one-to-one original ID to hand back." },
    { item: "Thinking signature mismatch / not verified", seen: "With thinking enabled you receive thinking blocks and signatures, but the thinking text may be empty; signed thinking blocks you send back in history are not used for verification.", why: "In Claude Code mode upstream returns the signature without the thinking text. Signed thinking history produced elsewhere is not fed into the upstream session, so checks that rely on replaying signatures do not pass." },
    { item: "Token usage deviates", seen: "Input tokens in usage differ slightly from your own count_tokens figure.", why: "Claude Code's own system prompt and tool definitions count as upstream input. We subtract that platform overhead by calibration and bill only your content, which leaves a small deviation." },
    { item: "Self-description / identity", seen: "Asked who it is, the model may say it is Claude Code.", why: "It really is running inside Claude Code, and your system prompt is appended, not substituted." },
    { item: "Sampling parameters ignored", seen: "temperature, top_p and top_k have no effect; an assistant prefill is not continued.", why: "Claude Code has no such switches, and we do not wrap another layer around it to imitate them." },
    { item: "Higher time to first token", seen: "The first token takes longer than a direct API call, most visibly on a new conversation.", why: "There is a Claude Code process in between, and a new session has to start." },
  ],
  whyTitle: "Why we do not chase these scores",
  why: [
    "There is no upside. Whether these checks pass changes neither the model you get nor the quality of its output. A better score would not be a better service.",
    "There are only two ways to make them pass. One is fabricating response fields, for example inventing a signature that appears to match; that is deceiving the detector and we do not do it. The other is bypassing Claude Code, assembling requests ourselves and editing headers and prompts so responses look direct; upstream can see every place that deviates from the official client.",
    "The price of deviating is accounts. We learned this the hard way: one release that changed a few characters of the first message got a whole organization's accounts suspended within the hour. A burned account costs every user quota that all of them share.",
    "So the rule is: anything upstream can see stays exactly as the official client produces it, and changes whose only purpose is to please a detector are not made.",
  ],
  checkTitle: "More meaningful ways to verify",
  check: [
    "Compare output quality on your own real tasks rather than response headers and IDs.",
    "Test long context, tool calling, images and PDFs: capabilities only the real model sustains.",
    "Look at usage: how much cache read, cache write and output was counted, and whether it matches how you use the API.",
    "The live state of the account pool is public (redacted) on the Pool page.",
  ],
  fitTitle: "When we are not the right fit",
  fit: [
    "Your workload depends on temperature / top_p, assistant prefill, or responses identical to the official API field by field.",
    "You need to keep signed thinking content and send it back for verification.",
    "You are extremely sensitive to time to first token. For these cases use the official API directly.",
  ],
  docsCta: "Read the API docs",
  poolCta: "See the account pool",
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-12 sm:mt-14">
      <h2 className="font-display text-[22px] font-bold tracking-[-0.02em] text-on-surface sm:text-[26px]">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Bullets({ items }: { items: string[] }) {
  return (
    <ul className="space-y-2.5">
      {items.map((s) => (
        <li key={s} className="flex gap-3 text-[15px] leading-relaxed text-on-surface-variant">
          <span className="mt-[9px] h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
          <span>{s}</span>
        </li>
      ))}
    </ul>
  );
}

function Cards({ items }: { items: { h: string; p: string }[] }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {items.map((c) => (
        <div key={c.h} className="card p-5">
          <h3 className="text-[15px] font-semibold text-on-surface">{c.h}</h3>
          <p className="mt-1.5 text-[14px] leading-relaxed text-on-surface-variant">{c.p}</p>
        </div>
      ))}
    </div>
  );
}

export function Tech() {
  const { lang } = useT();
  const c = lang === "zh" ? zh : en;
  return (
    <div className="container-x max-w-4xl py-12 sm:py-16">
      <div className="kicker">
        <ShieldIcon width={14} height={14} className="leading-none text-primary" />
        {c.title}
      </div>
      <h1 className="mt-4 font-display text-[34px] font-bold leading-[1.05] tracking-[-0.03em] text-on-surface sm:text-[52px]">
        {c.title}
      </h1>
      <p className="mt-4 max-w-[640px] text-base leading-relaxed text-on-surface-variant sm:text-[17px]">{c.sub}</p>

      <div className="card mt-8 p-5 sm:p-6">
        <h2 className="text-sm font-semibold text-on-surface">{c.summaryTitle}</h2>
        <div className="mt-3 space-y-3">
          {c.summary.map((s) => (
            <p key={s} className="text-[15px] leading-relaxed text-on-surface-variant">
              {s}
            </p>
          ))}
        </div>
      </div>

      <Section title={c.pathTitle}>
        <ol className="space-y-3">
          {c.pathSteps.map((s, i) => (
            <li key={s} className="flex gap-3 text-[15px] leading-relaxed text-on-surface-variant">
              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-container-low font-mono text-[12px] font-semibold text-primary">
                {i + 1}
              </span>
              <span>{s}</span>
            </li>
          ))}
        </ol>
      </Section>

      <Section title={c.workerTitle}>
        <p className="mb-4 text-[15px] leading-relaxed text-on-surface-variant">{c.workerIntro}</p>
        <Cards items={c.worker} />
      </Section>

      <Section title={c.tuiTitle}>
        <p className="mb-4 text-[15px] leading-relaxed text-on-surface-variant">{c.tuiIntro}</p>
        <Cards items={c.tui} />
      </Section>

      <Section title={c.detectTitle}>
        <p className="mb-4 text-[15px] leading-relaxed text-on-surface-variant">{c.detectIntro}</p>
        <div className="space-y-3">
          {c.detect.map((d) => (
            <div key={d.item} className="card p-5">
              <h3 className="text-[15px] font-semibold text-on-surface">{d.item}</h3>
              <dl className="mt-3 grid gap-x-6 gap-y-3 sm:grid-cols-2">
                <div>
                  <dt className="font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-on-surface-faint">{c.detectHead[1]}</dt>
                  <dd className="mt-1 text-[14px] leading-relaxed text-on-surface-variant">{d.seen}</dd>
                </div>
                <div>
                  <dt className="font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-on-surface-faint">{c.detectHead[2]}</dt>
                  <dd className="mt-1 text-[14px] leading-relaxed text-on-surface-variant">{d.why}</dd>
                </div>
              </dl>
            </div>
          ))}
        </div>
      </Section>

      <Section title={c.whyTitle}>
        <Bullets items={c.why} />
      </Section>

      <Section title={c.checkTitle}>
        <Bullets items={c.check} />
      </Section>

      <Section title={c.fitTitle}>
        <Bullets items={c.fit} />
      </Section>

      <div className="mt-12 flex flex-col gap-3 sm:flex-row">
        <Link to="/docs" className="wk-btn wk-btn-md wk-btn-primary w-full sm:w-auto">
          {c.docsCta}
          <ArrowRightIcon width={18} height={18} />
        </Link>
        <Link to="/pool" className="wk-btn wk-btn-md wk-btn-ghost w-full sm:w-auto">
          {c.poolCta}
        </Link>
      </div>
    </div>
  );
}
