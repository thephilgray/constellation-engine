import { Check, ChevronRight, ListFilter, SquarePen, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useDiffPress } from "./store";
import { Segmented } from "./ui";
import type {
  DiscoveryCard,
  DraftingCard,
  HandoffCard,
  PublishedCard,
  ReviewCard,
  SignalType,
} from "./types";

/** Discovery sub-lanes, in display order. Cards default to TRENDING. */
const DISCOVERY_LANES: { type: SignalType; label: string }[] = [
  { type: "TRENDING", label: "Trending" },
  { type: "RELEASE", label: "New releases" },
  { type: "NEW", label: "New projects" },
];

/** Display backstop: at most this many cards rendered per lane. */
const LANE_RENDER_CAP = 8;

/** Short "why it surfaced" badge for a discovery card. */
function reasonBadge(card: DiscoveryCard): string | null {
  if (card.signalType === "RELEASE" && card.releaseTag) {
    return `released ${card.releaseTag}`;
  }
  if (typeof card.starsGained === "number" && card.starsGained > 0) {
    return `+${card.starsGained.toLocaleString()} ★ / 7d`;
  }
  if (card.signalType === "NEW") return "new project";
  return null;
}

/** 3-tier coverage label from a 0..1 score, or null when unknown. */
function coverageTier(score: number | undefined): string | null {
  if (typeof score !== "number") return null;
  if (score < 0.33) return "Low coverage";
  if (score < 0.66) return "Med coverage";
  return "High coverage";
}

const CARD_BASE =
  "rounded-[12px] bg-dp-card p-[16px_17px] shadow-[0_1px_2px_rgba(26,24,20,0.04)] max-[879px]:min-w-[270px] max-[879px]:[scroll-snap-align:start]";
const META = "font-dp-mono text-[11.5px] text-dp-faint-2";

function ColumnShell({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section className="min-w-0">
      <div className="mb-[14px] flex items-baseline justify-between px-[2px]">
        <span className="text-[11.5px] font-semibold uppercase tracking-[0.09em] text-dp-faint">
          {title}
        </span>
        <span className="font-dp-mono text-[12px] text-dp-faint-3">{count}</span>
      </div>
      <div className="flex gap-3 max-[879px]:flex-row max-[879px]:overflow-x-auto max-[879px]:px-[2px] max-[879px]:pb-2 max-[879px]:[scroll-snap-type:x_mandatory] min-[880px]:flex-col">
        {children}
      </div>
    </section>
  );
}

function RepoName({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-[7px] truncate font-dp-mono text-[13px] font-medium text-dp-ink">
      {children}
    </div>
  );
}

function Desc({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-[14px] break-words text-[14px] leading-[1.5] text-dp-muted">
      {children}
    </p>
  );
}

function DiscoveryArticle({ card }: { card: DiscoveryCard }) {
  const badge = reasonBadge(card);
  const coverage = coverageTier(card.coverageScore);
  const dismissCard = useDiffPress((s) => s.dismissCard);
  return (
    <article className={cn(CARD_BASE, "group relative")}>
      <button
        onClick={() => dismissCard(card.id)}
        aria-label={`Dismiss ${card.repo}`}
        className="absolute right-[10px] top-[10px] hidden cursor-pointer border-none bg-transparent p-1 text-dp-faint-3 hover:text-dp-ink group-hover:block"
      >
        <X size={14} strokeWidth={1.7} />
      </button>
      <RepoName>
        {card.repoUrl ? (
          <a
            href={card.repoUrl}
            target="_blank"
            rel="noreferrer"
            className="hover:underline"
          >
            {card.repo}
          </a>
        ) : (
          card.repo
        )}
      </RepoName>
      <Desc>{card.desc}</Desc>
      <div className={cn("flex flex-wrap items-center gap-x-4 gap-y-1", META)}>
        {badge ? <span className="font-medium text-dp-slate">{badge}</span> : null}
        <span><span aria-hidden="true">★</span> {card.stars.toLocaleString()}</span>
        {card.language ? <span>{card.language}</span> : null}
        {coverage ? <span className="text-dp-slate">{coverage}</span> : null}
      </div>
    </article>
  );
}

function LaneHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="mb-[9px] flex items-baseline justify-between px-[2px]">
      <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-dp-faint-2">
        {label}
      </span>
      <span className="font-dp-mono text-[11px] text-dp-faint-3">{count}</span>
    </div>
  );
}

/** Discovery column split into Trending / New releases / New projects lanes. */
function DiscoveryColumn({ cards }: { cards: DiscoveryCard[] }) {
  const lanes = DISCOVERY_LANES.map((lane) => ({
    ...lane,
    cards: cards
      .filter((c) => (c.signalType ?? "TRENDING") === lane.type)
      .slice(0, LANE_RENDER_CAP),
  }));
  return (
    <section className="min-w-0">
      <div className="mb-[14px] flex items-baseline justify-between px-[2px]">
        <span className="text-[11.5px] font-semibold uppercase tracking-[0.09em] text-dp-faint">
          Discovery
        </span>
        <span className="font-dp-mono text-[12px] text-dp-faint-3">{cards.length}</span>
      </div>
      <div className="flex flex-col gap-6">
        {lanes.map((lane) => (
          <div key={lane.type}>
            <LaneHeader label={lane.label} count={lane.cards.length} />
            <div className="flex flex-col gap-3">
              {lane.cards.length === 0 ? (
                <p className="px-[2px] font-dp-mono text-[11.5px] text-dp-faint-3">
                  Nothing yet
                </p>
              ) : (
                lane.cards.map((c) => <DiscoveryArticle key={c.id} card={c} />)
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function HandoffArticle({ card }: { card: HandoffCard }) {
  const openDrawer = useDiffPress((s) => s.openDrawer);
  return (
    <article
      onClick={() => openDrawer(card.id)}
      className={cn(
        CARD_BASE,
        "cursor-pointer transition-[box-shadow,transform] duration-300 ease-[cubic-bezier(.2,0,0,1)] hover:-translate-y-px hover:shadow-[0_4px_18px_rgba(26,24,20,0.07)]",
      )}
    >
      <div className="mb-[7px] flex items-start justify-between gap-[10px]">
        <div className="min-w-0 truncate font-dp-mono text-[13px] font-medium text-dp-ink">
          {card.repo}
        </div>
        <span className="mt-px flex-[0_0_auto] text-dp-faint-3">
          <ChevronRight size={15} strokeWidth={1.7} />
        </span>
      </div>
      <Desc>{card.desc}</Desc>
      <div className="text-[11.5px] font-medium text-dp-slate">
        Open handoff →
      </div>
    </article>
  );
}

function DraftingArticle({ card }: { card: DraftingCard }) {
  return (
    <article className={CARD_BASE}>
      <RepoName>{card.repo}</RepoName>
      <Desc>{card.desc}</Desc>
      <div className="flex items-center gap-[10px]">
        <span className="flex gap-1" aria-hidden="true">
          {[0, 0.2, 0.4].map((d) => (
            <span
              key={d}
              className="dp-pulse h-[5px] w-[5px] rounded-full bg-dp-slate"
              style={{ animationDelay: `${d}s` }}
            />
          ))}
        </span>
        <span className="font-dp-mono text-[11.5px] text-[#8a877f]">drafting…</span>
      </div>
    </article>
  );
}

function ReviewArticleCard({ card }: { card: ReviewCard }) {
  const openArticle = useDiffPress((s) => s.openArticle);
  if (!card.editable) {
    return (
      <article className={CARD_BASE}>
        <div className="mb-2 text-[15px] font-semibold leading-[1.3] tracking-[-0.015em]">
          {card.title}
        </div>
        <div className="mb-[13px] font-dp-mono text-[11.5px] text-dp-faint-2">
          {card.repo}
        </div>
        <div className="text-[11.5px] text-dp-faint-3">Awaiting editor</div>
      </article>
    );
  }
  return (
    <article
      onClick={() => openArticle(card.id)}
      className={cn(
        CARD_BASE,
        "cursor-pointer transition-[box-shadow,transform] duration-300 ease-[cubic-bezier(.2,0,0,1)] hover:-translate-y-px hover:shadow-[0_4px_18px_rgba(26,24,20,0.07)]",
      )}
    >
      <div className="mb-2 flex items-start justify-between gap-[10px]">
        <div className="text-[15px] font-semibold leading-[1.3] tracking-[-0.015em]">
          {card.title}
        </div>
        <span className="mt-0.5 flex-[0_0_auto] text-dp-faint-3">
          <SquarePen size={15} strokeWidth={1.7} />
        </span>
      </div>
      <div className="mb-[13px] font-dp-mono text-[11.5px] text-dp-faint-2">
        {card.repo}
      </div>
      <div className="text-[11.5px] font-medium text-dp-slate">
        Read article →
      </div>
    </article>
  );
}

/** Display backstop: at most this many published cards. */
const PUBLISHED_RENDER_CAP = 8;

/** Friendly label for a syndication target id (webhook ids stay as-is). */
const TARGET_LABELS: Record<string, string> = {
  devto: "Dev.to",
  linkedin: "LinkedIn",
  substack: "Substack",
};

function PublishedArticleCard({ card }: { card: PublishedCard }) {
  const openArticle = useDiffPress((s) => s.openArticle);
  const when = card.publishedAt
    ? new Date(card.publishedAt).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      })
    : null;
  const targets = card.syndicatedTargets
    .map((id) => TARGET_LABELS[id] ?? "webhook")
    .join(", ");
  return (
    <article
      onClick={() => openArticle(card.id)}
      className={cn(
        CARD_BASE,
        "cursor-pointer transition-[box-shadow,transform] duration-300 ease-[cubic-bezier(.2,0,0,1)] hover:-translate-y-px hover:shadow-[0_4px_18px_rgba(26,24,20,0.07)]",
      )}
    >
      <div className="mb-2 text-[15px] font-semibold leading-[1.3] tracking-[-0.015em]">
        {card.title}
      </div>
      <div className="mb-[13px] font-dp-mono text-[11.5px] text-dp-faint-2">
        {card.repo}
      </div>
      <div className="mb-[10px] flex items-center gap-[6px] text-[11.5px] font-medium text-dp-green">
        <Check size={13} strokeWidth={2} />
        {targets || "Published"}
        {when ? ` · ${when}` : ""}
      </div>
      <div className="text-[11.5px] font-medium text-dp-slate">Add targets →</div>
    </article>
  );
}

function CommandCenter() {
  const engineState = useDiffPress((s) => s.engineState);
  const discoveryMode = useDiffPress((s) => s.discoveryMode);
  const velocity = useDiffPress((s) => s.velocity);
  const setEngineState = useDiffPress((s) => s.setEngineState);
  const setDiscoveryMode = useDiffPress((s) => s.setDiscoveryMode);
  const setVelocity = useDiffPress((s) => s.setVelocity);

  const modeHelp =
    discoveryMode === "frontier"
      ? "Surfaces emerging repos before they trend."
      : discoveryMode === "ecosystem"
        ? "Tracks major v2.0 updates to established projects."
        : "Blends emerging repos with established updates.";

  return (
    <div className="dp-anim-fadeup mb-9 rounded-[16px] bg-white p-[clamp(22px,3vw,30px)] shadow-[0_1px_2px_rgba(26,24,20,0.05)]">
      <div className="mb-[26px] flex items-center gap-[9px] text-[#908d86]">
        <ListFilter size={15} strokeWidth={1.7} />
        <span className="text-[11px] font-semibold uppercase tracking-[0.1em]">
          Pipeline Command Center
        </span>
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-[clamp(24px,3vw,44px)]">
        <div>
          <Label>Engine State</Label>
          <Segmented
            wrap
            value={engineState}
            onChange={setEngineState}
            options={[
              { value: "active", label: "Active" },
              { value: "paused", label: "Paused" },
              { value: "off", label: "Off" },
            ]}
          />
        </div>

        <div>
          <Label>Discovery Mode</Label>
          <Segmented
            wrap
            value={discoveryMode}
            onChange={setDiscoveryMode}
            options={[
              { value: "frontier", label: "Frontier" },
              { value: "balanced", label: "Balanced" },
              { value: "ecosystem", label: "Ecosystem" },
            ]}
          />
          <div className="mt-[11px] text-[12.5px] leading-[1.5] text-[#908d86]">
            {modeHelp}
          </div>
        </div>

        <div>
          <Label>Target Candidates / Week</Label>
          <div className="flex items-center gap-4">
            <input
              type="range"
              min={1}
              max={20}
              value={velocity}
              onChange={(e) => setVelocity(Number(e.target.value))}
              className="h-1 flex-1 accent-dp-slate"
            />
            <span className="min-w-[26px] text-right font-dp-mono text-[16px] font-medium">
              {velocity}
            </span>
          </div>
          <div className="mt-[11px] text-[12.5px] text-[#908d86]">
            repositories entering Discovery weekly
          </div>
        </div>
      </div>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-[13px] text-[11px] uppercase tracking-[0.08em] text-dp-faint-2">
      {children}
    </div>
  );
}

export function Dashboard() {
  const cmdOpen = useDiffPress((s) => s.cmdOpen);
  const pipeline = useDiffPress((s) => s.pipeline);

  return (
    <main className="flex-1 px-[clamp(18px,4vw,48px)] pb-20 pt-[clamp(28px,4vw,52px)]">
      <div className="mx-auto max-w-[1240px]">
        <div className="mb-[clamp(28px,4vw,44px)] max-w-[640px]">
          <h1 className="mb-[10px] text-[clamp(26px,3.4vw,34px)] font-semibold tracking-[-0.025em]">
            Pipeline
          </h1>
          <p className="text-[15.5px] leading-[1.6] text-dp-muted">
            Emerging repositories move left-to-right through the Step Functions
            workflow — from discovery to a finished, critic-edited article.
          </p>
        </div>

        {cmdOpen && <CommandCenter />}

        <div className="flex flex-col gap-[30px] min-[880px]:grid min-[880px]:grid-cols-2 min-[880px]:items-start min-[880px]:gap-x-[clamp(20px,2.4vw,36px)] min-[880px]:gap-y-9 min-[1220px]:grid-cols-5">
          <DiscoveryColumn cards={pipeline.discovery} />
          <ColumnShell title="Ready for Dev" count={pipeline.readyForDev.length}>
            {pipeline.readyForDev.map((c) => (
              <HandoffArticle key={c.id} card={c} />
            ))}
          </ColumnShell>
          <ColumnShell title="Drafting" count={pipeline.drafting.length}>
            {pipeline.drafting.map((c) => (
              <DraftingArticle key={c.id} card={c} />
            ))}
          </ColumnShell>
          <ColumnShell title="In Review" count={pipeline.inReview.length}>
            {pipeline.inReview.map((c) => (
              <ReviewArticleCard key={c.id} card={c} />
            ))}
          </ColumnShell>
          <ColumnShell title="Recently Published" count={pipeline.published.length}>
            {[...pipeline.published]
              .sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""))
              .slice(0, PUBLISHED_RENDER_CAP)
              .map((c) => (
                <PublishedArticleCard key={c.id} card={c} />
              ))}
          </ColumnShell>
        </div>
      </div>
    </main>
  );
}
