import { create } from "zustand";
import { ARTICLE_HTML, EMPTY_DEPLOY, PIPELINE, TECH_EDITOR_NOTES } from "./data";
import {
  deployArticle,
  fetchCandidates,
  fetchHandoff,
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
  setEditorMode: (mode) => {
    set({ editorMode: mode });
    if (mode === "review") get().startTechEditor();
  },

  pipeline: structuredClone(PIPELINE),
  loadPipeline: async () => {
    const pipeline = await fetchCandidates();
    set({ pipeline });
  },

  articleHtml: ARTICLE_HTML,
  saveArticleHtml: (articleHtml) => set({ articleHtml }),

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
    set({
      drawerId: id,
      handoffDoc: null,
      repoUrl: "",
      devLog: "",
      copied: false,
      resumed: false,
    });
    const handoffDoc = await fetchHandoff(id);
    // Guard against a race where the user reopened a different drawer.
    if (get().drawerId === id) set({ handoffDoc });
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
    set({ resuming: true });
    await publishHandoff({ id: drawerId, repoUrl, devLog });

    // Move the card from "Ready for Dev" into "Drafting".
    let nextPipeline = pipeline;
    if (pipeline) {
      const card = pipeline.readyForDev.find((c) => c.id === drawerId);
      if (card) {
        nextPipeline = {
          ...pipeline,
          readyForDev: pipeline.readyForDev.filter((c) => c.id !== drawerId),
          drafting: [
            ...pipeline.drafting,
            {
              id: card.id,
              repo: card.repo,
              desc: "Synthesizing the State-of-the-Art draft.",
              stage: "model pass 1 / 3",
              progress: 0.12,
            },
          ],
        };
      }
    }
    set({ resuming: false, resumed: true, pipeline: nextPipeline ?? pipeline });
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
