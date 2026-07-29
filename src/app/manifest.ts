import type { MetadataRoute } from "next";

// Pro Request gerendert (nicht statisch), damit die Runtime-Env INSTANCE_LABEL greift: die Beta
// bekommt so ohne Rebuild eigenen Namen/Icon/Theme. Prod setzt INSTANCE_LABEL nicht -> unveraendert.
// (iOS zieht Home-Icon/Name ohnehin aus apple-touch-icon + apple-mobile-web-app-title in layout.tsx;
//  dieses Manifest deckt Android/Desktop-PWA ab.)
export const dynamic = "force-dynamic";

export default function manifest(): MetadataRoute.Manifest {
  const isBeta = process.env.INSTANCE_LABEL === "BETA";
  const name = isBeta ? "KG Tracker BETA" : "KG Tracker";
  const icon192 = isBeta ? "/icon-192-beta.png" : "/icon-192.png";
  const icon512 = isBeta ? "/icon-512-beta.png" : "/icon-512.png";
  return {
    name,
    short_name: name,
    description: "Keuschheitsgürtel Tracking",
    id: "/dashboard",
    lang: "de",
    start_url: "/dashboard",
    display: "standalone",
    background_color: "#f8f9fb",
    theme_color: isBeta ? "#ef4444" : "#111827",
    orientation: "portrait",
    icons: [
      { src: icon192, sizes: "192x192", type: "image/png", purpose: "any" },
      { src: icon512, sizes: "512x512", type: "image/png", purpose: "any" },
      { src: icon512, sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Neuer Eintrag", short_name: "Neu", url: "/dashboard?action=new", icons: [{ src: icon192, sizes: "192x192" }] },
      { name: "Statistiken", short_name: "Stats", url: "/dashboard/stats", icons: [{ src: icon192, sizes: "192x192" }] },
    ],
    categories: ["health", "lifestyle"],
  };
}
