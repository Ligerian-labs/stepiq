export const SITE_NAME = "stepIQ";
export const DEFAULT_SITE_URL = "https://stepiq.sh";

type SeoType = "website" | "article";

export interface SeoConfig {
  title: string;
  description: string;
  path?: string;
  type?: SeoType;
  keywords?: string[];
  noindex?: boolean;
}

export interface SeoMeta {
  title: string;
  description: string;
  canonical: string;
  type: SeoType;
  keywords?: string;
  robots: string;
}

function withTrailingSlashRemoved(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

export function getSiteUrl(): string {
  return withTrailingSlashRemoved(
    import.meta.env.PUBLIC_SITE_URL || DEFAULT_SITE_URL,
  );
}

export function buildSeoMeta(config: SeoConfig): SeoMeta {
  const siteUrl = getSiteUrl();
  const normalizedPath = config.path || "/";
  const canonical = new URL(normalizedPath, `${siteUrl}/`).toString();
  const title = config.title.includes(SITE_NAME)
    ? config.title
    : `${config.title} | ${SITE_NAME}`;

  return {
    title,
    description: config.description,
    canonical,
    type: config.type || "website",
    keywords:
      config.keywords && config.keywords.length > 0
        ? config.keywords.join(", ")
        : undefined,
    robots: config.noindex ? "noindex, nofollow" : "index, follow",
  };
}
