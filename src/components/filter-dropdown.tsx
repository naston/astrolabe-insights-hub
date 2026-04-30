import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ChevronDown } from "lucide-react";

/**
 * Multi-select filter dropdown for the home-page filter shelf.
 *
 * Each filter type (Status, Submitter, Repo) renders one of these. Click
 * the trigger button → popover opens with checkboxes for every available
 * value plus a count of selected items on the trigger so the operator
 * can see at a glance which filters are active.
 *
 * Constant horizontal footprint regardless of cardinality — the chip
 * approach (one chip per active value) wraps and gets noisy when the
 * selection grows.
 */
export interface FilterDropdownProps {
  /** Label shown on the trigger when nothing is selected (e.g. "Repo"). */
  label: string;
  /** All available values; the rendered list is sorted alphabetically. */
  options: { value: string; label: string; count?: number }[];
  /** Currently selected values. Empty array = "any" / no filter. */
  selected: string[];
  /** Called when selection changes. Receives the next selected list. */
  onChange: (next: string[]) => void;
}

export function FilterDropdown({ label, options, selected, onChange }: FilterDropdownProps) {
  const [open, setOpen] = useState(false);

  const sortedOptions = useMemo(
    () => [...options].sort((a, b) => a.label.localeCompare(b.label)),
    [options],
  );

  const triggerText = useMemo(() => {
    if (selected.length === 0) return label;
    if (selected.length === 1) {
      const opt = options.find((o) => o.value === selected[0]);
      return `${label}: ${opt?.label ?? selected[0]}`;
    }
    return `${label} (${selected.length})`;
  }, [label, options, selected]);

  const toggle = (value: string) => {
    if (selected.includes(value)) {
      onChange(selected.filter((v) => v !== value));
    } else {
      onChange([...selected, value]);
    }
  };

  const clear = () => onChange([]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          aria-pressed={selected.length > 0}
          className={selected.length > 0 ? "border-primary text-primary" : ""}
        >
          {triggerText}
          <ChevronDown className="ml-2 h-3 w-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-2">
        <div className="flex items-center justify-between px-1 pb-1">
          <span className="text-xs font-medium text-muted-foreground">{label}</span>
          {selected.length > 0 && (
            <button
              type="button"
              onClick={clear}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Clear
            </button>
          )}
        </div>
        <div className="max-h-72 overflow-y-auto">
          {sortedOptions.length === 0 ? (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">No options yet</div>
          ) : (
            sortedOptions.map((opt) => (
              <label
                key={opt.value}
                className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
              >
                <Checkbox
                  checked={selected.includes(opt.value)}
                  onCheckedChange={() => toggle(opt.value)}
                />
                <span className="flex-1 truncate">{opt.label}</span>
                {opt.count !== undefined && (
                  <span className="text-xs text-muted-foreground">{opt.count}</span>
                )}
              </label>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
