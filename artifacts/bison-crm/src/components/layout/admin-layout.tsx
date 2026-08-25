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
  Globe
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useState } from 'react';

const ADMIN_NAV = [
  { name: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
  { name: 'Dispatch', href: '/dispatch', icon: Truck },
  { name: 'Waiting List', href: '/waiting-list', icon: ListTodo },
  { name: 'Clients', href: '/clients', icon: Users },
  { name: 'Estimates', href: '/estimates', icon: FileText },
  { name: 'Invoices', href: '/invoices', icon: Receipt },
  { name: 'Spray Runs', href: '/spray-runs', icon: SprayCan },
  { name: 'Services', href: '/services', icon: Settings },
  { name: 'Spring Letters', href: '/spring-letters', icon: Mail },
  { name: 'Tickets', href: '/tickets', icon: Ticket },
  { name: 'Web Requests', href: '/web-requests', icon: Globe },
  { name: 'Automation', href: '/automation', icon: CloudSun },
  { name: 'Team', href: '/team', icon: UserCog },
];

export function AdminLayout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { signOut } = useClerk();
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <div className="min-h-[100dvh] flex flex-col md:flex-row bg-background">
      {/* Mobile Header */}
      <div className="md:hidden flex items-center justify-between p-4 bg-sidebar border-b border-sidebar-border text-sidebar-foreground">
        <div className="flex items-center gap-2">
          <img src={`${basePath}/logo.svg`} alt="Logo" className="w-8 h-8 rounded-sm bg-white p-1" />
          <span className="font-bold text-lg">Bison CRM</span>
        </div>
        <Button variant="ghost" size="icon" className="text-white hover:bg-sidebar-accent" onClick={() => setMobileMenuOpen(!mobileMenuOpen)}>
          <Menu className="w-6 h-6" />
        </Button>
      </div>

      {/* Sidebar */}
      <div className={`
        ${mobileMenuOpen ? 'block' : 'hidden'} 
        md:block md:w-64 flex-shrink-0 bg-sidebar border-r border-sidebar-border text-sidebar-foreground flex flex-col h-[100dvh] md:sticky md:top-0
      `}>
        <div className="p-6 hidden md:flex items-center gap-3">
          <img src={`${basePath}/logo.svg`} alt="Logo" className="w-10 h-10 rounded-sm bg-white p-1 shadow-sm" />
          <span className="font-bold text-xl tracking-tight">Bison CRM</span>
        </div>
        
        <nav className="flex-1 overflow-y-auto py-4 px-3 flex flex-col gap-1">
          {ADMIN_NAV.map((item) => {
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
        <main className="flex-1 overflow-y-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
