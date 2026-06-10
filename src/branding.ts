import { Config } from "./config/Config";

type BrandingConfig = NonNullable<ReturnType<typeof Config.get>["branding"]>;

// The config may not be initialized yet at some early call sites (module-level
// logging, tests); treat that the same as an absent branding block so every
// consumer falls back to the build-time defaults.
function brandingConfig(): BrandingConfig | undefined {
  try {
    return Config.get().branding;
  } catch {
    return undefined;
  }
}

/**
 * The product name to show in titles, aria-labels, and user-facing copy.
 * Prefers the runtime config (branding.product_name), then the build-time
 * VITE_PRODUCT_NAME, then the upstream default.
 */
export function productName(): string {
  return (
    brandingConfig()?.product_name ||
    import.meta.env.VITE_PRODUCT_NAME ||
    "Element Call"
  );
}

/**
 * URL of the primary logo (header + auth screens). Undefined when the
 * deployment has not configured one, in which case the baked-in SVG is used.
 */
export function brandingLogoUrl(): string | undefined {
  return brandingConfig()?.logo_url || undefined;
}

/** URL of the square logo mark shown in the in-call footer. */
export function brandingLogoMarkUrl(): string | undefined {
  return brandingConfig()?.logo_mark_url || undefined;
}

/** URL of the wordmark shown next to the mark in the in-call footer. */
export function brandingLogoTypeUrl(): string | undefined {
  return brandingConfig()?.logo_type_url || undefined;
}
