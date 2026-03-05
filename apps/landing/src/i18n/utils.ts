import { en } from "./en";
import { fr } from "./fr";

export type Locale = "en" | "fr";

const translations = { en, fr } as const;

export function getLangFromUrl(url: URL): Locale {
  const [, lang] = url.pathname.split("/");
  if (lang === "fr") return "fr";
  return "en";
}

export function useTranslations(lang: Locale) {
  function t(key: string): string {
    const val = resolve(translations[lang], key);
    if (typeof val === "string") return val;
    const fallback = resolve(translations.en, key);
    return typeof fallback === "string" ? fallback : key;
  }
  t.array = (key: string): string[] => {
    const val = resolve(translations[lang], key);
    if (Array.isArray(val)) return val as string[];
    const fallback = resolve(translations.en, key);
    return Array.isArray(fallback) ? fallback as string[] : [];
  };
  return t;
}

function resolve(obj: unknown, key: string): unknown {
  const keys = key.split(".");
  let value = obj;
  for (const k of keys) {
    value = (value as Record<string, unknown>)?.[k];
  }
  return value;
}

export function localizedPath(path: string, lang: Locale): string {
  if (lang === "en") return path;
  return `/fr${path === "/" ? "" : path}`;
}

export function getAlternateLang(lang: Locale): Locale {
  return lang === "en" ? "fr" : "en";
}

export function getAlternateUrl(url: URL, lang: Locale): string {
  const alternate = getAlternateLang(lang);
  const pathname = url.pathname;
  if (lang === "fr") {
    // Currently French, link to English (remove /fr prefix)
    const enPath = pathname.replace(/^\/fr/, "") || "/";
    return enPath;
  }
  // Currently English, link to French (add /fr prefix)
  return `/fr${pathname === "/" ? "" : pathname}`;
}
