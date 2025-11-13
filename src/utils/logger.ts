/**
 * Structured logging for CloudWatch
 */

/**
 * Helper to mask sensitive data in logs
 */
export function maskApiKey(apiKey?: string): string {
  if (!apiKey) return "none";
  if (apiKey.length <= 8) return "***";
  return `${apiKey.substring(0, 4)}***${apiKey.substring(apiKey.length - 4)}`;
}

/**
 * Structured logging for CloudWatch
 */
export function log(level: "info" | "warn" | "error", message: string, metadata?: Record<string, unknown>) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    level,
    service: "katoshi-trading",
    message,
    ...metadata,
  };
  console.log(JSON.stringify(logEntry));
}

