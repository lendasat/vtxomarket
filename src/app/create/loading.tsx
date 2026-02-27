export default function CreateLoading() {
  return (
    <div className="max-w-md mx-auto pt-2">
      {/* Title skeleton */}
      <div className="h-7 w-40 rounded-lg bg-white/[0.06] animate-pulse mb-6" />
      {/* Form fields skeleton */}
      <div className="space-y-4">
        <div>
          <div className="h-4 w-16 rounded bg-white/[0.06] animate-pulse mb-2" />
          <div className="h-11 w-full rounded-xl bg-white/[0.06] animate-pulse" />
        </div>
        <div>
          <div className="h-4 w-16 rounded bg-white/[0.06] animate-pulse mb-2" />
          <div className="h-11 w-full rounded-xl bg-white/[0.06] animate-pulse" />
        </div>
        <div>
          <div className="h-4 w-24 rounded bg-white/[0.06] animate-pulse mb-2" />
          <div className="h-24 w-full rounded-xl bg-white/[0.06] animate-pulse" />
        </div>
        {/* Image upload skeleton */}
        <div className="h-40 w-full rounded-2xl bg-white/[0.04] border border-dashed border-white/[0.1] animate-pulse" />
        {/* Submit button skeleton */}
        <div className="h-11 w-full rounded-xl bg-white/[0.06] animate-pulse mt-4" />
      </div>
    </div>
  );
}
