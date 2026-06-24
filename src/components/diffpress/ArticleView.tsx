import { DraftEditor } from "./DraftEditor";
import { useDiffPress } from "./store";

/**
 * In-Review article surface. Loads an article's markdown from GET /api/articles,
 * then hands off to the WYSIWYG DraftEditor (which renders the markdown, lets
 * you edit it, and saves back via PUT /api/articles). Keyed by repo so the
 * editor remounts — and re-seeds — when a different article is opened.
 */
export function ArticleView() {
  const repo = useDiffPress((s) => s.articleRepo);
  const loading = useDiffPress((s) => s.articleLoading);

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

  return <DraftEditor key={repo} />;
}
