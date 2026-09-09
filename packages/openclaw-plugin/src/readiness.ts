export async function assertRuntimeCurrentUnlessAborted(
  signal: AbortSignal,
  assertRuntimeCurrent: () => Promise<void>,
): Promise<void> {
  if (signal.aborted) return;
  await assertRuntimeCurrent();
}
