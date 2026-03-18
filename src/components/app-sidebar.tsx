"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";

const navItems = [
  {
    href: "/",
    label: "Home",
    icon: (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 20 20"
        fill="currentColor"
        className="h-[18px] w-[18px]"
      >
        <path
          fillRule="evenodd"
          d="M9.293 2.293a1 1 0 0 1 1.414 0l7 7A1 1 0 0 1 17 11h-1v6a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1v-3a1 1 0 0 0-1-1H9a1 1 0 0 0-1 1v3a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-6H3a1 1 0 0 1-.707-1.707l7-7Z"
          clipRule="evenodd"
        />
      </svg>
    ),
  },
  {
    href: "/create",
    label: "Create",
    icon: (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 20 20"
        fill="currentColor"
        className="h-[18px] w-[18px]"
      >
        <path d="M10.75 4.75a.75.75 0 0 0-1.5 0v4.5h-4.5a.75.75 0 0 0 0 1.5h4.5v4.5a.75.75 0 0 0 1.5 0v-4.5h4.5a.75.75 0 0 0 0-1.5h-4.5v-4.5Z" />
      </svg>
    ),
  },
  {
    href: "/wallet",
    label: "Wallet",
    icon: (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="currentColor"
        className="h-[18px] w-[18px]"
      >
        <path d="M2.273 5.625A4.483 4.483 0 0 1 5.25 4.5h13.5c1.141 0 2.183.425 2.977 1.125A3 3 0 0 0 18.75 3H5.25a3 3 0 0 0-2.977 2.625ZM2.273 8.625A4.483 4.483 0 0 1 5.25 7.5h13.5c1.141 0 2.183.425 2.977 1.125A3 3 0 0 0 18.75 6H5.25a3 3 0 0 0-2.977 2.625ZM5.25 9a3 3 0 0 0-3 3v6a3 3 0 0 0 3 3h13.5a3 3 0 0 0 3-3v-6a3 3 0 0 0-3-3H15a.75.75 0 0 0-.75.75 2.25 2.25 0 0 1-4.5 0A.75.75 0 0 0 9 9H5.25Z" />
      </svg>
    ),
  },
  {
    href: "/settings",
    label: "Settings",
    icon: (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 20 20"
        fill="currentColor"
        className="h-[18px] w-[18px]"
      >
        <path
          fillRule="evenodd"
          d="M7.84 1.804A1 1 0 0 1 8.82 1h2.36a1 1 0 0 1 .98.804l.331 1.652a6.993 6.993 0 0 1 1.929 1.115l1.598-.54a1 1 0 0 1 1.186.447l1.18 2.044a1 1 0 0 1-.205 1.251l-1.267 1.113a7.047 7.047 0 0 1 0 2.228l1.267 1.113a1 1 0 0 1 .206 1.25l-1.18 2.045a1 1 0 0 1-1.187.447l-1.598-.54a6.993 6.993 0 0 1-1.929 1.115l-.33 1.652a1 1 0 0 1-.98.804H8.82a1 1 0 0 1-.98-.804l-.331-1.652a6.993 6.993 0 0 1-1.929-1.115l-1.598.54a1 1 0 0 1-1.186-.447l-1.18-2.044a1 1 0 0 1 .205-1.251l1.267-1.114a7.05 7.05 0 0 1 0-2.227L1.821 7.773a1 1 0 0 1-.206-1.25l1.18-2.045a1 1 0 0 1 1.187-.447l1.598.54A6.993 6.993 0 0 1 7.51 3.456l.33-1.652ZM10 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"
          clipRule="evenodd"
        />
      </svg>
    ),
  },
];

export function AppSidebar() {
  const pathname = usePathname();

  const isActive = (href: string) => {
    if (href === "/") return pathname === "/";
    return pathname.startsWith(href);
  };

  return (
    <>
      {/* ─── Desktop: vertical sidebar ─── */}
      <div className="hidden md:flex fixed left-0 top-0 bottom-0 z-40 flex-col items-center py-4 px-2 w-[60px] bg-white/[0.04] backdrop-blur-xl border-r border-white/[0.07]">
        {/* Logo */}
        <Link
          href="/"
          className="mb-6 h-9 w-9 rounded-xl bg-primary flex items-center justify-center text-primary-foreground font-bold text-sm shrink-0"
        >
          V
        </Link>

        {/* Nav icons */}
        <nav className="flex flex-col items-center gap-1.5 flex-1">
          {navItems.slice(0, 3).map((item) => {
            const active = isActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`relative h-10 w-10 rounded-xl flex items-center justify-center transition-all duration-200 group ${
                  active
                    ? "bg-white/[0.1] border border-white/[0.12] text-foreground shadow-[0_0_12px_rgba(255,255,255,0.04)] backdrop-blur-sm"
                    : "text-muted-foreground/50 hover:text-muted-foreground/80 hover:bg-white/[0.05]"
                }`}
              >
                {item.icon}
                <span className="absolute left-full ml-2 px-2 py-1 rounded-md bg-card border border-border/40 text-xs font-medium text-foreground whitespace-nowrap opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity shadow-lg">
                  {item.label}
                </span>
              </Link>
            );
          })}
        </nav>

        {/* Settings at bottom */}
        <Link
          href="/settings"
          className={`mt-auto relative h-10 w-10 rounded-xl flex items-center justify-center transition-all duration-200 group ${
            pathname.startsWith("/settings")
              ? "bg-white/[0.1] border border-white/[0.12] text-foreground shadow-[0_0_12px_rgba(255,255,255,0.04)] backdrop-blur-sm"
              : "text-muted-foreground/50 hover:text-muted-foreground/80 hover:bg-white/[0.05]"
          }`}
        >
          {navItems[3].icon}
          <span className="absolute left-full ml-2 px-2 py-1 rounded-md bg-card border border-border/40 text-xs font-medium text-foreground whitespace-nowrap opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity shadow-lg">
            Settings
          </span>
        </Link>
      </div>

      {/* ─── Mobile: floating pill bottom bar ─── */}
      <div
        className="md:hidden fixed bottom-5 left-1/2 -translate-x-1/2 z-50"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <nav className="flex items-center gap-5 px-6 h-16 rounded-full bg-white/[0.07] backdrop-blur-2xl border border-white/[0.1] shadow-[0_8px_32px_rgba(0,0,0,0.4)]">
          {navItems.map((item) => {
            const active = isActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`h-12 w-12 rounded-full flex items-center justify-center transition-all duration-200 ${
                  active
                    ? "bg-white/[0.14] text-foreground shadow-[0_0_10px_rgba(255,255,255,0.06)]"
                    : "text-muted-foreground/50 active:scale-90"
                }`}
              >
                {item.icon}
              </Link>
            );
          })}
        </nav>
      </div>
    </>
  );
}
