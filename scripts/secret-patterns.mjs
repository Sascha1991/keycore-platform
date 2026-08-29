export const secretChecks = [
  {
    name: "live Stripe secret key",
    pattern: /sk_live_[A-Za-z0-9]{12,}/u,
  },
  {
    name: "live Stripe restricted key",
    pattern: /rk_live_[A-Za-z0-9]{12,}/u,
  },
  {
    name: "Stripe webhook secret",
    pattern: /whsec_[A-Za-z0-9]{16,}/u,
  },
  {
    name: "GitHub token",
    pattern: /gh[pousr]_[A-Za-z0-9_]{20,}/u,
  },
  {
    name: "GitLab token",
    pattern: /glpat-[A-Za-z0-9_-]{20,}/u,
  },
  {
    name: "npm token",
    pattern: /npm_[A-Za-z0-9]{20,}/u,
  },
  {
    name: "Slack token",
    pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/u,
  },
  {
    name: "AWS access key",
    pattern: /AKIA[0-9A-Z]{16}/u,
  },
  {
    name: "Google API key",
    pattern: /AIza[0-9A-Za-z_-]{30,}/u,
  },
  {
    name: "bearer credential",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/iu,
  },
  {
    name: "private key block",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  },
  {
    name: "non-test product key pattern",
    pattern:
      /(?<!TEST-)\b[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}(?:-[A-Z0-9]{5})?\b/u,
  },
  {
    name: "hard-coded secret assignment",
    pattern:
      /\b(?:api[_-]?key|secret|password|token)\s*[:=]\s*["'][^"'<>{}\s]{8,}["']/iu,
  },
];

export const scanSecretText = (content) =>
  secretChecks
    .filter((check) => {
      check.pattern.lastIndex = 0;
      return check.pattern.test(content);
    })
    .map((check) => check.name);
