export default function SettingsLoading() {
  return (
    <div className="max-w-md mx-auto pt-2">
      {/* Title skeleton */}
      <div className="h-7 w-28 rounded-lg bg-white/[0.06] animate-pulse mb-6" />
      {/* Profile card skeleton */}
      <div className="rounded-2xl bg-white/[0.04] border border-white/[0.06] p-5 mb-5">
        <div className="flex items-center gap-4 mb-4">
          <div className="h-16 w-16 rounded-full bg-white/[0.08] animate-pulse" />
          <div className="flex-1 space-y-2">
            <div className="h-5 w-32 rounded bg-white/[0.06] animate-pulse" />
            <div className="h-4 w-24 rounded bg-white/[0.06] animate-pulse" />
          </div>
        </div>
        <div className="h-4 w-full rounded bg-white/[0.06] animate-pulse" />
      </div>
      {/* Settings sections skeleton */}
      <div className="space-y-3">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="h-14 w-full rounded-2xl bg-white/[0.04] border border-white/[0.06] animate-pulse" />
        ))}
      </div>
    </div>
  );
}
