// client/src/components/layout/AppShell.tsx
import { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  Home,
  Image,
  CreditCard,
  Settings,
  HelpCircle,
  Menu,
  X,
  Sparkles,
  LogOut,
  Building2,
  type LucideIcon
} from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { useUsage } from '@/hooks/use-usage';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';

// Navigation configuration
const mainNavItems = [
  { to: '/home', icon: Home, label: 'Enhance' },
  { to: '/enhanced-history', icon: Image, label: 'Gallery' },
];

const managementNavItems = [
  { to: '/agency', icon: CreditCard, label: 'Billing & Usage' },
  { to: '/agency/settings', icon: Building2, label: 'Agency' },
];

const systemNavItems = [
  { to: '/settings/profile', icon: Settings, label: 'Account Settings' },
];

export const AppShell = ({ children }: { children: React.ReactNode }) => {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { user, signOut } = useAuth();
  const { usage } = useUsage();
  const location = useLocation();

  // Get user initials
  const userInitials = user?.firstName && user?.lastName
    ? `${user.firstName[0]}${user.lastName[0]}`.toUpperCase()
    : user?.email?.[0]?.toUpperCase() || 'U';

  const userName = user?.firstName
    ? `${user.firstName} ${user.lastName || ''}`.trim()
    : user?.email?.split('@')[0] || 'User';

  const planName = usage?.planName || 'Free';

  // Refresh the page after 30 minutes of inactivity
  useEffect(() => {
    const INACTIVITY_MS = 30 * 60 * 1000;
    let timer: number;

    const resetTimer = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        window.location.reload();
      }, INACTIVITY_MS);
    };

    const events: Array<keyof WindowEventMap> = [
      'mousemove',
      'keydown',
      'scroll',
      'touchstart',
      'click',
      'visibilitychange'
    ];

    const handler = () => {
      if (document.hidden) return;
      resetTimer();
    };

    events.forEach((evt) => window.addEventListener(evt, handler));
    resetTimer();

    return () => {
      window.clearTimeout(timer);
      events.forEach((evt) => window.removeEventListener(evt, handler));
    };
  }, []);

  return (
    <div className="flex h-screen bg-surface-page text-brand-900 font-sans">
      {/* Mobile sidebar backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside className={cn(
        "fixed inset-y-0 left-0 z-50 w-64 bg-brand-900 text-white flex flex-col transform transition-transform duration-200 ease-in-out lg:translate-x-0 lg:static lg:z-auto",
        sidebarOpen ? "translate-x-0" : "-translate-x-full"
      )}>
        {/* Brand header */}
        <div className="h-16 flex items-center justify-between px-4 border-b border-brand-800">
          <div className="flex items-center flex-1 h-full py-2">
            <img src="/Logo-dark.png" alt="RealEnhance" className="h-full w-auto object-contain" />
          </div>
          <button
            onClick={() => setSidebarOpen(false)}
            className="lg:hidden p-1.5 rounded-md hover:bg-brand-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 px-3 py-4 space-y-6 overflow-y-auto">
          {/* Main section */}
          <div className="space-y-1">
            <NavSectionLabel>Main</NavSectionLabel>
            {mainNavItems.map(item => (
              <NavItem key={item.to} {...item} onClick={() => setSidebarOpen(false)} />
            ))}
          </div>

          {/* Management section */}
          <div className="space-y-1">
            <NavSectionLabel>Management</NavSectionLabel>
            {managementNavItems.map(item => (
              <NavItem key={item.to} {...item} onClick={() => setSidebarOpen(false)} />
            ))}
          </div>

          {/* System section */}
          <div className="space-y-1">
            <NavSectionLabel>System</NavSectionLabel>
            {systemNavItems.map(item => (
              <NavItem key={item.to} {...item} onClick={() => setSidebarOpen(false)} />
            ))}
            <a
              href="mailto:support@realenhance.ai"
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-brand-300 hover:bg-brand-800/50 hover:text-white transition-colors"
            >
              <HelpCircle className="w-[18px] h-[18px]" />
              <span className="text-sm font-medium">Support</span>
            </a>
          </div>
        </nav>

        {/* User section */}
        <div className="p-4 border-t border-brand-800">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="w-full flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-brand-800/60 transition-colors text-left"
                aria-label="User menu"
              >
                <div className="w-9 h-9 rounded-full bg-brand-700 flex items-center justify-center text-xs font-medium ring-2 ring-brand-800">
                  {userInitials}
                </div>
                <div className="flex-1 min-w-0 text-left">
                  <p className="text-sm font-medium truncate">{userName}</p>
                  <p className="text-brand-400 text-xs">{planName}</p>
                </div>
              </button>
            </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" className="w-56">
                <DropdownMenuItem
                  onClick={async () => {
                    await signOut();
                  }}
                  data-testid="button-sidebar-signout"
                >
                  <LogOut className="w-4 h-4 mr-2" />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </aside>

      {/* Main content area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Mobile header */}
        <header className="lg:hidden h-14 bg-white border-b border-surface-border flex items-center justify-between px-4 sticky top-0 z-30">
          <button
            onClick={() => setSidebarOpen(true)}
            className="p-2 -ml-2 rounded-md hover:bg-surface-subtle transition-colors"
          >
            <Menu className="w-5 h-5 text-brand-700" />
          </button>
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-action-600 flex items-center justify-center">
              <Sparkles className="w-3.5 h-3.5 text-white" />
            </div>
            <span className="font-semibold text-brand-900">RealEnhance</span>
          </div>
          <div className="w-9" /> {/* Spacer for centering */}
        </header>

        {/* Main content */}
        <main className="flex-1 overflow-y-auto">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-6 lg:py-8">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
};

// Navigation section label
const NavSectionLabel = ({ children }: { children: React.ReactNode }) => (
  <span className="px-3 text-[11px] font-semibold uppercase tracking-wider text-brand-400">
    {children}
  </span>
);

// Navigation item component
const NavItem = ({
  to,
  icon: Icon,
  label,
  onClick
}: {
  to: string;
  icon: LucideIcon;
  label: string;
  onClick?: () => void;
}) => (
  <NavLink
    to={to}
    onClick={onClick}
    className={({ isActive }) => cn(
      "flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-150 group",
      isActive
        ? "bg-brand-800 text-white shadow-sm border-l-2 border-action-500"
        : "text-brand-400 hover:bg-brand-800/50 hover:text-brand-100"
    )}
  >
    {({ isActive }) => (
      <>
        <Icon
          className={cn(
            "w-[18px] h-[18px] flex-shrink-0",
            isActive ? "text-action-400" : "text-brand-500 group-hover:text-brand-200"
          )}
        />
        <span className="text-sm font-medium">{label}</span>
      </>
    )}
  </NavLink>
);

export default AppShell;
