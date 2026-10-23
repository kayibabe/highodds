"use client";

import type { ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { signOutAction } from "./actions";
import ThemeToggle from "./theme-toggle";
import TableSorters from "./sortable-table";

// Sidebar app shell ported from lohela's frontend (App.tsx): brand + grouped icon nav on the left,
// slim status header on top, bottom tab bar on phones. Sign-in renders standalone, as in lohela.

type NavItem = { href: string; label: string; icon: IconName; hint: string };
type NavGroup = { label: string; icon: IconName; children: NavItem[] };
type IconName = "home" | "sparkles" | "chart" | "shield" | "login" | "search" | "gauge";

function BrandMark() {
  return <svg className="brand-mark" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
    <rect width="64" height="64" rx="18" fill="#0b1626" />
    <path d="M20 18v28M44 18v28" fill="none" stroke="#f5fbff" strokeWidth="7" strokeLinecap="round" />
    <path d="M20 33h24" fill="none" stroke="#35d5e8" strokeWidth="7" strokeLinecap="round" />
    <circle cx="44" cy="20" r="4" fill="#35d5e8" />
  </svg>;
}

const WORKFLOW: NavGroup[] = [
  { label: "Today", icon: "sparkles", children: [
    { href: "/dashboard/research", label: "Today’s Intelligence", icon: "sparkles", hint: "Published paper tickets and supporting signals" },
    { href: "/dashboard/high-probability", label: "Forecast Finder", icon: "chart", hint: "Filter forecasts with historical calibration evidence" }
  ] },
  { label: "Investigate", icon: "search", children: [
    { href: "/research", label: "Fixture Inspector", icon: "search", hint: "Inspect a fixture’s forecasts, prices and result" },
    { href: "/research/screener", label: "Historical Screener", icon: "chart", hint: "Filter historical forecasts and captured prices" },
    { href: "/research/probability-bands", label: "Probability Mixes", icon: "chart", hint: "Review prospective model and bookmaker probability bands" },
    { href: "/research/model-history", label: "Forecast Archive", icon: "chart", hint: "Model selection archive and outcome hit rates" }
  ] },
  { label: "Review", icon: "chart", children: [
    { href: "/results", label: "Results & Returns", icon: "chart", hint: "Settled paper history and model quality" }
  ] }
];
const ADMIN_ITEMS: NavItem[] = [
  { href: "/analysis", label: "System Health", icon: "gauge", hint: "Pipeline health and model diagnostics" },
  { href: "/admin", label: "Administration", icon: "shield", hint: "Users, providers, and operations" }
];
const SIGN_IN: NavItem = { href: "/signin", label: "Sign in", icon: "login", hint: "Subscriber and admin access" };

function NavIcon({ name }: { name: IconName }) {
  const paths: Record<IconName, ReactNode> = {
    home: <><path d="M4 11 12 4l8 7" /><path d="M6 10v10h12V10" /><path d="M10 20v-5h4v5" /></>,
    sparkles: <><path d="m12 3-1.2 4.1L7 8.3l3.8 1.2L12 13l1.2-3.5L17 8.3l-3.8-1.2L12 3Z" /><path d="m5 14-.7 2.3L2 17l2.3.7L5 20l.7-2.3L8 17l-2.3-.7L5 14Z" /></>,
    chart: <path d="M5 20V10M12 20V4M19 20v-7" />,
    search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /><path d="M7.5 10.5h6M10.5 7.5v6" /></>,
    gauge: <><path d="M4 18a8 8 0 1 1 16 0" /><path d="m12 18 4-5" /><path d="M4 18h16" /></>,
    shield: <><path d="M12 3 20 6v5c0 5-3.4 8.6-8 10-4.6-1.4-8-5-8-10V6l8-3Z" /><path d="m9 12 2 2 4-4" /></>,
    login: <><path d="M14 4h5v16h-5" /><path d="M10 16l4-4-4-4" /><path d="M14 12H4" /></>
  };
  return <svg className="nav-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

export default function AppShell({ email, isAdmin, localAccess, children }: Readonly<{ email: string | null; isAdmin: boolean; localAccess: boolean; children: ReactNode }>) {
  const pathname = usePathname() ?? "/";
  const router = useRouter();

  if (pathname === "/signin" || pathname.startsWith("/signin/")) {
    return <div className="auth-standalone"><div className="auth-theme"><ThemeToggle /></div>{children}</div>;
  }

  // Keep the research navigation visible before sign-in. Public research and
  // results pages remain usable, while protected dashboard pages redirect to
  // sign-in when selected.
  const workflow = WORKFLOW;
  const currentGroup = workflow.find((item) => item.children.some((child) => isActive(pathname, child.href)));
  const mobileItems = email ? [...workflow.map((group) => ({ href: group.children[0]!.href, label: group.label, icon: group.icon, hint: group.label })), ...(isAdmin ? ADMIN_ITEMS : [])] : [SIGN_IN];

  const navLink = (item: NavItem, subpage = false) => {
    const active = pathname === item.href;
    return (
      <a key={item.href} href={item.href} className={`nav-tab${subpage ? " nav-subpage" : ""}${active ? " active" : ""}`} aria-current={active ? "page" : undefined} title={item.hint}>
        <span className="nav-icon"><NavIcon name={item.icon} /></span>{item.label}
      </a>
    );
  };

  return (
    <div className="app">
      <aside className="app-sidebar">
        <a className="brand" href="/" aria-label="HighOdds home">
          <BrandMark />
          <span className="brand-copy">
            <span className="brand-name">HighOdds</span>
            <span className="brand-tagline">See the signal. Keep the evidence.</span>
          </span>
        </a>
        <nav className="sidebar-nav" aria-label="Primary navigation">
          <span className="sidebar-label">Research flow</span>
          {workflow.map((group) => <div className="nav-group" key={group.label}>
            <span className={`nav-group-title${currentGroup === group ? " active" : ""}`}><NavIcon name={group.icon} />{group.label}</span>
            <div className="nav-group-pages">{group.children.map((child) => navLink(child, true))}</div>
          </div>)}
          {isAdmin && <>
            <span className="sidebar-label sidebar-label-admin">Operations</span>
            {ADMIN_ITEMS.map((item) => navLink(item))}
          </>}
        </nav>
        <div className="sidebar-account">
          {localAccess ? (
            <span className="auth-status">Local access enabled</span>
          ) : email ? (
            <div className="auth-session">
              <span className="auth-status" title={email}>{isAdmin ? "Admin" : "Subscriber"} · {email}</span>
              <form action={signOutAction}><button type="submit" className="theme-btn auth-signout">Sign out</button></form>
            </div>
          ) : (
            <a className="theme-btn auth-signin" href="/signin">Sign in</a>
          )}
        </div>
      </aside>

      <header className="app-header">
        <a className="brand brand-compact" href="/" aria-label="HighOdds home"><BrandMark /></a>
        <div className="main-header-status">
          <span className="research-status"><span className="status-dot" /> Paper research</span>
          <ThemeToggle />
        </div>
        <button type="button" className="global-refresh" onClick={() => router.refresh()} title="Refresh current page" aria-label="Refresh current page">↻ <span>Refresh</span></button>
        {email && !localAccess && <form action={signOutAction} className="header-signout"><button type="submit" className="theme-btn">Sign out</button></form>}
      </header>

      <main className="main" id="main-content" tabIndex={-1}>
        <TableSorters />
        {currentGroup?.children && <nav className="mobile-subpages" aria-label={`${currentGroup.label} pages`}>
          {currentGroup.children.map((item) => <a key={item.href} href={item.href} className={pathname === item.href ? "active" : ""} aria-current={pathname === item.href ? "page" : undefined}>{item.label}</a>)}
        </nav>}
        {children}
        <footer className="app-footer">18+ · Paper analysis only · No guaranteed outcomes</footer>
      </main>

      <nav className="bottom-nav" aria-label="Primary navigation" style={{ gridTemplateColumns: `repeat(${mobileItems.length}, 1fr)` }}>
        {mobileItems.map((item) => {
          const active = isActive(pathname, item.href);
          return (
            <a key={item.href} href={item.href} className={active ? "active" : ""} aria-current={active ? "page" : undefined}>
              <span aria-hidden="true"><NavIcon name={item.icon} /></span>
              {item.label}
            </a>
          );
        })}
      </nav>
    </div>
  );
}
