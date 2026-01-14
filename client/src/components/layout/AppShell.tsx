// client/src/components/layout/AppShell.tsx
import { NavLink } from 'react-router-dom';
import { Home, Image, CreditCard, Settings, LucideIcon } from 'lucide-react';

export const AppShell = ({ children }: { children: React.ReactNode }) => {
  return (
    <div className="flex h-screen bg-slate-50 text-slate-900 font-sans">
      {/* Sidebar */}
      <aside className="w-64 bg-brand-900 text-white flex flex-col border-r border-brand-800">
        <div className="h-16 flex items-center px-6 border-b border-brand-800">
          <span className="text-xl font-semibold tracking-tight">RealEnhance</span>
        </div>
        
        <nav className="flex-1 p-4 space-y-1">
          <NavItem to="/home" icon={Home} label="Dashboard" />
          <NavItem to="/enhanced-history" icon={Image} label="Gallery" />
          <NavItem to="/agency" icon={CreditCard} label="Billing" />
          <NavItem to="/settings" icon={Settings} label="Settings" />
        </nav>
        
        <div className="p-4 border-t border-brand-800">
          <div className="flex items-center gap-3">
             <div className="w-8 h-8 rounded-full bg-brand-700 flex items-center justify-center text-xs">U</div>
             <div className="text-sm">
                <p className="font-medium">User</p>
                <p className="text-brand-300 text-xs">Plan</p>
             </div>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-7xl mx-auto px-8 py-8">
          {children}
        </div>
      </main>
    </div>
  );
};

const NavItem = ({ to, icon: Icon, label }: { to: string; icon: LucideIcon; label: string }) => (
  <NavLink 
    to={to} 
    className={({ isActive }) => 
      `flex items-center gap-3 px-3 py-2 rounded-md transition-colors ${
        isActive 
          ? 'bg-brand-800 text-white' 
          : 'text-brand-200 hover:bg-brand-800/50 hover:text-white'
      }`
    }
  >
    <Icon size={18} />
    <span className="text-sm font-medium">{label}</span>
  </NavLink>
);
