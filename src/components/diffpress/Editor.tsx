import { ArticleView } from "./ArticleView";
import { ReviewArticle } from "./ReviewArticle";
import { useDiffPress } from "./store";

export function Editor() {
  const mode = useDiffPress((s) => s.editorMode);
  const review = mode === "review";
  return (
    <main className="flex-1 overflow-y-auto px-[clamp(20px,5vw,40px)] pb-[200px] pt-[clamp(40px,6vw,72px)]">
      {/* Review mode gets a wider container so the note side-panel has room. */}
      <div className={review ? "mx-auto max-w-[1100px]" : "mx-auto max-w-[680px]"}>
        {review ? <ReviewArticle /> : <ArticleView />}
      </div>
    </main>
  );
}
