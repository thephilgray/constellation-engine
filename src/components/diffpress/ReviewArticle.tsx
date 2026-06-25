import { useMemo } from "react";
import { allNotesResolved, resolvedCount, useDiffPress } from "./store";
import { mdToHtml } from "./markdownHtml";
import { cn } from "@/lib/utils";
import type { ReviewNote } from "./types";

// Stable empty reference — `s.chat[id] ?? []` would return a fresh array each
// render and send Zustand's useSyncExternalStore into a loop.
const NO_MESSAGES: string[] = [];

/** before → after diff for a note's proposed change (anchorText → replacement). */
function DiffBlock({ note }: { note: ReviewNote }) {
  return (
    <div className="mb-[14px] rounded-lg bg-dp-wash px-[13px] py-[11px] font-dp-mono text-[12.5px] leading-[1.75]">
      <div className="text-dp-faint-2 line-through opacity-80 [text-decoration-color:#c4c1b8]">
        − {note.anchorText}
      </div>
      <div className="-mx-1 my-0.5 rounded bg-dp-add-bg px-1 font-medium text-dp-add-ink">
        + {note.replacement}
      </div>
    </div>
  );
}

function NoteCard({ note }: { note: ReviewNote }) {
  const id = note.id;
  const messages = useDiffPress((s) => s.chat[id]) ?? NO_MESSAGES;
  const resolved = useDiffPress((s) => !!s.resolvedNotes[id]);
  const busy = useDiffPress((s) => !!s.noteBusy[id]);
  const canApply = useDiffPress((s) => s.articleMarkdown.includes(note.anchorText));
  const applyNote = useDiffPress((s) => s.applyNote);
  const replyToNote = useDiffPress((s) => s.replyToNote);

  return (
    <div className="dp-anim-fadeup w-full rounded-[14px] bg-white p-[18px_19px] shadow-[0_6px_26px_rgba(26,24,20,0.08)]">
      <div className="mb-3 flex items-center gap-2">
        <span className="h-[6px] w-[6px] rounded-full bg-dp-slate" />
        <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-dp-faint">
          AI Tech Editor
        </span>
      </div>
      <blockquote className="mb-[10px] border-l-2 border-dp-line-3 pl-[10px] text-[12.5px] italic leading-[1.5] text-dp-faint-2 [text-wrap:pretty]">
        “{note.anchorText}”
      </blockquote>
      <p className="mb-[14px] text-[14px] leading-[1.62] text-[#46443f] [text-wrap:pretty]">
        {note.note}
      </p>
      <DiffBlock note={note} />
      <div className="border-t border-dp-chip pt-[11px]">
        {messages.map((m, i) => (
          <div key={i} className="mb-2 text-[13px] leading-[1.5] text-[#46443f]">
            {m}
          </div>
        ))}
        <input
          disabled={busy}
          placeholder={busy ? "Editor is thinking…" : "Push back on this note…"}
          onKeyDown={(e) => {
            const target = e.currentTarget;
            if (e.key === "Enter" && target.value.trim()) {
              void replyToNote(id, target.value.trim());
              target.value = "";
            }
          }}
          className="w-full border-none bg-transparent py-0.5 text-[16px] text-dp-ink outline-none disabled:opacity-60"
        />
      </div>
      <button
        onClick={() => void applyNote(id)}
        disabled={resolved || !canApply}
        title={!canApply && !resolved ? "The quoted text no longer matches the article" : undefined}
        className={cn(
          "mt-[15px] w-full rounded-lg border-none p-[9px] text-[12.5px] font-medium transition-all",
          resolved
            ? "cursor-default bg-transparent text-dp-green"
            : canApply
              ? "cursor-pointer bg-dp-hover text-[#46443f] hover:opacity-85"
              : "cursor-not-allowed bg-dp-line-2 text-dp-faint-3",
        )}
      >
        {resolved ? "✓ Applied & resolved" : "Apply edit & resolve →"}
      </button>
    </div>
  );
}

function ReviewBanner() {
  const reviewing = useDiffPress((s) => s.reviewing);
  const reviewError = useDiffPress((s) => s.reviewError);
  const total = useDiffPress((s) => s.notes.length);
  const revealed = useDiffPress((s) => s.revealedNoteIds.length);
  if (reviewError) {
    return (
      <div className="mb-7 text-[12.5px] text-dp-rust">
        Review failed: {reviewError}. Try again.
      </div>
    );
  }
  if (reviewing) {
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
        AI Tech Editor is reviewing the article…
      </div>
    );
  }
  if (total === 0) {
    return (
      <div className="mb-7 text-[12.5px] text-dp-faint-2">
        No review yet — run the AI Tech Editor from the editor, or publish as-is.
      </div>
    );
  }
  return (
    <div className="mb-7 text-[12.5px] text-dp-faint-2">
      AI Tech Editor found {total} note{total === 1 ? "" : "s"}
      {revealed < total ? " …" : ""}
    </div>
  );
}

function PublishTrigger() {
  const allResolved = useDiffPress(allNotesResolved);
  const count = useDiffPress(resolvedCount);
  const total = useDiffPress((s) => s.notes.length);
  const openPublish = useDiffPress((s) => s.openPublish);

  return (
    <div className="mt-[56px] flex flex-wrap items-center justify-between gap-5">
      <span className="text-[13px] text-[#8a877f]">
        {total === 0
          ? "No outstanding notes — ready to publish"
          : allResolved
            ? "All notes resolved — ready to publish"
            : `${count} of ${total} editor notes resolved · resolve all to publish`}
      </span>
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

export function ReviewArticle() {
  const articleMarkdown = useDiffPress((s) => s.articleMarkdown);
  const notes = useDiffPress((s) => s.notes);
  const revealedNoteIds = useDiffPress((s) => s.revealedNoteIds);
  const html = useMemo(() => mdToHtml(articleMarkdown), [articleMarkdown]);
  const visible = notes.filter((n) => revealedNoteIds.includes(n.id));

  return (
    <div className="flex flex-col gap-10 min-[1080px]:flex-row min-[1080px]:gap-12">
      <div className="min-w-0 flex-1">
        <ReviewBanner />
        <div className="dp-prose" dangerouslySetInnerHTML={{ __html: html }} />
        <PublishTrigger />
      </div>

      {visible.length > 0 && (
        <aside className="flex flex-col gap-5 min-[1080px]:w-[340px] min-[1080px]:flex-[0_0_340px]">
          {visible.map((n) => (
            <NoteCard key={n.id} note={n} />
          ))}
        </aside>
      )}
    </div>
  );
}
