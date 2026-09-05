/** Bound full Markdown parsing frequency as a reply grows; finalization bypasses this budget. */
export function streamRenderInterval(chars: number): number {
  if (chars >= 100_000) return 400;
  if (chars >= 40_000) return 200;
  if (chars >= 12_000) return 100;
  return 32;
}
