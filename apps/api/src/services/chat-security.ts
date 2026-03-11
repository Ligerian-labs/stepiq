interface SecurityCheckResult {
  safe: boolean;
  reason?: string;
  severity: "low" | "medium" | "high" | "critical";
  patterns?: string[];
}

const MALICIOUS_PATTERNS = [
  /ignore (all )?(previous|above|system) instructions/i,
  /disregard (all )?(previous|above|system) instructions/i,
  /you are now (a|an) /i,
  /act as (if )?you are/i,
  /pretend (to be|you are)/i,
  /override (your|the) (instructions|rules|constraints)/i,
  /bypass (security|restrictions|filters)/i,
  /show (me )?(your|the) (system )?prompt/i,
  /repeat (your|the) (system )?instructions/i,
  /what (are|is) your (system )?instructions/i,
  /print (your|the) (system )?prompt/i,
  /execute (this|the following) code/i,
  /run (this|the following) (command|script)/i,
  /exfiltrate/i,
  /export (all|user) data/i,
  /access (other|another) user/i,
  /create (\d+|unlimited|infinite) (pipelines|steps)/i,
  /bypass (rate )?limit/i,
];

export const ALLOWED_STEP_TYPES = [
  "llm",
  "transform",
  "condition",
  "parallel",
  "webhook",
  "human_review",
];

export function validateUserInput(input: string): SecurityCheckResult {
  const detectedPatterns: string[] = [];

  for (const pattern of MALICIOUS_PATTERNS) {
    if (pattern.test(input)) {
      detectedPatterns.push(pattern.source);
    }
  }

  if (detectedPatterns.length > 0) {
    return {
      safe: false,
      reason: "Input contains potentially malicious patterns",
      severity: "high",
      patterns: detectedPatterns,
    };
  }

  if (input.length > 10000) {
    return {
      safe: false,
      reason: "Input exceeds maximum length",
      severity: "medium",
    };
  }

  if (containsSuspiciousEncoding(input)) {
    return {
      safe: false,
      reason: "Input contains suspicious encoding",
      severity: "medium",
    };
  }

  return { safe: true, severity: "low" };
}

export function sanitizeUserInput(input: string): string {
  let sanitized = input.replaceAll("\0", "").trim();

  if (sanitized.length > 10000) {
    sanitized = `${sanitized.substring(0, 10000)}... [truncated]`;
  }

  return sanitized;
}

function containsSuspiciousEncoding(input: string): boolean {
  const suspiciousPatterns = [
    /[A-Za-z0-9+/]{40,}={0,2}/,
    /\\x[0-9a-fA-F]{2}/,
    /\\u[0-9a-fA-F]{4}/,
  ];

  return suspiciousPatterns.some((pattern) => pattern.test(input));
}
