import { useState, type ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { LogOut, Menu, UserCog, Users } from "lucide-react";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSignOut } from "@/components/AuthGate";
import { AppSidebar } from "@/components/AppSidebar";
import { SourceBadge } from "@/components/SourceBadge";
import { ActivityTracker } from "@/components/ActivityTracker";
import { NotificationBell } from "@/components/NotificationBell";
import { useAuth } from "@/hooks/queries";

const PAGE_TITLES: Array<{ match: (p: string) => boolean; title: string }> = [
  { match: (p) => p === "/", title: "Dashboard" },
  { match: (p) => p.startsWith("/find-leads"), title: "Find Leads" },
  { match: (p) => p.startsWith("/leads/"), title: "Lead" },
  { match: (p) => p.startsWith("/leads"), title: "All Leads" },
  { match: (p) => p.startsWith("/pipeline"), title: "Pipeline" },
  { match: (p) => p.startsWith("/tasks"), title: "Tasks" },
  { match: (p) => p.startsWith("/campaigns"), title: "Email Campaigns" },
  { match: (p) => p.startsWith("/templates"), title: "Templates" },
  { match: (p) => p.startsWith("/email-setup"), title: "Email Setup" },
  { match: (p) => p.startsWith("/search-history"), title: "Search History" },
  { match: (p) => p.startsWith("/export-center"), title: "Export Center" },
  { match: (p) => p.startsWith("/settings"), title: "Settings" },
  { match: (p) => p.startsWith("/account"), title: "My Account" },
  { match: (p) => p.startsWith("/import"), title: "Import Leads" },
  { match: (p) => p.startsWith("/whatsapp"), title: "WhatsApp Outreach" },
  { match: (p) => p.startsWith("/duplicates"), title: "Duplicates" },
  { match: (p) => p.startsWith("/users"), title: "Team" },
  { match: (p) => p.startsWith("/activity"), title: "Staff Activity" },
  { match: (p) => p.startsWith("/reports"), title: "Reports" },
];

function Header() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { user, isAdmin } = useAuth();
  const signOut = useSignOut();
  const title = PAGE_TITLES.find((t) => t.match(pathname))?.title ?? "LeadFinder Pro";
  const initials = (user?.name ?? "?")
    .split(" ")
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <header className="sticky top-0 z-30 flex h-16 shrink-0 items-center gap-3 border-b border-border bg-card/90 px-4 backdrop-blur lg:px-8">
      <button
        onClick={() => setMobileOpen(true)}
        className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground lg:hidden"
        aria-label="Open navigation"
      >
        <Menu className="h-5 w-5" />
      </button>
      <h1 className="font-display text-lg font-bold text-foreground">{title}</h1>
      <div className="ml-auto flex items-center gap-3">
        <span className="hidden sm:inline-flex">
          <SourceBadge />
        </span>
        <NotificationBell />
        <DropdownMenu>
          <DropdownMenuTrigger
            className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Account menu"
          >
            <Avatar className="h-9 w-9 border border-border">
              <AvatarFallback className="bg-primary/10 text-xs font-semibold text-primary">
                {initials}
              </AvatarFallback>
            </Avatar>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel className="font-normal">
              <p className="truncate text-sm font-medium">{user?.name}</p>
              <p className="truncate text-xs text-muted-foreground">{user?.email}</p>
              <p className="mt-0.5 text-[11px] capitalize text-muted-foreground">{user?.role}</p>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link to="/account">
                <UserCog className="h-4 w-4" /> My account
              </Link>
            </DropdownMenuItem>
            {isAdmin && (
              <DropdownMenuItem asChild>
                <Link to="/users">
                  <Users className="h-4 w-4" /> Team
                </Link>
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => void signOut()}>
              <LogOut className="h-4 w-4" /> Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent
          side="left"
          className="w-64 border-sidebar-border bg-sidebar p-0 [&>button]:text-sidebar-foreground"
        >
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <AppSidebar onNavigate={() => setMobileOpen(false)} />
        </SheetContent>
      </Sheet>
    </header>
  );
}

export function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background">
      <aside className="fixed inset-y-0 left-0 z-40 hidden lg:block">
        <AppSidebar />
      </aside>
      <div className="flex min-h-screen flex-col lg:pl-64">
        <ActivityTracker />
        <Header />
        <main className="flex-1 px-4 py-6 lg:px-8 lg:py-8">
          <div className="w-full">{children}</div>
        </main>
      </div>
    </div>
  );
}
