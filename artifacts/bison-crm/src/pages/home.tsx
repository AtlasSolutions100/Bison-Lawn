import { Link } from 'wouter';
import { Button } from '@/components/ui/button';
import { ArrowRight, Leaf, Map, DollarSign, CalendarCheck } from 'lucide-react';

export default function Home() {
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

  return (
    <div className="min-h-[100dvh] flex flex-col bg-background selection:bg-primary/20">
      <header className="absolute top-0 w-full p-6 flex items-center justify-between z-10">
        <div className="flex items-center gap-3">
          <img src={`${basePath}/logo.svg`} alt="Bison Lawn Care Logo" className="w-12 h-12 rounded-md shadow-sm" />
          <span className="font-bold text-2xl tracking-tight text-foreground">Bison Lawn Care</span>
        </div>
        <div className="flex items-center gap-4">
          <Link href="/sign-in" className="text-sm font-semibold text-foreground hover:text-primary transition-colors">
            Sign In
          </Link>
          <Button asChild className="bg-primary text-primary-foreground hover:bg-primary/90 font-semibold shadow-md">
            <Link href="/sign-up">Sign Up</Link>
          </Button>
        </div>
      </header>

      <main className="flex-1 flex flex-col items-center justify-center pt-24 pb-12 px-4 relative overflow-hidden">
        {/* Background decorative elements */}
        <div className="absolute top-[-10%] right-[-5%] w-[600px] h-[600px] rounded-full bg-primary/5 blur-3xl pointer-events-none" />
        <div className="absolute bottom-[-10%] left-[-10%] w-[500px] h-[500px] rounded-full bg-accent/10 blur-3xl pointer-events-none" />

        <div className="max-w-4xl w-full text-center space-y-8 z-10">
          <h1 className="text-5xl md:text-7xl font-extrabold tracking-tight text-foreground leading-[1.1]">
            Field Operations, <br className="hidden md:block"/>
            <span className="text-primary relative whitespace-nowrap">
              <span className="relative z-10">Built for Speed.</span>
              <span className="absolute bottom-1 left-0 w-full h-4 bg-accent/40 -z-10 rounded-sm"></span>
            </span>
          </h1>
          
          <p className="text-xl md:text-2xl text-muted-foreground max-w-2xl mx-auto leading-relaxed">
            A fast, no-nonsense hub to run leads, pricing, dispatch, and money—while your crew runs their day from their phone.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 pt-8">
            <Button asChild size="lg" className="h-14 px-8 text-lg bg-primary text-primary-foreground hover:bg-primary/90 shadow-xl shadow-primary/20">
              <Link href="/sign-in">
                Access Operations <ArrowRight className="ml-2 w-5 h-5" />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline" className="h-14 px-8 text-lg border-2 bg-white/50 backdrop-blur-sm shadow-sm">
              <Link href="/sign-up">Contractor Onboarding</Link>
            </Button>
          </div>
        </div>

        <div className="mt-24 grid grid-cols-1 md:grid-cols-4 gap-8 max-w-6xl w-full z-10 px-4">
          <FeatureCard 
            icon={Map} 
            title="Smart Dispatch" 
            desc="Visual routing, live job status, and seamless contractor assignment." 
          />
          <FeatureCard 
            icon={DollarSign} 
            title="Instant Pricing" 
            desc="Equation-based calculators for sqft pricing that generate instant estimates." 
          />
          <FeatureCard 
            icon={Leaf} 
            title="Field App" 
            desc="Mobile-first view for contractors to check routes and complete jobs fast." 
          />
          <FeatureCard 
            icon={CalendarCheck} 
            title="Job Tracking" 
            desc="Never drop a lead. Waiting lists, open invoices, and full client history." 
          />
        </div>

        <footer className="mt-24 mb-8 flex items-center gap-6 text-sm text-muted-foreground z-10">
          <span>Bison Lawn Care LLC</span>
          <Link href="/privacy" className="hover:text-foreground underline-offset-4 hover:underline">Privacy</Link>
          <Link href="/terms" className="hover:text-foreground underline-offset-4 hover:underline">Terms</Link>
        </footer>
      </main>
    </div>
  );
}

function FeatureCard({ icon: Icon, title, desc }: { icon: any, title: string, desc: string }) {
  return (
    <div className="bg-card/80 backdrop-blur-md p-6 rounded-2xl border border-border shadow-sm hover:shadow-md transition-shadow">
      <div className="w-12 h-12 bg-primary/10 text-primary rounded-xl flex items-center justify-center mb-4">
        <Icon className="w-6 h-6" />
      </div>
      <h3 className="font-bold text-lg text-foreground mb-2">{title}</h3>
      <p className="text-muted-foreground text-sm leading-relaxed">{desc}</p>
    </div>
  );
}
