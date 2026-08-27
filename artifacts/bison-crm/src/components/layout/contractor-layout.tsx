import { Link, useLocation } from 'wouter';
import { useClerk } from '@clerk/react';
import { Map, ListTodo, LogOut } from 'lucide-react';
import { FeedbackButton } from '@/components/feedback-button';

export function ContractorLayout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { signOut } = useClerk();
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

  const tabs = [
    { name: 'My Jobs', href: '/my/jobs', icon: ListTodo },
    { name: 'My Route', href: '/my/route', icon: Map },
  ];

  return (
    <div className="flex flex-col min-h-[100dvh] bg-background">
      {/* Mobile Top Bar */}
      <header className="flex items-center justify-between p-4 bg-sidebar text-sidebar-foreground shadow-sm sticky top-0 z-10">
        <div className="flex items-center gap-2">
          <img src={`${basePath}/logo-mark.png`} alt="Logo" className="w-8 h-8 rounded-sm bg-white p-1" />
          <span className="font-bold text-lg">Bison Field</span>
        </div>
        <button 
          onClick={() => signOut({ redirectUrl: basePath || "/" })}
          className="p-2 text-sidebar-foreground/80 hover:text-white rounded-full hover:bg-sidebar-accent"
        >
          <LogOut className="w-5 h-5" />
        </button>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 overflow-y-auto pb-20 bg-muted/30">
        {children}
      </main>

      {/* Bottom Nav */}
      <nav className="fixed bottom-0 w-full bg-white border-t border-border flex items-center justify-around pb-safe">
        {tabs.map((tab) => {
          const active = location.startsWith(tab.href);
          return (
            <Link 
              key={tab.href}
              href={tab.href}
              className={`flex-1 flex flex-col items-center justify-center py-3 px-2 gap-1
                ${active ? 'text-primary font-semibold' : 'text-muted-foreground font-medium'}
              `}
            >
              <tab.icon className={`w-6 h-6 ${active ? 'text-accent' : ''}`} />
              <span className="text-xs">{tab.name}</span>
            </Link>
          );
        })}
      </nav>

      <FeedbackButton />
    </div>
  );
}
