import Markdown from "react-markdown";
import { useDiffPress } from "./store";

/**
 * Read-only render of a published article's markdown, fetched from
 * GET /api/articles. Replaces the mock WYSIWYG draft + marginalia review:
 * there is no save/edit backend, so the article is presented read-only.
 */
export function ArticleView() {
  const repo = useDiffPress((s) => s.articleRepo);
  const loading = useDiffPress((s) => s.articleLoading);
  const markdown = useDiffPress((s) => s.articleMarkdown);

  if (!repo) {
    return (
      <p className="text-[14px] leading-[1.6] text-dp-muted">
        Select an article from the <strong>In Review</strong> column to read it
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

  if (!markdown) {
    return (
      <p className="text-[14px] leading-[1.6] text-dp-muted">
        This article isn’t available yet.
      </p>
    );
  }

  return (
    <article className="dp-prose">
      <Markdown>{markdown}</Markdown>
    </article>
  );
}
