import { useCallback, useEffect, useRef, useState } from "react";
import {
  Code,
  Image as ImageIcon,
  Link as LinkIcon,
  Minus,
  Plus,
  Quote as QuoteIcon,
  Type,
  Video,
  WandSparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useIsMobile } from "./hooks";
import { useDiffPress } from "./store";

interface Rect {
  top: number;
  left: number;
}

export function DraftEditor() {
  const articleHtml = useDiffPress((s) => s.articleHtml);
  const saveArticleHtml = useDiffPress((s) => s.saveArticleHtml);
  const isMobile = useIsMobile();

  const proseRef = useRef<HTMLDivElement | null>(null);
  const savedRange = useRef<Range | null>(null);

  const [selBar, setSelBar] = useState<Rect | null>(null);
  const [caretTop, setCaretTop] = useState<number | null>(null);
  const [plusLeft, setPlusLeft] = useState<number | null>(null);
  const [insertOpen, setInsertOpen] = useState(false);

  // ---- DOM helpers ----
  const closestBlock = useCallback((node: Node | null): HTMLElement | null => {
    const el = proseRef.current;
    if (!el || !node) return null;
    let n: Node | null = node;
    while (n && n.parentNode !== el) n = n.parentNode;
    return n && n.nodeType === 1 ? (n as HTMLElement) : null;
  }, []);

  const onSelChange = useCallback(() => {
    const el = proseRef.current;
    if (!el) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) {
      setSelBar(null);
      return;
    }
    const range = sel.getRangeAt(0);
    if (!el.contains(range.commonAncestorContainer)) {
      setSelBar(null);
      return;
    }
    let node: Node = range.startContainer;
    if (node.nodeType === 3) node = node.parentNode as Node;
    const block = closestBlock(node);
    const er = el.getBoundingClientRect();
    if (block) {
      const br = block.getBoundingClientRect();
      setCaretTop(br.top + 3);
      setPlusLeft(er.left);
    }
    if (!sel.isCollapsed) {
      const rr = range.getBoundingClientRect();
      if (rr.width > 1 || rr.height > 1) {
        setSelBar({ top: rr.top - 9, left: rr.left + rr.width / 2 });
        return;
      }
    }
    setSelBar(null);
  }, [closestBlock]);

  // seed the editor once (uncontrolled) + wire selection tracking
  useEffect(() => {
    const el = proseRef.current;
    if (el && el.innerHTML !== articleHtml) el.innerHTML = articleHtml;
    document.addEventListener("selectionchange", onSelChange);
    return () => {
      document.removeEventListener("selectionchange", onSelChange);
      if (proseRef.current) saveArticleHtml(proseRef.current.innerHTML);
    };
    // mount-only: articleHtml is the seed, not a controlled value
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- formatting commands ----
  const exec = useCallback(
    (cmd: string, val?: string) => {
      proseRef.current?.focus();
      try {
        document.execCommand(cmd, false, val);
      } catch {
        /* execCommand is best-effort */
      }
      onSelChange();
    },
    [onSelChange],
  );

  const curBlockTag = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    const b = closestBlock(sel.getRangeAt(0).startContainer);
    return b ? b.tagName : null;
  }, [closestBlock]);

  const doBold = () => exec("bold");
  const doItalic = () => exec("italic");
  const doH2 = () => exec("formatBlock", curBlockTag() === "H2" ? "P" : "H2");
  const doQuote = () =>
    exec("formatBlock", curBlockTag() === "BLOCKQUOTE" ? "P" : "BLOCKQUOTE");
  const doText = () => exec("formatBlock", "P");
  const doLink = () => {
    const u = window.prompt("Link URL", "https://");
    if (u) exec("createLink", u);
  };
  const doCode = () => {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return;
    const txt = sel
      .toString()
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    exec("insertHTML", `<code class="dp-icode">${txt}</code>`);
  };

  // ---- block insertion ----
  const restoreRange = useCallback(() => {
    proseRef.current?.focus();
    if (savedRange.current) {
      const s = window.getSelection();
      s?.removeAllRanges();
      s?.addRange(savedRange.current);
    }
  }, []);

  const openInsert = () => {
    const sel = window.getSelection();
    if (sel && sel.rangeCount) savedRange.current = sel.getRangeAt(0).cloneRange();
    // On mobile, drop the keyboard so the insert panel can take its place.
    if (isMobile) proseRef.current?.blur();
    setInsertOpen(true);
  };
  const closeInsert = () => setInsertOpen(false);

  const insBlock = (html: string) => {
    restoreRange();
    try {
      document.execCommand("insertHTML", false, html);
    } catch {
      /* best-effort */
    }
    setInsertOpen(false);
    onSelChange();
  };
  const formatBlockFromMenu = (tag: string, toggleWith = "P") => {
    restoreRange();
    try {
      document.execCommand(
        "formatBlock",
        false,
        curBlockTag() === tag ? toggleWith : tag,
      );
    } catch {
      /* best-effort */
    }
    setInsertOpen(false);
    onSelChange();
  };
  const embedHTML = (kind: "image" | "video") => {
    const tag = kind === "video" ? "VIDEO" : "IMAGE";
    const hint =
      kind === "video"
        ? "embed video · paste a YouTube, Loom or Vimeo URL"
        : "image · drag a file in or paste a URL";
    const glyph =
      kind === "video"
        ? '<span class="dp-play"></span>'
        : '<span class="dp-imgmark"></span>';
    return (
      `<figure class="dp-embed" data-kind="${kind}" contenteditable="false">` +
      `<div class="dp-embed-media"><span class="dp-embed-ico">${glyph}</span>` +
      `<span class="dp-embed-tag">${tag}</span>` +
      `<span class="dp-embed-hint">${hint}</span></div>` +
      `<figcaption class="dp-cap" contenteditable="true">Add a caption…</figcaption></figure><p><br></p>`
    );
  };

  const insHeading = () => formatBlockFromMenu("H2");
  const insQuote = () => formatBlockFromMenu("BLOCKQUOTE");
  const insText = () => formatBlockFromMenu("P");
  const insCode = () =>
    insBlock('<pre class="dp-code"><code>// your code here</code></pre><p><br></p>');
  const insDivider = () => insBlock('<hr class="dp-hr"><p><br></p>');
  const insImage = () => insBlock(embedHTML("image"));
  const insVideo = () => insBlock(embedHTML("video"));

  // ---- markdown shortcuts ----
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== " ") return;
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    if (!range.collapsed) return;
    let node: Node = range.startContainer;
    if (node.nodeType === 3) node = node.parentNode as Node;
    const block = closestBlock(node);
    if (!block) return;
    const t = block.textContent ?? "";
    let tag: string | null = null;
    if (t === "#" || t === "##") tag = "H2";
    else if (t === "###") tag = "H3";
    else if (t === ">") tag = "BLOCKQUOTE";
    if (!tag) return;
    e.preventDefault();
    const r = document.createRange();
    r.selectNodeContents(block);
    const s2 = window.getSelection();
    s2?.removeAllRanges();
    s2?.addRange(r);
    try {
      document.execCommand("delete");
      document.execCommand("formatBlock", false, tag);
    } catch {
      /* best-effort */
    }
    onSelChange();
  };

  const preventBlur = (e: React.MouseEvent) => e.preventDefault();

  // ---- derived positioning ----
  const showPlus = caretTop != null && !insertOpen && !selBar;
  const gx = isMobile
    ? (plusLeft ?? 0) + 4
    : Math.max((plusLeft ?? 0) - 34, 8);
  const caretY = caretTop ?? 0;

  return (
    <>
      <div className="mb-7 flex items-center gap-[9px] text-[12.5px] leading-[1.5] text-dp-faint-2">
        <span className="flex flex-[0_0_auto] text-dp-faint-3">
          <WandSparkles size={14} strokeWidth={1.7} />
        </span>
        <span>
          Live editor — select text to format, click{" "}
          <strong className="font-semibold text-dp-muted">+</strong> to insert a
          block, or type Markdown (
          <code className="rounded bg-dp-chip px-1 font-dp-mono">## </code>{" "}
          <code className="rounded bg-dp-chip px-1 font-dp-mono">&gt; </code>{" "}
          <code className="rounded bg-dp-chip px-1 font-dp-mono">`</code>).
        </span>
      </div>

      <div
        ref={proseRef}
        data-dp-editable
        contentEditable
        suppressContentEditableWarning
        spellCheck
        onKeyDown={onKeyDown}
        onMouseUp={onSelChange}
        onFocus={onSelChange}
        className="dp-prose min-h-[340px] w-full pb-10 outline-none"
        style={{ paddingLeft: isMobile ? 34 : 0 }}
      />

      {/* caret "+" gutter button */}
      {showPlus && (
        <button
          onClick={openInsert}
          onMouseDown={preventBlur}
          style={{ top: caretY - (isMobile ? 2 : 0), left: gx }}
          className={cn(
            "fixed z-[80] flex items-center justify-center rounded-full border border-dp-line-3 bg-white text-dp-muted shadow-[0_2px_7px_rgba(26,24,20,0.13)] transition-all hover:border-dp-slate hover:bg-dp-slate hover:text-white",
            isMobile ? "h-[30px] w-[30px]" : "h-[26px] w-[26px]",
          )}
        >
          <Plus size={17} strokeWidth={1.9} />
        </button>
      )}

      {/* desktop popover */}
      {insertOpen && !isMobile && (
        <>
          <div onClick={closeInsert} className="fixed inset-0 z-[84]" />
          <div
            style={{ top: caretY + 30, left: gx }}
            className="dp-anim-fadeup fixed z-[85] w-[222px] rounded-[12px] bg-white p-[6px] shadow-[0_14px_44px_rgba(26,24,20,0.17)]"
          >
            <div className="px-[10px] pb-2 pt-[5px] text-[10.5px] uppercase tracking-[0.11em] text-dp-faint-2">
              Insert block
            </div>
            <PopoverItem onClick={insHeading} icon={<LetterH />} label="Heading" />
            <PopoverItem
              onClick={insQuote}
              icon={<QuoteIcon size={15} strokeWidth={1.7} />}
              label="Quote"
            />
            <PopoverItem
              onClick={insCode}
              icon={<Code size={15} strokeWidth={1.8} />}
              label="Code block"
            />
            <PopoverItem
              onClick={insImage}
              icon={<ImageIcon size={15} strokeWidth={1.7} />}
              label="Image"
            />
            <PopoverItem
              onClick={insVideo}
              icon={<Video size={15} strokeWidth={1.7} />}
              label="Video"
            />
            <PopoverItem
              onClick={insDivider}
              icon={<Minus size={15} strokeWidth={1.8} />}
              label="Divider"
            />
          </div>
        </>
      )}

      {/* mobile bottom sheet */}
      {insertOpen && isMobile && (
        <>
          <div
            onClick={closeInsert}
            className="dp-anim-fade fixed inset-0 z-[86] bg-[rgba(26,24,20,0.12)]"
          />
          <div className="dp-anim-sheet fixed inset-x-0 bottom-0 z-[88] rounded-t-[18px] bg-white px-[14px] pb-[calc(16px+env(safe-area-inset-bottom))] pt-2 shadow-[0_-16px_44px_rgba(26,24,20,0.18)]">
            <div className="flex justify-center pb-3 pt-1">
              <span className="h-1 w-[38px] rounded bg-dp-line-3" />
            </div>
            <div className="mx-[2px] mb-3 flex items-center justify-between">
              <span className="text-[11px] uppercase tracking-[0.11em] text-dp-faint-2">
                Insert block
              </span>
              <button
                onMouseDown={preventBlur}
                onClick={closeInsert}
                className="border-none bg-transparent px-[6px] py-1 text-[13px] text-dp-faint"
              >
                Cancel
              </button>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <SheetTile onClick={insText} icon={<Type size={16} strokeWidth={1.8} />} label="Text" />
              <SheetTile onClick={insHeading} icon={<LetterH big />} label="Heading" />
              <SheetTile onClick={insQuote} icon={<QuoteIcon size={16} strokeWidth={1.7} />} label="Quote" />
              <SheetTile onClick={insCode} icon={<Code size={16} strokeWidth={1.8} />} label="Code" />
              <SheetTile onClick={insImage} icon={<ImageIcon size={16} strokeWidth={1.7} />} label="Image" />
              <SheetTile onClick={insVideo} icon={<Video size={16} strokeWidth={1.7} />} label="Video" />
              <SheetTile onClick={insDivider} icon={<Minus size={16} strokeWidth={1.8} />} label="Divider" />
            </div>
          </div>
        </>
      )}

      {/* selection toolbar */}
      {selBar && (
        <div
          style={{ top: selBar.top, left: selBar.left }}
          className="dp-anim-fade fixed z-[90] flex -translate-x-1/2 -translate-y-full items-center gap-px rounded-[11px] bg-[#1f1d1a] p-1 shadow-[0_8px_28px_rgba(20,18,16,0.30)]"
        >
          <SelBtn onClick={doBold} className="text-[14px] font-bold">B</SelBtn>
          <SelBtn onClick={doItalic} className="font-serif text-[15px] italic">i</SelBtn>
          <SelBtn onClick={doCode}><Code size={16} strokeWidth={1.8} /></SelBtn>
          <SelBtn onClick={doLink}><LinkIcon size={15} strokeWidth={1.8} /></SelBtn>
          <span className="mx-1 h-[18px] w-px flex-[0_0_auto] bg-white/[0.16]" />
          <SelBtn onClick={doText} className="text-[12.5px] font-semibold">Text</SelBtn>
          <SelBtn onClick={doH2} className="text-[12.5px] font-semibold">H2</SelBtn>
          <SelBtn onClick={doQuote}><QuoteIcon size={15} strokeWidth={1.7} /></SelBtn>
        </div>
      )}
    </>
  );
}

function LetterH({ big }: { big?: boolean }) {
  return (
    <span className={cn("font-bold", big ? "text-[14px]" : "text-[12.5px]")}>
      H
    </span>
  );
}

function PopoverItem({
  onClick,
  icon,
  label,
}: {
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className="flex w-full cursor-pointer items-center gap-[11px] rounded-lg border-none bg-transparent px-[10px] py-2 text-left text-[14px] text-dp-ink hover:bg-dp-hover"
    >
      <span className="flex h-[26px] w-[26px] flex-[0_0_auto] items-center justify-center rounded-md bg-dp-wash-2 text-dp-muted">
        {icon}
      </span>
      {label}
    </button>
  );
}

function SheetTile({
  onClick,
  icon,
  label,
}: {
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className="flex min-h-[80px] cursor-pointer flex-col items-center justify-center gap-[9px] rounded-[12px] border border-dp-line-2 bg-dp-wash px-[6px] py-3 text-[13px] text-dp-ink active:bg-dp-wash-2"
    >
      <span className="flex h-[30px] w-[30px] items-center justify-center rounded-lg bg-dp-wash-2 text-dp-muted">
        {icon}
      </span>
      {label}
    </button>
  );
}

function SelBtn({
  onClick,
  className,
  children,
}: {
  onClick: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        "flex h-[30px] min-w-[32px] cursor-pointer items-center justify-center rounded-[7px] border-none bg-transparent px-[9px] text-[#e8e6e0] hover:bg-white/[0.14]",
        className,
      )}
    >
      {children}
    </button>
  );
}
