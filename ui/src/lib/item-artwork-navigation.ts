import { normalizeCompanyPrefix } from "./company-routes";

/** A saved return target is useful only within the currently selected company. */
export function itemArtworkReturnPath(value: unknown, companyPrefix: string | null | undefined, origin: string): string | null {
  if (typeof value !== "string" || !value.startsWith("/") || !companyPrefix) return null;
  const prefix = normalizeCompanyPrefix(companyPrefix);
  try {
    const target = new URL(value, origin);
    return target.origin === origin
      && target.pathname.startsWith(`/${prefix}/`)
      && target.pathname !== `/${prefix}/item-artwork` ? value : null;
  } catch { return null; }
}
