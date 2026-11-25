import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

import { cloudflare } from "@cloudflare/vite-plugin";

// The Supabase project ref is the `https://<ref>.supabase.co` subdomain. Deriving
// it means a deployment that only sets SUPABASE_URL still exposes a usable
// VITE_SUPABASE_PROJECT_ID instead of an empty string.
function projectRefFromUrl(url) {
  const match = String(url || "").match(/^https?:\/\/([a-z0-9]+)\.supabase\.(?:co|in)/i);
  return match ? match[1] : "";
}

// The browser client must target the same Supabase project as the /api functions,
// which use the integration-managed SUPABASE_URL. Prefer those values over any
// stale VITE_SUPABASE_* overrides so sign-in and email-code flows never split.
// The full VITE_SUPABASE_* set is derived here and injected through `define` so
// the browser bundle never depends on which alias the environment happened to set.
function resolveSupabaseClientEnv(mode) {
  const env = loadEnv(mode, process.cwd(), "");
  const url = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || env.VITE_SUPABASE_URL || "";
  const anonKey =
    env.SUPABASE_ANON_KEY ||
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    env.VITE_SUPABASE_ANON_KEY ||
    env.VITE_SUPABASE_PUBLISHABLE_KEY ||
    env.SUPABASE_PUBLISHABLE_KEY ||
    "";
  return {
    url,
    anonKey,
    projectId: env.VITE_SUPABASE_PROJECT_ID || env.SUPABASE_PROJECT_ID || projectRefFromUrl(url),
  };
}

function resolveAppwriteClientEnv(mode) {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    endpoint: env.VITE_APPWRITE_ENDPOINT || process.env.VITE_APPWRITE_ENDPOINT || "",
    projectId: env.VITE_APPWRITE_PROJECT_ID || process.env.VITE_APPWRITE_PROJECT_ID || "",
    authProvider: env.VITE_AUTH_PROVIDER || process.env.VITE_AUTH_PROVIDER || "supabase",
  };
}

export default defineConfig(({ mode }) => {
  const supabaseClientEnv = resolveSupabaseClientEnv(mode);
  const appwriteClientEnv = resolveAppwriteClientEnv(mode);
  return {
  define: {
    "import.meta.env.VITE_SUPABASE_URL": JSON.stringify(supabaseClientEnv.url),
    "import.meta.env.VITE_SUPABASE_ANON_KEY": JSON.stringify(supabaseClientEnv.anonKey),
    // Publishable key is the current name for the browser-safe key; keep both
    // names in sync so older checks that read either one agree.
    "import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY": JSON.stringify(supabaseClientEnv.anonKey),
    "import.meta.env.VITE_SUPABASE_PROJECT_ID": JSON.stringify(supabaseClientEnv.projectId),
    "import.meta.env.VITE_APPWRITE_ENDPOINT": JSON.stringify(appwriteClientEnv.endpoint),
    "import.meta.env.VITE_APPWRITE_PROJECT_ID": JSON.stringify(appwriteClientEnv.projectId),
    "import.meta.env.VITE_AUTH_PROVIDER": JSON.stringify(appwriteClientEnv.authProvider),
  },
  plugins: [
    react(),
    cloudflare(),
  ],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('react-dom') || id.includes('react-router')) return 'vendor'
            // Match the react package itself, not any package with "/react/" in
            // its path (e.g. @emoji-mart/react), which must stay with its owner.
            if (id.includes('node_modules/react/')) return 'vendor'
            if (id.includes('@tanstack')) return 'query'
            if (id.includes('@supabase')) return 'supabase'
            if (id.includes('framer-motion') || id.includes('next-themes')) return 'ui'
            if (id.includes('@heroicons') || id.includes('lucide-react')) return 'icons'
            if (id.includes('react-hook-form') || id.includes('@hookform') || id.includes('zod') || id.includes('input-otp')) return 'forms'
            if (id.includes('date-fns') || id.includes('class-variance-authority') || id.includes('clsx') || id.includes('tailwind-merge')) return 'util'
            if (id.includes('@radix-ui')) return 'radix'
            if (id.includes('@emoji-mart') || id.includes('emoji-mart')) return 'emoji'
            // Heavy, feature-specific libraries get their own chunks so a screen
            // that needs them does not inflate the entry bundle or first paint.
            if (id.includes('@vladmandic/face-api')) return 'face'
            if (id.includes('react-markdown') || id.includes('remark') || id.includes('rehype') || id.includes('micromark') || id.includes('mdast') || id.includes('hast') || id.includes('unist')) return 'markdown'
          }
        },
      },
    },
  },
  server: {
    port: 5173,
  },
  };
});
