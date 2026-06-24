// Static mock data for the DiffPress workspace. In production these payloads
// arrive from the API; here they seed the stubbed services in `services.ts`.

import type { DeployPayload } from "./types";

// The article body for the live Draft editor (contentEditable seed HTML).
export const ARTICLE_HTML = `<div class="dp-meta">helix-labs/helix&nbsp;&nbsp;·&nbsp;&nbsp;★ 14.2k&nbsp;&nbsp;·&nbsp;&nbsp;+2.1k this week</div>
<h1>State of the Art: Helix</h1>
<p class="dp-lead">A code-critic deep dive into the durable orchestration runtime that wants to make every agent step a database transaction.</p>
<p>Every few months a project arrives claiming to make LLM agents "production-ready." Most are wrappers around a chat loop. Helix is not a wrapper — it is a runtime that treats every agent step as a durable, replayable unit of work.</p>
<h2>The premise</h2>
<p>On the surface the API is disarmingly simple. You decorate a function with <code class="dp-icode">@step</code>, and Helix registers it as a resumable step whose state survives process restarts, redeploys, and the occasional model timeout.</p>
<h2>Architecture</h2>
<p>Underneath, Helix is event-sourced. Each step appends to an append-only log, and recovery is simply a replay of that log against your code.</p>
<pre class="dp-code"><code>@step(retries=3)
async def research(topic: str) -> Brief:
    sources = await search(topic)
    draft   = await model.summarize(sources)
    return Brief(draft=draft, sources=sources)</code></pre>
<p>The elegance has a cost. Because recovery replays your function from the top, every side-effect above a checkpoint must be deterministic.</p>
<h2>Verdict</h2>
<p>Helix is the most coherent answer to durable agents we have reviewed. It is not yet the easy one — but for teams comfortable with event-sourced systems, the model will feel inevitable.</p>`;

export const EMPTY_DEPLOY: Omit<DeployPayload, "articleId"> = {
  targets: { devto: true, linkedin: false, substack: true, portfolio: true },
  timing: "now",
  scheduleAt: "",
  seriesLink: "",
};
