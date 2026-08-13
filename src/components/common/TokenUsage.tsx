interface TokenData {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  calls: number;
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export default function TokenUsage({ label, data }: { label: string; data: TokenData | null | undefined }) {
  if (!data || !data.total_tokens) return null;
  return (
    <div className="flex items-center gap-2 text-[11px] text-slate-400 mt-1">
      <span className="font-medium text-slate-500">{label}:</span>
      <span>{fmt(data.total_tokens)} tokens</span>
      <span className="text-slate-300">·</span>
      <span>{fmt(data.prompt_tokens)} in</span>
      <span className="text-slate-300">·</span>
      <span>{fmt(data.completion_tokens)} out</span>
      <span className="text-slate-300">·</span>
      <span>{data.calls} calls</span>
    </div>
  );
}
