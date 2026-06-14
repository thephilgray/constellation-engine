import { allNotesResolved, resolvedCount, TOTAL_NOTES, useDiffPress } from "./store";
import { TECH_EDITOR_NOTES } from "./data";
import { cn } from "@/lib/utils";
import type { DiffLine, TechEditorNote } from "./types";

const noteById = (id: string) =>
  TECH_EDITOR_NOTES.find((n) => n.id === id) as TechEditorNote;

// Stable empty reference — selecting `s.chat[id] ?? []` would return a fresh
// array each render and send Zustand's useSyncExternalStore into a loop.
const NO_MESSAGES: string[] = [];

function Dot({ id }: { id: string }) {
  const resolved = useDiffPress((s) => !!s.resolvedNotes[id]);
  const open = useDiffPress((s) => s.openNote === id);
  return (
    <span
      className={cn(
        "block h-[9px] w-[9px] rounded-full",
        resolved
          ? "bg-dp-slate"
          : open
            ? "bg-dp-slate shadow-[0_0_0_4px_rgba(90,97,120,0.14)]"
            : "border-[1.5px] border-dp-faint-4 bg-transparent",
      )}
    />
  );
}

function DiffBlock({ diff }: { diff: DiffLine[] }) {
  return (
    <div className="mb-[14px] rounded-lg bg-dp-wash px-[13px] py-[11px] font-dp-mono text-[12.5px] leading-[1.75]">
      {diff.map((line, i) => {
        if (line.kind === "context")
          return (
            <div key={i} className="text-[#8a877f]">
              {line.text}
            </div>
          );
        if (line.kind === "remove")
          return (
            <div
              key={i}
              className="text-dp-faint-2 line-through opacity-80 [text-decoration-color:#c4c1b8]"
            >
              − {line.text}
            </div>
          );
        return (
          <div
            key={i}
            className="-mx-1 my-0.5 rounded bg-dp-add-bg px-1 font-medium text-dp-add-ink"
          >
            + {line.text}
          </div>
        );
      })}
    </div>
  );
}

function NoteCard({ id }: { id: string }) {
  const note = noteById(id);
  const messages = useDiffPress((s) => s.chat[id]) ?? NO_MESSAGES;
  const resolved = useDiffPress((s) => !!s.resolvedNotes[id]);
  const pushChat = useDiffPress((s) => s.pushChat);
  const resolveNote = useDiffPress((s) => s.resolveNote);

  return (
    <div className="dp-anim-fadeup relative z-[5] my-[2px] mb-[30px] w-full rounded-[14px] bg-white p-[18px_19px] shadow-[0_6px_26px_rgba(26,24,20,0.08)] min-[1080px]:absolute min-[1080px]:left-[calc(100%+48px)] min-[1080px]:top-[-6px] min-[1080px]:my-0 min-[1080px]:w-[332px] min-[1080px]:shadow-[0_10px_40px_rgba(26,24,20,0.10)]">
      <div className="mb-3 flex items-center gap-2">
        <span className="h-[6px] w-[6px] rounded-full bg-dp-slate" />
        <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-dp-faint">
          AI Tech Editor
        </span>
      </div>
      <p className="mb-[14px] text-[14px] leading-[1.62] text-[#46443f] [text-wrap:pretty]">
        {note.note}
      </p>
      <DiffBlock diff={note.diff} />
      <div className="border-t border-dp-chip pt-[11px]">
        {messages.map((m, i) => (
          <div key={i} className="mb-2 text-[13px] leading-[1.5] text-[#46443f]">
            <span className="font-medium text-dp-faint-2">You&nbsp;·&nbsp;</span>
            {m}
          </div>
        ))}
        <input
          placeholder="Push back on this note…"
          onKeyDown={(e) => {
            const target = e.currentTarget;
            if (e.key === "Enter" && target.value.trim()) {
              pushChat(id, target.value.trim());
              target.value = "";
            }
          }}
          className="w-full border-none bg-transparent py-0.5 text-[16px] text-dp-ink outline-none"
        />
      </div>
      <button
        onClick={() => resolveNote(id)}
        className={cn(
          "mt-[15px] w-full cursor-pointer rounded-lg border-none p-[9px] text-[12.5px] font-medium transition-all",
          resolved
            ? "bg-transparent text-dp-green hover:opacity-85"
            : "bg-dp-hover text-[#46443f]",
        )}
      >
        {resolved ? "✓ Resolved · undo" : "Apply edit & resolve →"}
      </button>
    </div>
  );
}

function NotedParagraph({
  id,
  children,
}: {
  id: string;
  children: React.ReactNode;
}) {
  const streamed = useDiffPress((s) => s.streamedNoteIds.includes(id));
  const open = useDiffPress((s) => s.openNote === id);
  const resolved = useDiffPress((s) => !!s.resolvedNotes[id]);
  const toggleNote = useDiffPress((s) => s.toggleNote);

  return (
    <div className="relative">
      <p>{children}</p>

      {streamed && (
        <>
          {/* margin indicator (≥1080) */}
          <button
            onClick={() => toggleNote(id)}
            className="dp-anim-fade absolute left-[calc(100%+20px)] top-[3px] hidden h-[22px] w-[22px] cursor-pointer items-center justify-center border-none bg-transparent p-0 transition-transform hover:scale-[1.35] min-[1080px]:flex"
            aria-label="Toggle editor note"
          >
            <Dot id={id} />
          </button>

          {/* inline pill (<1080) */}
          <button
            onClick={() => toggleNote(id)}
            className="dp-anim-fade -mt-[14px] mb-7 inline-flex cursor-pointer items-center gap-[7px] whitespace-nowrap border-none bg-transparent py-1 text-[12.5px] font-medium tracking-[-0.005em] text-dp-slate min-[1080px]:hidden"
          >
            <Dot id={id} />
            {resolved ? "Resolved" : "Editor note"}
          </button>
        </>
      )}

      {open && <NoteCard id={id} />}
    </div>
  );
}

