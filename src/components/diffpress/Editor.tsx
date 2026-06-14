import { useDiffPress } from "./store";
import { DraftEditor } from "./DraftEditor";
import { ReviewArticle } from "./ReviewArticle";

export function Editor() {
  const editorMode = useDiffPress((s) => s.editorMode);
  const isReview = editorMode === "review";

  return (
    <main className="flex-1 overflow-y-auto px-[clamp(20px,5vw,40px)] pb-[200px] pt-[clamp(40px,6vw,72px)]">
      {isReview ? (
        // Review: widens at ≥1080 to make room for margin notes beside the prose.
        <div className="relative mx-auto max-w-[680px] min-[1080px]:max-w-[1068px]">
          <div className="relative w-full min-[1080px]:w-[680px]">
            <ReviewArticle />
          </div>
        </div>
      ) : (
        <div className="mx-auto max-w-[680px]">
          <DraftEditor />
        </div>
      )}
    </main>
  );
}
