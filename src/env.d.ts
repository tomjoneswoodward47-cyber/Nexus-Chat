// Browser-visible Supabase configuration. `vite.config.js` always injects these
// four keys through `define`, so they are typed as strings: they exist on
// `import.meta.env` even when unset (an unset value is an empty string).
// Values never hardcoded here; see docs/supabase-auth-setup.md for the contract.
interface ImportMetaEnv {
  /** Supabase project URL, e.g. `https://<project-ref>.supabase.co`. */
  readonly VITE_SUPABASE_URL: string;
  /** Public anon key (legacy `eyJ...` JWT) used to build the browser client. */
  readonly VITE_SUPABASE_ANON_KEY: string;
  /** Public publishable key (`sb_publishable_...`), the current key format. */
  readonly VITE_SUPABASE_PUBLISHABLE_KEY: string;
  /** Supabase project ref; derived from `VITE_SUPABASE_URL` when not set. */
  readonly VITE_SUPABASE_PROJECT_ID: string;
  readonly [key: string]: string | undefined;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
