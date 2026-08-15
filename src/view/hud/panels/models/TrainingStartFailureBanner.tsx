export function TrainingStartFailureBanner({ message }: { message: string | null }) {
  if (!message) return null
  return (
    <div
      role="alert"
      className="rounded-md border border-danger/35 bg-danger/10 px-3 py-2 text-[0.75rem] leading-5 text-danger"
    >
      <strong className="block">Training did not start</strong>
      {message}
    </div>
  )
}
