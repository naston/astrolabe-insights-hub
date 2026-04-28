import { useState } from "react";
import { Check, Copy } from "lucide-react";

import { shortHash } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Renders a truncated hash that copies the full value to clipboard
 * when clicked.
 *
 * The dashboard truncates Aim run hashes to 7 chars by default
 * (e.g. ``add5015``) for visual density, but operators using
 * ``astrolabe submit --include=<hash>`` need the full 24-char value.
 * Clicking the displayed hash writes the full hash to the clipboard
 * and flips the icon to a checkmark for ~1.5s as confirmation.
 *
 * No native tooltip via ``title=`` — Slack-style highlight markers
 * fight with browser tooltip behavior on hover. The icon swap is
 * the affordance.
 */
export interface CopyableHashProps {
  hash: string;
  /** How many chars of the hash to display (default 7). */
  length?: number;
  className?: string;
}

export function CopyableHash({ hash, length = 7, className }: CopyableHashProps) {
  const [copied, setCopied] = useState(false);

  const onCopy = async (e: React.MouseEvent) => {
    // Stop propagation so a click inside a row doesn't also navigate.
    e.stopPropagation();
    e.preventDefault();
    try {
      await navigator.clipboard.writeText(hash);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // navigator.clipboard requires HTTPS or localhost — silently fail
      // on http://lake1.local rather than throw a console error. The
      // operator can fall back to selecting the visible text manually.
    }
  };

  // Render as a span (not a button) so this can nest inside other
  // interactive elements — the comparison panel wraps each run in a
  // <button> that toggles visibility, and a button-inside-button is
  // invalid HTML that React 19 throws on at render time. The span
  // keeps the click handler and adds role/tabIndex/key handlers so
  // it stays keyboard-accessible.
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.stopPropagation();
      e.preventDefault();
      onCopy(e as unknown as React.MouseEvent);
    }
  };

  return (
    <span
      role="button"
      tabIndex={0}
      onClick={onCopy}
      onKeyDown={onKey}
      title={copied ? "Copied!" : `Click to copy: ${hash}`}
      aria-label={copied ? "Copied" : "Copy full hash"}
      className={cn(
        "inline-flex items-center gap-1 cursor-pointer select-none",
        "hover:text-foreground transition-colors",
        copied && "text-success",
        className,
      )}
    >
      <span>{shortHash(hash, length)}</span>
      {copied ? (
        <Check className="h-3 w-3" aria-hidden />
      ) : (
        <Copy className="h-3 w-3 opacity-40" aria-hidden />
      )}
    </span>
  );
}
