import { Copy, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useDiffPress } from "./store";

export function HandoffDrawer() {
  const drawerId = useDiffPress((s) => s.drawerId);
  const doc = useDiffPress((s) => s.handoffDoc);
  const repoUrl = useDiffPress((s) => s.repoUrl);
  const devLog = useDiffPress((s) => s.devLog);
  const copied = useDiffPress((s) => s.copied);
  const resuming = useDiffPress((s) => s.resuming);
  const resumed = useDiffPress((s) => s.resumed);
  const closeDrawer = useDiffPress((s) => s.closeDrawer);
  const setRepoUrl = useDiffPress((s) => s.setRepoUrl);
  const setDevLog = useDiffPress((s) => s.setDevLog);
  const copyHandoff = useDiffPress((s) => s.copyHandoff);
  const submitResume = useDiffPress((s) => s.submitResume);

  if (!drawerId) return null;
  const canResume = repoUrl.trim().length > 0 && !resuming;

  return (
    <>
      <div
        onClick={closeDrawer}
        className="dp-anim-fade fixed inset-0 z-[60] bg-[rgba(20,18,16,0.16)] backdrop-blur-[2px]"
      />
      <aside className="dp-anim-slide fixed inset-y-0 right-0 z-[61] w-full overflow-y-auto bg-white p-[clamp(24px,4vw,36px)] shadow-[-24px_0_70px_rgba(26,24,20,0.12)] min-[880px]:w-[462px]">
        <div className="mb-7 flex items-start justify-between gap-4">
          <div>
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-dp-faint">
              Local Dev Handoff
            </div>
            <div className="font-dp-mono text-[16px] font-medium tracking-[-0.01em]">
              {doc?.repoUrl ? (
                <a
                  href={doc.repoUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="hover:underline"
                >
                  {doc.name}
                </a>
              ) : (
                doc?.name ?? "…"
              )}
            </div>
          </div>
          <button
            onClick={closeDrawer}
            className="-mr-1 -mt-1 flex cursor-pointer border-none bg-transparent p-1 text-dp-faint hover:text-dp-ink"
          >
            <X size={19} strokeWidth={1.7} />
          </button>
        </div>

        <div className="mb-[10px] flex items-center justify-between">
          <span className="text-[12.5px] font-medium text-dp-muted">
            Handoff Prompt
          </span>
          <button
            onClick={copyHandoff}
            className="flex cursor-pointer items-center gap-[6px] border-none bg-transparent p-0 text-[12px] font-medium text-dp-slate hover:opacity-70"
          >
            <Copy size={13} strokeWidth={1.7} />
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <div className="mb-[34px] whitespace-pre-wrap rounded-[10px] bg-dp-wash px-[18px] py-4 font-dp-mono text-[12.5px] leading-[1.72] text-[#3a3833]">
          {doc?.handoff ?? ""}
        </div>

        {resumed ? (
          <div className="dp-anim-fadeup">
            <div className="mb-[10px] flex items-center gap-[9px]">
              <span className="h-2 w-2 rounded-full bg-dp-green" />
              <span className="text-[14px] font-semibold">Workflow resumed</span>
            </div>
            <p className="text-[13.5px] leading-[1.6] text-dp-muted">
              Developer log attached.{" "}
              <span className="font-dp-mono text-[#46443f]">{doc?.name}</span> has
              advanced to{" "}
              <strong className="font-semibold text-dp-ink">Drafting</strong>.
            </p>
          </div>
        ) : (
          <div>
            <div className="mb-[18px] text-[12.5px] font-medium text-dp-muted">
              Resume workflow
            </div>

            <div className="mb-[22px]">
              <FieldLabel>GitHub URL</FieldLabel>
              <input
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
                placeholder="https://github.com/…"
                className="w-full border-none border-b-[1.5px] border-dp-line bg-transparent py-[6px] font-dp-mono text-[16px] outline-none focus:border-dp-slate"
              />
            </div>

            <div className="mb-[26px]">
              <FieldLabel>Food Critic — Developer Log</FieldLabel>
              <textarea
                value={devLog}
                onChange={(e) => setDevLog(e.target.value)}
                rows={4}
                placeholder="Friction points, timings, surprises from your local run…"
                className="w-full resize-none border-none border-b-[1.5px] border-dp-line bg-transparent py-[6px] text-[16px] leading-[1.55] outline-none focus:border-dp-slate"
              />
            </div>

            <button
              onClick={submitResume}
              disabled={!canResume}
              className={cn(
                "rounded-[9px] border-none px-[18px] py-3 text-[14px] font-medium tracking-[-0.01em] transition-opacity",
                canResume
                  ? "cursor-pointer bg-dp-ink text-dp-paper hover:opacity-[0.88]"
                  : "cursor-not-allowed bg-[#e4e2db] text-dp-faint-3",
              )}
            >
              {resuming ? "Resuming…" : "Resume workflow →"}
            </button>
          </div>
        )}
      </aside>
    </>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <label className="mb-[7px] block text-[11px] uppercase tracking-[0.08em] text-dp-faint-2">
      {children}
    </label>
  );
}
