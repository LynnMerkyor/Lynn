let pipeHandlerInstalled = false;

export function installPipeErrorHandler(): void {
  if (pipeHandlerInstalled) return;
  pipeHandlerInstalled = true;

  const isBrokenPipe = (error: unknown): boolean => {
    return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "EPIPE";
  };

  const handlePipeError = (error: NodeJS.ErrnoException): void => {
    if (isBrokenPipe(error)) {
      process.exit(0);
    }
    throw error;
  };

  process.stdout.on("error", handlePipeError);
  process.stderr.on("error", handlePipeError);
  process.on("uncaughtException", (error) => {
    if (isBrokenPipe(error)) {
      process.exit(0);
    }
    throw error;
  });
}
