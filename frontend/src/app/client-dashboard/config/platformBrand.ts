/**
 * Platform (vendor) branding shown in the sidebar for EVERY tenant and every
 * logged-in user. Tenant/org identity lives in the header (see AdminLayout),
 * and personal identity lives in My Account. Keep those three concerns apart.
 *
 * logoSrc is served from /public so a missing file can never break the build;
 * <PlatformLogo /> falls back to the default mark if the image fails to load.
 */
export const PLATFORM_BRAND = {
  name: "QIntellect Technologies",
  logoSrc: "/qintellect-logo.png" as string | null,
} as const;
