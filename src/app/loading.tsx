export default function HomeLoading() {
  return (
    <div className="max-w-2xl mx-auto pt-2">
      {/* Header skeleton */}
      <div className="flex items-center justify-between mb-6">
        <div className="h-7 w-32 rounded-lg bg-white/[0.06] animate-pulse" />
        <div className="h-9 w-24 rounded-xl bg-white/[0.06] animate-pulse" />
      </div>
      {/* Search skeleton */}
      <div className="h-11 w-full rounded-xl bg-white/[0.06] animate-pulse mb-5" />
      {/* Sort tabs skeleton */}
      <div className="flex gap-2 mb-5">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="h-8 w-20 rounded-full bg-white/[0.06] animate-pulse" />
        ))}
      </div>
      {/* Token cards skeleton */}
      <div className="space-y-3">
        {[1, 2, 3, 4, 5].map((i) => (
          <div
            key={i}
            className="h-20 w-full rounded-2xl bg-white/[0.04] border border-white/[0.06] animate-pulse"
          />
        ))}
      </div>
    </div>
  );
}
