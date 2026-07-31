import { auth } from "@/lib/auth";
import Link from "next/link";
import AvatarMenu from "@/app/components/AvatarMenu";
import FeedbackButton from "@/app/components/FeedbackButton";
import { airlockEnabled } from "@/lib/airlock/config";
import { getAssignedLocks } from "@/lib/airlock/service";
import pkg from "../../package.json";

export default async function Header() {
  const session = await auth();
  const user = session?.user;
  const feedbackEnabled = process.env.DISABLE_FEEDBACK !== "true";

  // Airlock: „Meine Airlock-Schlösser" nur zeigen, wenn die Integration scharf ist UND dem Sub
  // mindestens ein Lock zugewiesen ist (sonst wäre der Menüpunkt für die meisten leer/verwirrend).
  let showMyAirlock = false;
  if (user) {
    const [on, locks] = await Promise.all([airlockEnabled(), getAssignedLocks(user.id)]);
    showMyAirlock = on && locks.length > 0;
  }

  const hostname = process.env.NEXTAUTH_URL
    ? (() => { try { return new URL(process.env.NEXTAUTH_URL!).hostname; } catch { return null; } })()
    : null;

  return (
    <header className="bg-header-bg border-b border-header-border sticky top-0 z-30 pt-safe">
      <div className="px-4 h-14 flex items-center justify-between gap-3">
        <Link
          href="/dashboard"
          className="font-bold text-header-text hover:opacity-80 transition text-lg tracking-tight flex items-baseline gap-2"
        >
          KG-Tracker
          {hostname && (
            <span className="text-xs font-normal text-header-text/60 tracking-normal">
              {hostname}
            </span>
          )}
        </Link>

        <div className="flex items-center gap-2">
          {user && feedbackEnabled && <FeedbackButton />}
          {user && (
            <AvatarMenu
              username={user.name ?? ""}
              settingsHref="/dashboard/settings"
              theme="user"
              version={pkg.version}
              showMyAirlock={showMyAirlock}
            />
          )}
        </div>
      </div>
    </header>
  );
}
