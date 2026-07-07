import { useState } from "react";
import { Check, Globe, Linkedin, Mail, SquareCode, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useIsMobile } from "./hooks";
import { useDiffPress } from "./store";
import { Segmented, Toggle } from "./ui";

const TARGETS: {
  id: "devto" | "linkedin" | "substack";
  name: string;
  desc: string;
  icon: React.ReactNode;
}[] = [
  {
    id: "devto",
    name: "Dev.to",
    desc: "Developer community cross-post",
    icon: <SquareCode size={19} strokeWidth={1.7} />,
  },
  {
    id: "linkedin",
    name: "LinkedIn",
    desc: "Professional network article",
    icon: <Linkedin size={19} strokeWidth={1.7} />,
  },
  {
    id: "substack",
    name: "Substack",
    desc: "Newsletter to subscribers",
    icon: <Mail size={19} strokeWidth={1.7} />,
  },
];

export function PublishConsole() {
  const isMobile = useIsMobile();
  const publishOpen = useDiffPress((s) => s.publishOpen);
  const deployed = useDiffPress((s) => s.deployed);
  const deploying = useDiffPress((s) => s.deploying);
  const deploySummary = useDiffPress((s) => s.deploySummary);
  const deployResults = useDiffPress((s) => s.deployResults);
  const targets = useDiffPress((s) => s.targets);
  const timing = useDiffPress((s) => s.timing);
  const scheduleAt = useDiffPress((s) => s.scheduleAt);
  const seriesLink = useDiffPress((s) => s.seriesLink);
  const closePublish = useDiffPress((s) => s.closePublish);
  const toggleTarget = useDiffPress((s) => s.toggleTarget);
  const setTiming = useDiffPress((s) => s.setTiming);
  const setScheduleAt = useDiffPress((s) => s.setScheduleAt);
  const setSeriesLink = useDiffPress((s) => s.setSeriesLink);
  const tags = useDiffPress((s) => s.tags);
  const addTag = useDiffPress((s) => s.addTag);
  const removeTag = useDiffPress((s) => s.removeTag);
  const deploy = useDiffPress((s) => s.deploy);
  const backToDashboard = useDiffPress((s) => s.backToDashboard);
  const webhooks = useDiffPress((s) => s.webhooks);
  const enabledWebhooks = useDiffPress((s) => s.targets.webhooks);
  const syndicated = useDiffPress((s) => s.articleSyndicatedTargets);
  const toggleWebhook = useDiffPress((s) => s.toggleWebhook);
  const saveWebhook = useDiffPress((s) => s.saveWebhook);
  const deleteWebhook = useDiffPress((s) => s.deleteWebhook);
  const testWebhook = useDiffPress((s) => s.testWebhook);
  const [tagDraft, setTagDraft] = useState("");
  const [editor, setEditor] = useState<{ id?: string; name: string; url: string; secret: string } | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; status: number } | null>(null);

  if (!publishOpen) return null;
  const anyTarget = targets.devto || targets.linkedin || targets.substack || targets.webhooks.length > 0;

  const shell = isMobile
    ? "dp-anim-sheet fixed inset-x-0 bottom-0 z-[71] max-h-[92vh] overflow-y-auto rounded-t-[22px] bg-white p-[22px_20px_28px] shadow-[0_-20px_60px_rgba(26,24,20,0.2)]"
    : "dp-anim-fadeup fixed left-1/2 top-1/2 z-[71] max-h-[88vh] w-[min(520px,calc(100vw-40px))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-[18px] bg-white p-[30px] shadow-[0_30px_90px_rgba(26,24,20,0.22)]";

  return (
    <>
      <div
        onClick={closePublish}
        className="dp-anim-fade fixed inset-0 z-[70] bg-[rgba(20,18,16,0.18)] backdrop-blur-[2px]"
      />
      <div className={shell}>
        {deployed ? (
          <div className="dp-anim-fadeup px-[6px] pb-[6px] pt-[18px] text-center">
            <div className="mx-auto mb-5 flex h-[52px] w-[52px] items-center justify-center rounded-full bg-[rgba(111,143,106,0.14)]">
              <Check size={26} strokeWidth={2} className="text-dp-green" />
            </div>
            <div className="mb-[10px] text-[20px] font-semibold tracking-[-0.02em]">
              Article deployed
            </div>
            {deployResults.length ? (
              <ul className="mx-auto mb-6 block w-fit text-left text-[14px] leading-[1.8] text-dp-muted">
                {deployResults.map((r) => (
                  <li key={r.id}>
                    <span className={r.ok ? "text-dp-green" : "text-red-500"}>
                      {r.ok ? "✓" : "✗"}
                    </span>{" "}
                    {r.id}
                    {r.ok ? "" : ` — ${r.detail}`}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mb-6 text-[14px] leading-[1.6] text-dp-muted">{deploySummary}</p>
            )}
            <button
              onClick={backToDashboard}
              className="cursor-pointer rounded-[9px] border-none bg-dp-ink px-[22px] py-[11px] text-[14px] font-medium text-dp-paper hover:opacity-[0.88]"
            >
              Back to pipeline
            </button>
          </div>
        ) : (
          <div>
            <div className="mb-7 flex items-start justify-between gap-4">
              <div>
                <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-dp-faint">
                  Syndication &amp; Deploy
                </div>
                <div className="text-[19px] font-semibold tracking-[-0.02em]">
                  State of the Art: Helix
                </div>
              </div>
              <button
                onClick={closePublish}
                className="-mr-1 -mt-1 flex cursor-pointer border-none bg-transparent p-1 text-dp-faint hover:text-dp-ink"
              >
                <X size={19} strokeWidth={1.7} />
              </button>
            </div>

            <SectionLabel>Syndication targets</SectionLabel>
            <div className="mb-7">
              {TARGETS.map((t) => {
                const done = syndicated.includes(t.id);
                return (
                  <div key={t.id} className="flex items-center gap-[14px] py-3">
                    <span className="flex flex-[0_0_auto] text-[#8a877f]">
                      {t.icon}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[14.5px] font-medium">{t.name}</div>
                      <div className="text-[12px] text-dp-faint-2">{t.desc}</div>
                    </div>
                    {done && (
                      <span className="flex items-center gap-1 text-[11.5px] font-medium text-dp-green">
                        <Check size={13} strokeWidth={2} /> Published
                      </span>
                    )}
                    <Toggle
                      on={targets[t.id]}
                      onChange={() => toggleTarget(t.id)}
                      label={t.name}
                      disabled={done}
                    />
                  </div>
                );
              })}
            </div>

            <SectionLabel>Signed webhooks</SectionLabel>
            <div className="mb-3">
              {webhooks.map((w) => (
                <div key={w.id} className="flex items-center gap-[14px] py-3">
                  <span className="flex flex-[0_0_auto] text-[#8a877f]"><Globe size={19} strokeWidth={1.7} /></span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[14.5px] font-medium">{w.name}</div>
                    <div className="truncate text-[12px] text-dp-faint-2">{w.url}</div>
                  </div>
                  <button
                    onClick={() => { setEditor({ id: w.id, name: w.name, url: w.url, secret: "" }); setTestResult(null); }}
                    className="cursor-pointer border-none bg-transparent p-1 text-[12px] text-dp-faint hover:text-dp-ink"
                  >Edit</button>
                  <button
                    onClick={() => deleteWebhook(w.id)}
                    aria-label={`Delete ${w.name}`}
                    className="cursor-pointer border-none bg-transparent p-1 text-dp-faint hover:text-red-500"
                  ><X size={16} strokeWidth={1.8} /></button>
                  {syndicated.includes(w.id) && (
                    <span className="flex items-center gap-1 text-[11.5px] font-medium text-dp-green"><Check size={13} strokeWidth={2} /> Published</span>
                  )}
                  <Toggle on={enabledWebhooks.includes(w.id)} onChange={() => toggleWebhook(w.id)} label={w.name} disabled={syndicated.includes(w.id)} />
                </div>
              ))}
            </div>

            {editor ? (
              <div className="mb-7 rounded-[10px] bg-[#f6f5f1] p-[14px]">
                <input
                  value={editor.name}
                  onChange={(e) => setEditor({ ...editor, name: e.target.value })}
                  placeholder="Name (e.g. diffpress.com)"
                  className="mb-2 w-full border-none border-b-[1.5px] border-dp-line bg-transparent py-[6px] font-dp-mono text-[14px] outline-none"
                />
                <input
                  value={editor.url}
                  onChange={(e) => setEditor({ ...editor, url: e.target.value })}
                  placeholder="https://example.com/webhook"
                  className="mb-2 w-full border-none border-b-[1.5px] border-dp-line bg-transparent py-[6px] font-dp-mono text-[14px] outline-none"
                />
                <div className="mb-3 flex items-center gap-2">
                  <input
                    value={editor.secret}
                    onChange={(e) => setEditor({ ...editor, secret: e.target.value })}
                    placeholder={editor.id ? "Secret (blank = keep current)" : "Signing secret"}
                    className="flex-1 border-none border-b-[1.5px] border-dp-line bg-transparent py-[6px] font-dp-mono text-[14px] outline-none"
                  />
                  <button
                    onClick={() => setEditor({ ...editor, secret: Array.from(crypto.getRandomValues(new Uint8Array(32))).map((b) => b.toString(16).padStart(2, "0")).join("") })}
                    className="cursor-pointer rounded-[7px] border-none bg-[#e4e2db] px-[10px] py-[6px] text-[12px] hover:opacity-90"
                  >Generate</button>
                </div>
                <div className="flex items-center gap-3">
                  <button
                    onClick={async () => {
                      await saveWebhook({ id: editor.id, name: editor.name, url: editor.url, secret: editor.secret || undefined });
                      setEditor(null); setTestResult(null);
                    }}
                    className="cursor-pointer rounded-[8px] border-none bg-dp-ink px-[14px] py-[8px] text-[13px] font-medium text-dp-paper hover:opacity-90"
                  >Save</button>
                  <button
                    onClick={async () => setTestResult(await testWebhook({ id: editor.id, url: editor.url, secret: editor.secret || undefined }))}
                    className="cursor-pointer rounded-[8px] border-none bg-[#e4e2db] px-[14px] py-[8px] text-[13px] hover:opacity-90"
                  >Test</button>
                  {testResult && (
                    <span className={cn("text-[12px]", testResult.ok ? "text-dp-green" : "text-red-500")}>
                      {testResult.ok ? `✓ ${testResult.status}` : `✗ ${testResult.status || "failed"}`}
                    </span>
                  )}
                  <button onClick={() => { setEditor(null); setTestResult(null); }} className="ml-auto cursor-pointer border-none bg-transparent text-[12px] text-dp-faint hover:text-dp-ink">Cancel</button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => { setEditor({ name: "", url: "", secret: "" }); setTestResult(null); }}
                className="mb-7 cursor-pointer rounded-[8px] border-[1.5px] border-dashed border-dp-line bg-transparent px-[14px] py-[10px] text-[13px] text-dp-faint hover:text-dp-ink"
              >+ Add webhook</button>
            )}

            {targets.devto && (
              <>
                <SectionLabel>
                  Tags{" "}
                  <span className="normal-case tracking-normal text-[#c2c0b8]">
                    — up to 4, for Dev.to
                  </span>
                </SectionLabel>
                <div className="mb-7 flex flex-wrap items-center gap-[7px]">
                  {tags.map((tag, i) => (
                    <span
                      key={tag}
                      className="flex items-center gap-[5px] rounded-[7px] bg-[#eef0f4] py-1 pl-[9px] pr-[6px] font-dp-mono text-[12.5px] text-[#3a3f4d]"
                    >
                      {tag}
                      <button
                        onClick={() => removeTag(i)}
                        aria-label={`Remove ${tag}`}
                        className="flex cursor-pointer border-none bg-transparent p-0 text-[#9aa0b0] hover:text-[#3a3f4d]"
                      >
                        <X size={12} strokeWidth={2} />
                      </button>
                    </span>
                  ))}
                  {tags.length < 4 && (
                    <input
                      value={tagDraft}
                      onChange={(e) => setTagDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          addTag(tagDraft);
                          setTagDraft("");
                        }
                      }}
                      onBlur={() => {
                        if (tagDraft.trim()) {
                          addTag(tagDraft);
                          setTagDraft("");
                        }
                      }}
                      placeholder="add tag…"
                      className="min-w-[80px] flex-[1_1_80px] border-none bg-transparent py-1 font-dp-mono text-[14px] text-dp-ink outline-none"
                    />
                  )}
                </div>
              </>
            )}

            <SectionLabel>Timing</SectionLabel>
            <Segmented
              value={timing}
              onChange={setTiming}
              options={[
                { value: "now", label: "Publish now" },
                { value: "schedule", label: "Schedule" },
              ]}
            />
            {timing === "schedule" && (
              <div className="mt-[14px]">
                <input
                  type="datetime-local"
                  value={scheduleAt}
                  onChange={(e) => setScheduleAt(e.target.value)}
                  className="w-full border-none border-b-[1.5px] border-dp-line bg-transparent py-[7px] font-dp-mono text-[16px] text-dp-ink outline-none focus:border-dp-slate"
                />
              </div>
            )}

            <SectionLabel className="mt-6">
              Series link{" "}
              <span className="normal-case tracking-normal text-[#c2c0b8]">
                — optional
              </span>
            </SectionLabel>
            <input
              value={seriesLink}
              onChange={(e) => setSeriesLink(e.target.value)}
              placeholder="Link a previous part or migration update…"
              className="mb-8 w-full border-none border-b-[1.5px] border-dp-line bg-transparent py-[7px] font-dp-mono text-[16px] outline-none focus:border-dp-slate"
            />

            <button
              onClick={deploy}
              disabled={!anyTarget || deploying}
              className={cn(
                "mt-1 w-full rounded-[10px] border-none p-[13px] text-[14.5px] font-medium tracking-[-0.01em] transition-opacity",
                anyTarget
                  ? "cursor-pointer bg-dp-ink text-dp-paper hover:opacity-90"
                  : "cursor-not-allowed bg-[#e4e2db] text-dp-faint-3",
              )}
            >
              {deploying ? "Deploying…" : "Deploy article →"}
            </button>
          </div>
        )}
      </div>
    </>
  );
}

function SectionLabel({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "mb-[10px] text-[11px] uppercase tracking-[0.08em] text-dp-faint-2",
        className,
      )}
    >
      {children}
    </div>
  );
}
