import { useDiffPress } from "./store";
import { cn } from "@/lib/utils";

/**
 * Editable view of an In-Review article's markdown. Loads from
 * GET /api/articles and saves edits back via PUT /api/articles. A plain
 * markdown textarea — no WYSIWYG; the orphaned DraftEditor stays unused.
 */
export function ArticleView() {
  const repo = useDiffPress((s) => s.articleRepo);
  const loading = useDiffPress((s) => s.articleLoading);
  const markdown = useDiffPress((s) => s.articleMarkdown);
  const saving = useDiffPress((s) => s.articleSaving);
  const saved = useDiffPress((s) => s.articleSaved);
  const setMarkdown = useDiffPress((s) => s.setArticleMarkdown);
  const save = useDiffPress((s) => s.saveArticle);

  if (!repo) {
    return (
      <p className="text-[14px] leading-[1.6] text-dp-muted">
        Select an article from the <strong>In Review</strong> column to edit it
        here.
      </p>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center gap-[9px] text-[12.5px] text-dp-faint-2">
        <span className="flex gap-1">
          {[0, 0.2, 0.4].map((d) => (
            <span
              key={d}
              className="dp-pulse h-[5px] w-[5px] rounded-full bg-dp-slate"
              style={{ animationDelay: `${d}s` }}
            />
          ))}
        </span>
        Loading article…
      </div>
    );
  }

  return (
    <div>
      <textarea
        value={markdown}
        onChange={(e) => setMarkdown(e.target.value)}
        spellCheck
        className="dp-prose min-h-[420px] w-full resize-y border-none bg-transparent font-dp-mono text-[14px] leading-[1.7] text-dp-ink outline-none"
      />
      <div className="mt-6 flex items-center gap-[13px]">
        <button
          onClick={save}
          disabled={saving}
          className={cn(
            "whitespace-nowrap rounded-[9px] border-none px-[18px] py-[11px] text-[14px] font-medium tracking-[-0.01em] transition-opacity",
            saving
              ? "cursor-not-allowed bg-dp-line-2 text-dp-faint-3"
              : "cursor-pointer bg-dp-ink text-dp-paper hover:opacity-[0.88]",
          )}
        >
          {saving ? "Saving…" : "Save changes"}
        </button>
        {saved && !saving && (
          <span className="text-[13px] text-dp-green">✓ Saved</span>
        )}
      </div>
    </div>
  );
}
