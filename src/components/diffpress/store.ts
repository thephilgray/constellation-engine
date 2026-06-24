import { create } from "zustand";
import { EMPTY_DEPLOY } from "./data";
import { applyAnchor } from "./applyAnchor";
import {
  deployArticle,
  dismissCard as dismissCardApi,
  fetchArticle,
  saveArticle as saveArticleApi,
  fetchCandidates,
  fetchDiscoveryConfig,
  saveDiscoveryConfig,
  publishHandoff,
  regenerateHandoff as regenerateHandoffApi,
  listDrafts as listDraftsApi,
  getDraft as getDraftApi,
  runReview as runReviewApi,
  replyToNote as replyToNoteApi,
  reviseArticle as reviseArticleApi,
} from "./services";
import type {
  DiscoveryMode,
  DraftMeta,
  EngineState,
  HandoffDoc,
  PipelineData,
  ReviewNote,
  SyndicationTargets,
  Timing,
} from "./types";

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

let copyTimer: ReturnType<typeof setTimeout> | null = null;
let revealTimers: ReturnType<typeof setTimeout>[] = [];
let configTimer: ReturnType<typeof setTimeout> | null = null;

/** Fire-and-forget POST of the current Command Center config. */
function persistConfig(get: () => DiffPressState) {
  const { engineState, discoveryMode, velocity } = get();
  saveDiscoveryConfig({ engineState, discoveryMode, velocity }).catch((err) =>
    console.warn("[diffpress] failed to save config:", err),
  );
}

/** Debounced variant for the velocity slider, which fires continuously on drag. */
function persistConfigDebounced(get: () => DiffPressState) {
  if (configTimer) clearTimeout(configTimer);
  configTimer = setTimeout(() => persistConfig(get), 400);
}

