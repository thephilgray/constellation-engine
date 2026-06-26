import { X } from "lucide-react";
import { useDiffPress } from "./store";

/** Compact relative time, e.g. "just now", "10 min ago", "2 hr ago". */
function relativeTime(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const day = Math.floor(hr / 24);
  return `${day} day${day === 1 ? "" : "s"} ago`;
}

export function VersionHistoryDrawer() {
  const historyOpen = useDiffPress((s) => s.historyOpen);
  const closeHistory = useDiffPress((s) => s.closeHistory);
  const drafts = useDiffPress((s) => s.drafts);
  const articleTitle = useDiffPress((s) => s.articleTitle);
  const restoreDraft = useDiffPress((s) => s.restoreDraft);

  if (!historyOpen) return null;

  return (
    <>
      <div
        onClick={closeHistory}
        className="dp-anim-fade fixed inset-0 z-[60] bg-[rgba(20,18,16,0.16)] backdrop-blur-[2px]"
      />
      <aside className="dp-anim-slide fixed inset-y-0 right-0 z-[61] w-full overflow-y-auto bg-white p-[clamp(24px,4vw,36px)] shadow-[-24px_0_70px_rgba(26,24,20,0.12)] min-[880px]:w-[462px]">
        <div className="mb-7 flex items-start justify-between gap-4">
          <div>
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-dp-faint">
              Version History
            </div>
            <div className="text-[16px] font-medium tracking-[-0.01em]">
              {articleTitle || "Draft"}
            </div>
          </div>
          <button
            onClick={closeHistory}
            className="-mr-1 -mt-1 flex cursor-pointer border-none bg-transparent p-1 text-dp-faint hover:text-dp-ink"
          >
            <X size={19} strokeWidth={1.7} />
          </button>
        </div>

        <ul className="flex flex-col">
          <li className="flex items-center gap-3 pb-4">
            <span className="h-[7px] w-[7px] flex-[0_0_auto] rounded-full bg-dp-green" />
            <span className="text-[13px] font-medium text-dp-ink">Current draft</span>
          </li>
          {drafts.length === 0 && (
            <li className="pl-[19px] text-[12.5px] text-dp-faint-2">No saved versions yet.</li>
          )}
          {drafts.map((d) => (
            <li key={d.ts} className="flex items-center justify-between gap-3 border-t border-dp-line-2 py-[11px]">
              <span className="flex items-center gap-3">
                {/* ponytail: hollow dots only until DraftMeta carries an ai/user flag */}
                <span className="h-[7px] w-[7px] flex-[0_0_auto] rounded-full border border-dp-faint-3" />
                <span className="flex flex-col">
                  <span className="text-[13px] text-dp-muted">{relativeTime(d.ts)}</span>
                  <span className="font-dp-mono text-[11.5px] text-dp-faint-2">
                    {new Date(d.ts).toLocaleString()}
                  </span>
                </span>
              </span>
              <button
                onClick={() => void restoreDraft(d.ts)}
                className="cursor-pointer rounded-md border-none bg-transparent px-2 py-1 text-[12.5px] text-dp-slate hover:bg-dp-hover"
              >
                Restore
              </button>
            </li>
          ))}
        </ul>
      </aside>
    </>
  );
}
