import { useEffect } from "react";
import { Dashboard } from "./Dashboard";
import { Editor } from "./Editor";
import { HandoffDrawer } from "./HandoffDrawer";
import { PublishConsole } from "./PublishConsole";
import { VersionHistoryDrawer } from "./VersionHistoryDrawer";
import { TopBar } from "./TopBar";
import { useDiffPress } from "./store";

export default function DiffPress() {
  const view = useDiffPress((s) => s.view);
  const loadPipeline = useDiffPress((s) => s.loadPipeline);
  const loadConfig = useDiffPress((s) => s.loadConfig);

  useEffect(() => {
    loadPipeline();
    loadConfig();
  }, [loadPipeline, loadConfig]);

  return (
    <div className="dp-root flex min-h-screen flex-col overflow-x-clip bg-dp-paper font-dp-sans text-[15px] leading-[1.5] tracking-[-0.006em] text-dp-ink antialiased">
      <TopBar />
      {view === "dashboard" ? <Dashboard /> : <Editor />}
      <HandoffDrawer />
      <PublishConsole />
      <VersionHistoryDrawer />
    </div>
  );
}