/** Pure: drop a card by id from every board column. */
export function removeFromPipeline(
  pipeline: PipelineData,
  repoName: string,
): PipelineData {
  return {
    discovery: pipeline.discovery.filter((c) => c.id !== repoName),
    readyForDev: pipeline.readyForDev.filter((c) => c.id !== repoName),
    drafting: pipeline.drafting.filter((c) => c.id !== repoName),
    inReview: pipeline.inReview.filter((c) => c.id !== repoName),
  };
}

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
  dismissCard: (repoName: string) => Promise<void>;

  // ---- editable article view (real, fetched from + saved to the backend) ----
  articleRepo: string | null;
  articleTitle: string;
  articleMarkdown: string;
  articleLoading: boolean;
  articleSaving: boolean;
  articleSaved: boolean;
  // Bumped on draft-restore so the keyed DraftEditor remounts + re-seeds.
  articleSeed: number;
  drafts: DraftMeta[];
  openArticle: (repoName: string) => Promise<void>;
  setArticleMarkdown: (md: string) => void;
  markArticleDirty: () => void;
  saveArticle: () => Promise<void>;
  loadDrafts: () => Promise<void>;
  restoreDraft: (ts: string) => Promise<void>;

  // ---- command center ----
  cmdOpen: boolean;
  engineState: EngineState;
  discoveryMode: DiscoveryMode;
  velocity: number;
  loadConfig: () => Promise<void>;
  toggleCmd: () => void;
  setEngineState: (state: EngineState) => void;
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
  regenerating: boolean;
  regenerateHandoff: () => Promise<void>;

  // ---- AI Tech Editor (real, API-driven) ----
  notes: ReviewNote[];
  reviewing: boolean;
  revealedNoteIds: string[];
  openNote: string | null;
  resolvedNotes: Record<string, boolean>;
  chat: Record<string, string[]>;
  noteBusy: Record<string, boolean>;
  revising: boolean;
  runReview: () => Promise<void>;
  toggleNote: (id: string) => void;
  applyNote: (id: string) => Promise<void>;
  replyToNote: (id: string, message: string) => Promise<void>;
  reviseArticle: (instruction: string) => Promise<void>;

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

  pipeline: { discovery: [], readyForDev: [], drafting: [], inReview: [] },
  loadPipeline: async () => {
    try {
      const pipeline = await fetchCandidates();
      set({ pipeline });
    } catch (err) {
      // Backend unreachable or not signed in: clear all columns so we never
      // present stale or mock data as real.
      console.warn("[diffpress] failed to load pipeline:", err);
      set({ pipeline: { discovery: [], readyForDev: [], drafting: [], inReview: [] } });
    }
  },
  dismissCard: async (repoName) => {
    // Optimistic: remove immediately, then persist. On failure, reload to resync.
    const prev = get().pipeline;
    set({ pipeline: removeFromPipeline(prev, repoName), drawerId: null });
    try {
      await dismissCardApi(repoName);
    } catch (err) {
      console.warn("[diffpress] dismiss failed; reloading board:", err);
      await get().loadPipeline();
    }
  },

  articleRepo: null,
  articleTitle: "",
  articleMarkdown: "",
  articleLoading: false,
  articleSaving: false,
  articleSaved: false,
  articleSeed: 0,
  drafts: [],
  openArticle: async (repoName) => {
    set({
      view: "editor",
      articleRepo: repoName,
      articleTitle: "",
      articleMarkdown: "",
      articleLoading: true,
      articleSaved: false,
      drafts: [],
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
        void get().loadDrafts();
      }
    } catch (err) {
      console.warn("[diffpress] failed to load article:", err);
      if (get().articleRepo === repoName) set({ articleLoading: false });
    }
  },
  setArticleMarkdown: (md) => set({ articleMarkdown: md, articleSaved: false }),
  markArticleDirty: () => set({ articleSaved: false }),
  saveArticle: async () => {
    const { articleRepo, articleMarkdown, articleSaving } = get();
    if (!articleRepo || articleSaving) return; // in-flight guard (autosave + manual)
    set({ articleSaving: true });
    try {
      await saveArticleApi(articleRepo, articleMarkdown);
      set({ articleSaving: false, articleSaved: true });
      void get().loadDrafts(); // surface the just-written draft
    } catch (err) {
      console.warn("[diffpress] failed to save article:", err);
      set({ articleSaving: false });
    }
  },
  loadDrafts: async () => {
    const repo = get().articleRepo;
    if (!repo) return;
    try {
      const drafts = await listDraftsApi(repo);
      if (get().articleRepo === repo) set({ drafts });
    } catch (err) {
      console.warn("[diffpress] failed to load drafts:", err);
    }
  },
  restoreDraft: async (ts) => {
    const repo = get().articleRepo;
    if (!repo) return;
    try {
      const draft = await getDraftApi(repo, ts);
      if (get().articleRepo !== repo) return;
      set((s) => ({
        articleMarkdown: draft.articleMarkdown,
        articleTitle: draft.title ?? s.articleTitle,
        articleSaved: false,
        articleSeed: s.articleSeed + 1, // remount the editor to re-seed it
      }));
    } catch (err) {
      console.warn("[diffpress] failed to restore draft:", err);
    }
  },

  cmdOpen: false,
  engineState: "active",
  discoveryMode: "frontier",
  velocity: 6,
  loadConfig: async () => {
    try {
      const cfg = await fetchDiscoveryConfig();
      set({
        engineState: cfg.engineState,
        discoveryMode: cfg.discoveryMode,
        velocity: cfg.velocity,
      });
    } catch (err) {
      console.warn("[diffpress] failed to load config:", err);
    }
  },
  toggleCmd: () => set((s) => ({ cmdOpen: !s.cmdOpen })),
  // Setters are optimistic: update local state immediately, persist in the
  // background (velocity debounced so dragging doesn't spam the API).
  setEngineState: (engineState) => {
    set({ engineState });
    persistConfig(get);
  },
  setDiscoveryMode: (discoveryMode) => {
    set({ discoveryMode });
    persistConfig(get);
  },
  setVelocity: (velocity) => {
    set({ velocity });
    persistConfigDebounced(get);
  },

  drawerId: null,
  handoffDoc: null,
  repoUrl: "",
  devLog: "",
  copied: false,
  resuming: false,
  resumed: false,
  regenerating: false,
  openDrawer: async (id) => {
    // The handoff card carries the backend-generated handoffPrompt (from the
    // GenerateHandoff step); legacy records without one fall back to a short
    // client-side prompt synthesized from the repo name.
    const card = get().pipeline.readyForDev.find((c) => c.id === id);
    set({
      drawerId: id,
      handoffDoc: card
        ? {
            id,
            name: card.repo,
            handoff: card.handoffPrompt ?? buildHandoffPrompt(card.repo),
            repoUrl: card.repoUrl,
          }
        : null,
      // Start empty: this field is for the user's *demo-project* URL, not the
      // source repo. Prefilling it with the discovered URL was misleading.
      repoUrl: "",
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
  regenerateHandoff: async () => {
    const { drawerId, handoffDoc } = get();
    if (!drawerId || !handoffDoc) return;
    set({ regenerating: true });
    try {
      const { handoffPrompt } = await regenerateHandoffApi(drawerId);
      // Update the open drawer and the cached card so a reopen shows the new brief.
      set((s) => ({
        regenerating: false,
        handoffDoc: s.handoffDoc ? { ...s.handoffDoc, handoff: handoffPrompt } : null,
        pipeline: {
          ...s.pipeline,
          readyForDev: s.pipeline.readyForDev.map((c) =>
            c.id === drawerId ? { ...c, handoffPrompt } : c,
          ),
        },
      }));
    } catch (err) {
      console.error("[diffpress] regenerate failed:", err);
      set({ regenerating: false });
    }
  },

  notes: [],
  reviewing: false,
  revealedNoteIds: [],
  openNote: null,
  resolvedNotes: {},
  chat: {},
  noteBusy: {},
  revising: false,
  runReview: async () => {
    const { articleRepo, articleMarkdown } = get();
    if (!articleRepo) return;
    revealTimers.forEach(clearTimeout);
    revealTimers = [];
    set({ reviewing: true, notes: [], revealedNoteIds: [], resolvedNotes: {}, chat: {}, openNote: null });
    try {
      const notes = await runReviewApi(articleRepo, articleMarkdown);
      if (get().articleRepo !== articleRepo) return;
      set({ notes, reviewing: false });
      // Reveal notes progressively for the streamed-review feel.
      notes.forEach((n, i) => {
        revealTimers.push(
          setTimeout(
            () => set((s) => ({ revealedNoteIds: [...s.revealedNoteIds, n.id] })),
            350 + i * 500,
          ),
        );
      });
    } catch (err) {
      console.warn("[diffpress] review failed:", err);
      set({ reviewing: false });
    }
  },
  toggleNote: (id) => set((s) => ({ openNote: s.openNote === id ? null : id })),
  applyNote: async (id) => {
    const { notes, articleMarkdown } = get();
    const note = notes.find((n) => n.id === id);
    if (!note) return;
    const { applied, markdown } = applyAnchor(articleMarkdown, note.anchorText, note.replacement);
    if (!applied) return; // anchor not in article — UI disables Apply; this guards
    set((s) => ({
      articleMarkdown: markdown,
      articleSaved: false,
      articleSeed: s.articleSeed + 1, // re-seed the editor with the applied text
      resolvedNotes: { ...s.resolvedNotes, [id]: true },
    }));
    await get().saveArticle();
  },
  replyToNote: async (id, message) => {
    const { notes, chat, articleMarkdown } = get();
    const note = notes.find((n) => n.id === id);
    if (!note || !message.trim()) return;
    const conversation = chat[id] ?? [];
    set((s) => ({
      chat: { ...s.chat, [id]: [...conversation, `you: ${message}`] },
      noteBusy: { ...s.noteBusy, [id]: true },
    }));
    try {
      const { reply, replacement } = await replyToNoteApi({
        articleMarkdown,
        note: note.note,
        conversation,
        message,
      });
      set((s) => ({
        chat: { ...s.chat, [id]: [...(s.chat[id] ?? []), `editor: ${reply}`] },
        noteBusy: { ...s.noteBusy, [id]: false },
        notes: replacement ? s.notes.map((n) => (n.id === id ? { ...n, replacement } : n)) : s.notes,
      }));
    } catch (err) {
      console.warn("[diffpress] reply failed:", err);
      set((s) => ({ noteBusy: { ...s.noteBusy, [id]: false } }));
    }
  },
  reviseArticle: async (instruction) => {
    const { articleRepo, articleMarkdown } = get();
    if (!articleRepo || !instruction.trim()) return;
    set({ revising: true });
    try {
      const article = await reviseArticleApi(articleRepo, articleMarkdown, instruction);
      if (get().articleRepo !== articleRepo) return;
      set((s) => ({
        articleMarkdown: article.articleMarkdown,
        articleTitle: article.title,
        articleSaved: false,
        articleSeed: s.articleSeed + 1,
        revising: false,
      }));
      await get().saveArticle();
    } catch (err) {
      console.warn("[diffpress] revise failed:", err);
      set({ revising: false });
    }
  },

  publishOpen: false,
  targets: { ...EMPTY_DEPLOY.targets },
  timing: EMPTY_DEPLOY.timing,
  scheduleAt: EMPTY_DEPLOY.scheduleAt,
  seriesLink: EMPTY_DEPLOY.seriesLink,
  deploying: false,
  deployed: false,
  deploySummary: "",
  openPublish: () => {
    // Publishable when nothing is outstanding: no review run, or all notes resolved.
    const { notes, resolvedNotes } = get();
    if (notes.every((n) => resolvedNotes[n.id])) {
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

/** Derived selectors over the live review notes. */
export const allNotesResolved = (s: DiffPressState) =>
  s.notes.every((n) => s.resolvedNotes[n.id]);
export const resolvedCount = (s: DiffPressState) =>
  s.notes.filter((n) => s.resolvedNotes[n.id]).length;
