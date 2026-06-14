import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { useDiffPress } from "./store";

function NavLink({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "relative cursor-pointer border-none bg-transparent px-px py-1 text-sm tracking-[-0.01em] transition-opacity hover:opacity-100",
        active
          ? "font-[550] text-dp-ink"
          : "font-[450] text-dp-faint opacity-90",
      )}
    >
      {label}
      {active && (
        <span className="absolute -bottom-[3px] left-0 right-0 h-[1.5px] rounded-sm bg-dp-slate" />
      )}
    </button>
  );
}

function Wordmark() {
  return (
    <div className="flex flex-[0_0_auto] items-center gap-[10px]">
      <div className="flex w-[15px] flex-col gap-[2.5px]">
        <span className="h-[2px] w-[15px] rounded-sm bg-dp-ink" />
        <span className="h-[2px] w-[9px] rounded-sm bg-dp-slate" />
        <span className="h-[2px] w-[13px] rounded-sm bg-[#c9c6bd]" />
      </div>
      <span className="hidden text-[15px] font-semibold tracking-[-0.02em] min-[880px]:inline">
        DiffPress
      </span>
    </div>
  );
}

export function TopBar() {
  const view = useDiffPress((s) => s.view);
  const editorMode = useDiffPress((s) => s.editorMode);
  const engineActive = useDiffPress((s) => s.engineActive);
  const discoveryMode = useDiffPress((s) => s.discoveryMode);
  const cmdOpen = useDiffPress((s) => s.cmdOpen);
  const goDashboard = useDiffPress((s) => s.goDashboard);
  const goEditor = useDiffPress((s) => s.goEditor);
  const setEditorMode = useDiffPress((s) => s.setEditorMode);
  const toggleCmd = useDiffPress((s) => s.toggleCmd);

  const modeName =
    discoveryMode === "frontier"
      ? "Frontier"
      : discoveryMode === "ecosystem"
        ? "Ecosystem"
        : "Balanced";

  return (
    <header className="sticky top-0 z-40 flex h-[62px] items-center gap-[clamp(10px,2.4vw,20px)] bg-dp-paper/80 px-[clamp(16px,4vw,40px)] backdrop-blur-[14px] backdrop-saturate-[1.1]">
      <Wordmark />

      <nav className="flex min-w-0 flex-1 items-center justify-center gap-[clamp(18px,4vw,26px)]">
        <NavLink
          label="Dashboard"
          active={view === "dashboard"}
          onClick={goDashboard}
        />
        <NavLink label="Editor" active={view === "editor"} onClick={goEditor} />
      </nav>

      <div className="flex min-w-0 flex-[0_0_auto] items-center justify-end">
        {view === "dashboard" ? (
          <button
            onClick={toggleCmd}
            className={cn(
              "flex cursor-pointer items-center gap-[9px] rounded-[9px] border-none px-[10px] py-[6px] transition-colors hover:bg-black/[0.045]",
              cmdOpen ? "bg-black/[0.04]" : "bg-transparent",
            )}
          >
            <span
              className={cn(
                "h-[7px] w-[7px] flex-[0_0_auto] rounded-full",
                engineActive
                  ? "dp-pulse bg-dp-green shadow-[0_0_0_3px_rgba(111,143,106,0.16)] [animation-duration:2.6s]"
                  : "bg-dp-faint-4",
              )}
            />
            <span className="hidden whitespace-nowrap text-[12.5px] font-medium text-[#46443f] min-[880px]:inline">
              Pipeline · {engineActive ? "Active" : "Paused"}
            </span>
            <span className="hidden whitespace-nowrap font-dp-mono text-[12.5px] tracking-[-0.01em] text-dp-faint-2 min-[880px]:inline">
              {modeName} Mode
            </span>
            <span
              className={cn(
                "flex text-dp-faint-3 transition-transform",
                cmdOpen && "rotate-180",
              )}
            >
              <ChevronDown size={13} strokeWidth={1.8} />
            </span>
          </button>
        ) : (
          <div className="flex items-center gap-[18px]">
            <NavLink
              label="Draft"
              active={editorMode === "draft"}
              onClick={() => setEditorMode("draft")}
            />
            <NavLink
              label="Review"
              active={editorMode === "review"}
              onClick={() => setEditorMode("review")}
            />
          </div>
        )}
      </div>
    </header>
  );
}
