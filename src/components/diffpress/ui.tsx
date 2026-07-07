import { cn } from "@/lib/utils";

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  wrap,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  wrap?: boolean;
}) {
  return (
    <div
      className={cn(
        "inline-flex gap-[2px] rounded-[9px] bg-dp-wash-2 p-[3px]",
        wrap && "flex-wrap",
      )}
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            className={cn(
              "cursor-pointer rounded-[7px] border-none px-[14px] py-[7px] text-[13px] tracking-[-0.01em] transition-all",
              on
                ? "bg-white font-medium text-dp-ink shadow-[0_1px_2px_rgba(26,24,20,0.07)]"
                : "bg-transparent font-[450] text-dp-faint",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function Toggle({
  on,
  onChange,
  label,
  disabled,
}: {
  on: boolean;
  onChange: () => void;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
      className={cn(
        "relative h-[22px] w-[38px] flex-[0_0_auto] rounded-full border-none p-0 transition-colors",
        disabled ? "cursor-default opacity-60" : "cursor-pointer",
        on ? "bg-dp-slate" : "bg-[#dcd9d1]",
      )}
    >
      <span
        className={cn(
          "absolute top-[2.5px] h-[17px] w-[17px] rounded-full bg-white shadow-[0_1px_3px_rgba(26,24,20,0.25)] transition-[left] duration-200 ease-[cubic-bezier(.2,0,0,1)]",
          on ? "left-[18px]" : "left-[2.5px]",
        )}
      />
    </button>
  );
}
