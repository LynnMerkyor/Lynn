export function errorMessage(err) {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err || "Unknown error");
}
