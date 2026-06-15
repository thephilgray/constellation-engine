import { create } from "zustand";
import { ARTICLE_HTML, EMPTY_DEPLOY, PIPELINE, TECH_EDITOR_NOTES } from "./data";
import {
  deployArticle,
  fetchArticle,
  fetchCandidates,
  publishHandoff,
  triggerTechEditor,
} from "./services";
import type {
  DiscoveryMode,
  HandoffDoc,
  PipelineData,
  SyndicationTargets,
  Timing,
} from "./types";

const NOTE_IDS = TECH_EDITOR_NOTES.map((n) => n.id);

/** Client-side handoff prompt (the backend doesn't generate one). */
const buildHandoffPrompt = (repo: string) =>
  `# Handoff — ${repo}

Clone the repository and run it locally as a critical reviewer.

## What to capture
- Cold start: clean clone → first successful run
- Friction points, surprises, and rough edges in the DX
- Timings worth quoting in the write-up

## Deliverable
Paste the GitHub URL and your developer log below, then resume the
workflow to draft the article.`;

// Stream cancel handle kept outside the store — it's a side-effect handle, not
// reactive state.
let stopStream: (() => void) | null = null;
let copyTimer: ReturnType<typeof setTimeout> | null = null;

interface DiffPressState {
  // ---- navigation ----
  view: "dashboard" | "editor";
  editorMode: "draft" | "review";
  goDashboard: () => void;
  goEditor: () => void;
  setEditorMode: (mode: "draft" | "review") => void;

  // ---- pipeline board ----
  pipeline: PipelineData;
  loadPipeline: () => Promise<void>;

  // ---- live draft (uncontrolled contentEditable, persisted across modes) ----
  articleHtml: string;
  saveArticleHtml: (html: string) => void;

  // ---- read-only article view (real, fetched from the backend) ----
  articleRepo: string | null;
  articleTitle: string;
  articleMarkdown: string;
  articleLoading: boolean;
  openArticle: (repoName: string) => Promise<void>;

  // ---- command center ----
  cmdOpen: boolean;
  engineActive: boolean;
  discoveryMode: DiscoveryMode;
  velocity: number;
  toggleCmd: () => void;
  setEngineActive: (active: boolean) => void;
  setDiscoveryMode: (mode: DiscoveryMode) => void;
  setVelocity: (v: number) => void;

  // ---- handoff drawer ----
  drawerId: string | null;
  handoffDoc: HandoffDoc | null;
  repoUrl: string;
  devLog: string;
  copied: boolean;
  resuming: boolean;
  resumed: boolean;
  openDrawer: (id: string) => Promise<void>;
  closeDrawer: () => void;
  setRepoUrl: (v: string) => void;
  setDevLog: (v: string) => void;
  copyHandoff: () => void;
  submitResume: () => Promise<void>;

  // ---- marginalia (AI Tech Editor, streamed) ----
  streaming: boolean;
  streamedNoteIds: string[];
  openNote: string | null;
  resolvedNotes: Record<string, boolean>;
  chat: Record<string, string[]>;
  startTechEditor: () => void;
  stopTechEditor: () => void;
  toggleNote: (id: string) => void;
  resolveNote: (id: string) => void;
  pushChat: (id: string, msg: string) => void;

  // ---- publish console ----
  publishOpen: boolean;
  targets: SyndicationTargets;
  timing: Timing;
  scheduleAt: string;
  seriesLink: string;
  deploying: boolean;
  deployed: boolean;
  deploySummary: string;
  openPublish: () => void;
  closePublish: () => void;
  toggleTarget: (id: keyof SyndicationTargets) => void;
  setTiming: (t: Timing) => void;
  setScheduleAt: (v: string) => void;
  setSeriesLink: (v: string) => void;
  deploy: () => Promise<void>;
  backToDashboard: () => void;
}

