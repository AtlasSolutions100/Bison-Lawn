import { Link, useLocation } from 'wouter';
import { useClerk } from '@clerk/react';
import { 
  LayoutDashboard, 
  Users, 
  Settings, 
  FileText, 
  ListTodo, 
  Truck, 
  Receipt, 
  Ticket,
  CloudSun,
  UserCog,
  LogOut,
  Menu,
  SprayCan,
  Mail,
  Globe, MessageSquarePlus , Settings2, BookOpen, BarChart3 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useState } from 'react';
import { FeedbackButton } from '@/components/feedback-button';
import GlobalSearch from '@/components/global-search';
import { canOpen, useMe, type Area } from '@/lib/access';

// `area` is the part of the app the link opens; a person who cannot open it
// does not see the link. Entries without one are open to every office user.
const ADMIN_NAV: { name: string; href: string; icon: typeof LayoutDashboard; area?: Area }[] = [
  { name: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
  { name: 'Dispatch', href: '/dispatch', icon: Truck, area: 'dispatch' },
  { name: 'Waiting List', href: '/waiting-list', icon: ListTodo, area: 'dispatch' },
  { name: 'Clients', href: '/clients', icon: Users, area: 'clients' },
  { name: 'Estimates', href: '/estimates', icon: FileText, area: 'clients' },
  { name: 'Invoices', href: '/invoices', icon: Receipt, area: 'invoices' },
  { name: 'Books', href: '/books', icon: BookOpen, area: 'quickbooks' },
  { name: 'Reports', href: '/reports', icon: BarChart3, area: 'reports' },
  { name: 'Spray Runs', href: '/spray-runs', icon: SprayCan, area: 'dispatch' },
  { name: 'Services', href: '/services', icon: Settings, area: 'settings' },
  { name: 'Spring Letters', href: '/spring-letters', icon: Mail, area: 'documents' },
  { name: 'Tickets', href: '/tickets', icon: Ticket, area: 'dispatch' },
  { name: 'Web Requests', href: '/web-requests', icon: Globe, area: 'clients' },
  { name: 'Automation', href: '/automation', icon: CloudSun, area: 'settings' },
  { name: 'Team', href: '/team', icon: UserCog, area: 'team' },
  { name: 'Feedback', href: '/feedback', icon: MessageSquarePlus },
  { name: 'Settings', href: '/settings', icon: Settings2, area: 'settings' },
];

export function AdminLayout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { signOut } = useClerk();
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const { data: me } = useMe();
  const nav = ADMIN_NAV.filter((item) => !item.area || canOpen(me, item.area));

  return (
    <div className="min-h-[100dvh] flex flex-col md:flex-row bg-background">
      {/* Mobile Header */}
      <div className="md:hidden flex items-center justify-between p-4 bg-sidebar border-b border-sidebar-border text-sidebar-foreground">
        <div className="flex items-center gap-2">
          <img src={`${basePath}/logo-mark.png`} alt="Logo" className="w-8 h-8 rounded-sm bg-white p-1" />
          <span className="font-bold text-lg">Bison CRM</span>
        </div>
        <div className="flex items-center gap-1">
          <GlobalSearch />
          <Button variant="ghost" size="icon" className="text-white hover:bg-sidebar-accent" onClick={() => setMobileMenuOpen(!mobileMenuOpen)}>
            <Menu className="w-6 h-6" />
          </Button>
        </div>
      </div>

      {/* Sidebar */}
      <div className={`
        ${mobileMenuOpen ? 'block' : 'hidden'} 
        md:block md:w-64 flex-shrink-0 bg-sidebar border-r border-sidebar-border text-sidebar-foreground flex flex-col h-[100dvh] md:sticky md:top-0
      `}>
        <div className="p-6 hidden md:flex items-center gap-3">
          <img src={`${basePath}/logo-mark.png`} alt="Logo" className="w-10 h-10 rounded-sm bg-white p-1 shadow-sm" />
          <span className="font-bold text-xl tracking-tight">Bison CRM</span>
        </div>
        
        <nav className="flex-1 overflow-y-auto py-4 px-3 flex flex-col gap-1">
          {nav.map((item) => {
            const active = location.startsWith(item.href);
            return (
              <Link 
                key={item.href} 
                href={item.href}
                className={`
                  flex items-center gap-3 px-3 py-2 rounded-md transition-colors text-sm font-medium
                  ${active 
                    ? 'bg-sidebar-primary text-sidebar-primary-foreground shadow-sm' 
                    : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
                  }
                `}
                onClick={() => setMobileMenuOpen(false)}
              >
                <item.icon className={`w-5 h-5 ${active ? 'text-accent' : 'text-sidebar-foreground/70'}`} />
                {item.name}
              </Link>
            );
          })}
        </nav>

        <div className="p-4 border-t border-sidebar-border">
          <Button 
            variant="ghost" 
            className="w-full justify-start text-sidebar-foreground hover:bg-sidebar-accent hover:text-white"
            onClick={() => signOut({ redirectUrl: basePath || "/" })}
          >
            <LogOut className="w-5 h-5 mr-3 opacity-70" />
            Sign Out
          </Button>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0 h-[100dvh] overflow-hidden bg-background">
        {/* Desktop header: one search box that finds a customer, a job or an
            invoice from any screen, the way the search icon in his old top bar did. */}
        <div className="hidden md:flex items-center justify-end gap-2 px-6 py-2 border-b bg-card/60">
          <GlobalSearch />
        </div>
        <main className="flex-1 overflow-y-auto">
          {children}
        </main>
      </div>

      <FeedbackButton />
    </div>
  );
}
