export default function WalletLoading() {
  return (
    <div className="max-w-md mx-auto pt-2">
      {/* Balance skeleton */}
      <div className="flex flex-col items-center gap-3 mb-8">
        <div className="h-5 w-20 rounded-md bg-white/[0.06] animate-pulse" />
        <div className="h-12 w-48 rounded-lg bg-white/[0.06] animate-pulse" />
        <div className="h-4 w-28 rounded-md bg-white/[0.06] animate-pulse" />
      </div>
      {/* Action buttons skeleton */}
      <div className="flex justify-center gap-4 mb-8">
        <div className="h-11 w-28 rounded-xl bg-white/[0.06] animate-pulse" />
        <div className="h-11 w-28 rounded-xl bg-white/[0.06] animate-pulse" />
      </div>
      {/* Tab bar skeleton */}
      <div className="flex gap-2 mb-5">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-8 w-20 rounded-full bg-white/[0.06] animate-pulse" />
        ))}
      </div>
      {/* Content skeleton */}
      <div className="space-y-3">
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            className="h-16 w-full rounded-2xl bg-white/[0.04] border border-white/[0.06] animate-pulse"
          />
        ))}
      </div>
    </div>
  );
}