export const useDiffPress = create<DiffPressState>((set, get) => ({
  view: "dashboard",
  editorMode: "draft",
  goDashboard: () => set({ view: "dashboard" }),
  goEditor: () => set({ view: "editor" }),
  // Review mode (AI Tech Editor) is disabled — no backend. Kept as a no-op so
  // the navigation type stays stable.
  setEditorMode: (mode) => set({ editorMode: mode }),

  pipeline: structuredClone(PIPELINE),
  loadPipeline: async () => {
    try {
      const pipeline = await fetchCandidates();
      set({ pipeline });
    } catch (err) {
      // Backend unreachable or not signed in: keep the board usable, drop the
      // two real columns so we don't present mock handoffs as real.
      console.warn("[diffpress] failed to load pipeline:", err);
      set((s) => ({ pipeline: { ...s.pipeline, readyForDev: [], inReview: [] } }));
    }
  },

  articleHtml: ARTICLE_HTML,
  saveArticleHtml: (articleHtml) => set({ articleHtml }),

  articleRepo: null,
  articleTitle: "",
  articleMarkdown: "",
  articleLoading: false,
  openArticle: async (repoName) => {
    set({
      view: "editor",
      articleRepo: repoName,
      articleTitle: "",
      articleMarkdown: "",
      articleLoading: true,
    });
    try {
      const article = await fetchArticle(repoName);
      // Guard against a race where the user opened a different article.
      if (get().articleRepo === repoName) {
        set({
          articleTitle: article.title,
          articleMarkdown: article.articleMarkdown,
          articleLoading: false,
        });
      }
    } catch (err) {
      console.warn("[diffpress] failed to load article:", err);
      if (get().articleRepo === repoName) set({ articleLoading: false });
    }
  },

  cmdOpen: false,
  engineActive: true,
  discoveryMode: "frontier",
  velocity: 6,
  toggleCmd: () => set((s) => ({ cmdOpen: !s.cmdOpen })),
  setEngineActive: (engineActive) => set({ engineActive }),
  setDiscoveryMode: (discoveryMode) => set({ discoveryMode }),
  setVelocity: (velocity) => set({ velocity }),

  drawerId: null,
  handoffDoc: null,
  repoUrl: "",
  devLog: "",
  copied: false,
  resuming: false,
  resumed: false,
  openDrawer: async (id) => {
    // The handoff card already carries everything the drawer needs (repo name +
    // discovered URL); there is no separate backend handoff-prompt generator, so
    // we synthesize a short prompt client-side.
    const card = get().pipeline.readyForDev.find((c) => c.id === id);
    set({
      drawerId: id,
      handoffDoc: card
        ? { id, name: card.repo, handoff: buildHandoffPrompt(card.repo) }
        : null,
      repoUrl: card?.repoUrl ?? "",
      devLog: "",
      copied: false,
      resumed: false,
    });
  },
  closeDrawer: () => set({ drawerId: null }),
  setRepoUrl: (repoUrl) => set({ repoUrl }),
  setDevLog: (devLog) => set({ devLog }),
  copyHandoff: () => {
    const doc = get().handoffDoc;
    if (doc && navigator.clipboard) {
      navigator.clipboard.writeText(doc.handoff).catch(() => {});
    }
    set({ copied: true });
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => set({ copied: false }), 1600);
  },
  submitResume: async () => {
    const { repoUrl, devLog, drawerId, pipeline } = get();
    if (!repoUrl.trim() || !drawerId) return;
    const card = pipeline.readyForDev.find((c) => c.id === drawerId);
    if (!card?.taskToken) {
      console.warn("[diffpress] cannot resume: no task token for", drawerId);
      return;
    }
    set({ resuming: true });
    try {
      await publishHandoff({ taskToken: card.taskToken, repoUrl, devLog });
    } catch (err) {
      console.error("[diffpress] resume failed:", err);
      set({ resuming: false });
      return;
    }
    // The workflow now drafts and publishes asynchronously. Optimistically drop
    // the card from Ready-for-Dev; it reappears in In-Review on the next load.
    set({
      resuming: false,
      resumed: true,
      pipeline: {
        ...pipeline,
        readyForDev: pipeline.readyForDev.filter((c) => c.id !== drawerId),
      },
    });
  },

  streaming: false,
  streamedNoteIds: [],
  openNote: null,
  resolvedNotes: {},
  chat: {},
  startTechEditor: () => {
    // Only stream once per session; re-entering Review keeps the notes.
    if (get().streaming || get().streamedNoteIds.length) return;
    set({ streaming: true, streamedNoteIds: [] });
    stopStream = triggerTechEditor("helix-article", {
      onNote: (note) =>
        set((s) => ({ streamedNoteIds: [...s.streamedNoteIds, note.id] })),
      onDone: () => set({ streaming: false }),
      onError: () => set({ streaming: false }),
    });
  },
  stopTechEditor: () => {
    if (stopStream) stopStream();
    stopStream = null;
    set({ streaming: false });
  },
  toggleNote: (id) =>
    set((s) => ({ openNote: s.openNote === id ? null : id })),
  resolveNote: (id) =>
    set((s) => ({
      resolvedNotes: { ...s.resolvedNotes, [id]: !s.resolvedNotes[id] },
    })),
  pushChat: (id, msg) =>
    set((s) => ({ chat: { ...s.chat, [id]: [...(s.chat[id] ?? []), msg] } })),

  publishOpen: false,
  targets: { ...EMPTY_DEPLOY.targets },
  timing: EMPTY_DEPLOY.timing,
  scheduleAt: EMPTY_DEPLOY.scheduleAt,
  seriesLink: EMPTY_DEPLOY.seriesLink,
  deploying: false,
  deployed: false,
  deploySummary: "",
  openPublish: () => {
    if (NOTE_IDS.every((id) => get().resolvedNotes[id])) {
      set({ publishOpen: true, deployed: false });
    }
  },
  closePublish: () => set({ publishOpen: false }),
  toggleTarget: (id) =>
    set((s) => ({ targets: { ...s.targets, [id]: !s.targets[id] } })),
  setTiming: (timing) => set({ timing }),
  setScheduleAt: (scheduleAt) => set({ scheduleAt }),
  setSeriesLink: (seriesLink) => set({ seriesLink }),
  deploy: async () => {
    const { targets, timing, scheduleAt, seriesLink } = get();
    if (!Object.values(targets).some(Boolean)) return;
    set({ deploying: true });
    const res = await deployArticle({
      articleId: "helix-article",
      targets,
      timing,
      scheduleAt,
      seriesLink,
    });
    set({ deploying: false, deployed: true, deploySummary: res.summary });
  },
  backToDashboard: () =>
    set({ publishOpen: false, view: "dashboard" }),
}));

/** Derived selectors. */
export const allNotesResolved = (s: DiffPressState) =>
  NOTE_IDS.every((id) => s.resolvedNotes[id]);
export const resolvedCount = (s: DiffPressState) =>
  NOTE_IDS.filter((id) => s.resolvedNotes[id]).length;
export const TOTAL_NOTES = NOTE_IDS.length;
