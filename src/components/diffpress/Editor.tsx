import { ArticleView } from "./ArticleView";

export function Editor() {
  return (
    <main className="flex-1 overflow-y-auto px-[clamp(20px,5vw,40px)] pb-[200px] pt-[clamp(40px,6vw,72px)]">
      <div className="mx-auto max-w-[680px]">
        <ArticleView />
      </div>
    </main>
  );
}