function StreamBanner() {
  const streaming = useDiffPress((s) => s.streaming);
  const count = useDiffPress((s) => s.streamedNoteIds.length);
  if (!streaming) return null;
  return (
    <div className="mb-7 flex items-center gap-[9px] text-[12.5px] text-dp-faint-2">
      <span className="flex gap-1">
        {[0, 0.2, 0.4].map((d) => (
          <span
            key={d}
            className="dp-pulse h-[5px] w-[5px] rounded-full bg-dp-slate"
            style={{ animationDelay: `${d}s` }}
          />
        ))}
      </span>
      AI Tech Editor is reviewing — {count} note{count === 1 ? "" : "s"} so far
    </div>
  );
}

function PublishTrigger() {
  const allResolved = useDiffPress(allNotesResolved);
  const count = useDiffPress(resolvedCount);
  const openPublish = useDiffPress((s) => s.openPublish);

  return (
    <div className="mt-[56px] flex flex-wrap items-center justify-between gap-5">
      <div className="flex items-center gap-[13px]">
        <span className="flex items-center gap-[6px]">
          {TECH_EDITOR_NOTES.map((n) => (
            <ProgDot key={n.id} id={n.id} />
          ))}
        </span>
        <span className="text-[13px] text-[#8a877f]">
          {allResolved
            ? "All notes resolved — ready to publish"
            : `${count} of ${TOTAL_NOTES} editor notes resolved · resolve all to publish`}
        </span>
      </div>
      <button
        onClick={openPublish}
        disabled={!allResolved}
        className={cn(
          "whitespace-nowrap rounded-[9px] border-none px-[18px] py-[11px] text-[14px] font-medium tracking-[-0.01em] transition-opacity",
          allResolved
            ? "cursor-pointer bg-dp-ink text-dp-paper hover:opacity-[0.88]"
            : "cursor-not-allowed bg-dp-line-2 text-dp-faint-3",
        )}
      >
        Publish article →
      </button>
    </div>
  );
}

function ProgDot({ id }: { id: string }) {
  const resolved = useDiffPress((s) => !!s.resolvedNotes[id]);
  return (
    <span
      className={cn(
        "block h-[7px] w-[7px] rounded-full",
        resolved
          ? "bg-dp-slate"
          : "box-border border-[1.5px] border-[#cfccc3]",
      )}
    />
  );
}

export function ReviewArticle() {
  return (
    <div className="dp-prose">
      <StreamBanner />

      <div className="mb-[38px]">
        <div className="dp-meta">
          helix-labs/helix&nbsp;&nbsp;·&nbsp;&nbsp;★ 14.2k&nbsp;&nbsp;·&nbsp;&nbsp;+2.1k
          this week
        </div>
        <h1>State of the Art: Helix</h1>
        <p className="dp-lead">
          A code-critic deep dive into the durable orchestration runtime that
          wants to make every agent step a database transaction.
        </p>
      </div>

      <p>
        Every few months a project arrives claiming to make LLM agents
        "production-ready." Most are wrappers around a chat loop. Helix is not a
        wrapper — it is a runtime that treats every agent step as a durable,
        replayable unit of work. After a week with it, that distinction turns out
        to matter more than the README suggests.
      </p>

      <h2>The premise</h2>
      <NotedParagraph id="n1">
        On the surface the API is disarmingly simple. You decorate a function
        with <code className="dp-icode">@step</code>, and Helix compiles it into a
        state machine that survives process restarts, redeploys, and the
        occasional model timeout. The promise on the front page is that "your
        agent loop becomes a database transaction."
      </NotedParagraph>

      <h2>Architecture</h2>
      <p>
        Underneath, Helix is event-sourced. Each step appends to an append-only
        log, and recovery is simply a replay of that log against your code. It is
        the pattern that powers Temporal and durable functions, adapted for the
        non-determinism of model calls.
      </p>
      <pre>
        <span className="text-[#8a877f]">@step(retries=3)</span>
        {`
async def research(topic: str) -> Brief:
    sources = await search(topic)          `}
        <span className="text-[#8a877f]"># checkpointed</span>
        {`
    draft   = await model.summarize(sources) `}
        <span className="text-[#8a877f]"># checkpointed</span>
        {`
    return Brief(draft=draft, sources=sources)`}
      </pre>

      <NotedParagraph id="n2">
        The elegance has a cost. Because recovery replays your function from the
        top, every line above a checkpoint must be deterministic. The developer
        log records the exact moment this leaks: a stray{" "}
        <code className="dp-icode">datetime.now()</code> inside a step produced a
        different branch on replay, and the agent quietly redid four minutes of
        work.
      </NotedParagraph>

      <h2>The developer experience</h2>
      <NotedParagraph id="n3">
        Setup is the weakest seam. The Food Critic developer log clocks a
        clean-clone-to-first-run at just under forty minutes, most of it spent
        discovering that the CLI silently assumes a running Postgres. The error,
        when it finally surfaces, points at a connection string rather than the
        missing dependency.
      </NotedParagraph>

      <h2>Verdict</h2>
      <NotedParagraph id="n4">
        Helix is the most coherent answer to durable agents we have reviewed. It
        is not yet the easy one. For teams already comfortable with event-sourced
        systems, the model will feel inevitable; for everyone else, the first
        afternoon will be spent unlearning the assumption that an agent is just a
        while-loop.
      </NotedParagraph>

      <PublishTrigger />
    </div>
  );
}
