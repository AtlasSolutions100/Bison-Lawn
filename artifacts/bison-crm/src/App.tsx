import { type ReactNode, useEffect, useRef } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { ClerkProvider, SignIn, SignUp, Show, useAuth, useClerk } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';
import { shadcn } from '@clerk/themes';
import { Route, Switch, useLocation, Router as WouterRouter } from 'wouter';

import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import Home from '@/pages/home';

// Page imports
import Dashboard from '@/pages/dashboard';
import Clients from '@/pages/clients';
import ClientDetail from '@/pages/client-detail';
import Services from '@/pages/services';
import Estimates from '@/pages/estimates';
import WaitingList from '@/pages/waiting-list';
import Dispatch from '@/pages/dispatch';
import Invoices from '@/pages/invoices';
import Tickets from '@/pages/tickets';
import Automation from '@/pages/automation';
import Team from '@/pages/team';
import MyJobs from '@/pages/my-jobs';
import MyRoute from '@/pages/my-route';

import { AdminLayout } from '@/components/layout/admin-layout';
import { ContractorLayout } from '@/components/layout/contractor-layout';

import { useGetCurrentUser } from '@workspace/api-client-react';

const queryClient = new QueryClient();

const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || "/"
    : path;
}

if (!clerkPubKey) {
  throw new Error('Missing VITE_CLERK_PUBLISHABLE_KEY in .env file');
}

const clerkAppearance = {
  theme: shadcn,
  cssLayerName: "clerk",
  options: {
    logoPlacement: "inside" as const,
    logoLinkUrl: basePath || "/",
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
  },
  variables: {
    colorPrimary: "hsl(145, 50%, 25%)",
    colorForeground: "hsl(30, 30%, 15%)",
    colorMutedForeground: "hsl(30, 15%, 45%)",
    colorDanger: "hsl(10, 70%, 45%)",
    colorBackground: "hsl(40, 10%, 100%)",
    colorInput: "hsl(40, 20%, 97%)",
    colorInputForeground: "hsl(30, 30%, 15%)",
    colorNeutral: "hsl(30, 20%, 88%)",
    fontFamily: "Inter, sans-serif",
    borderRadius: "0.25rem",
  },
  elements: {
    rootBox: "w-full flex justify-center",
    cardBox: "bg-white rounded-lg w-[440px] max-w-full overflow-hidden shadow-xl border border-[hsl(30,20%,88%)]",
    card: "!shadow-none !border-0 !bg-transparent !rounded-none",
    footer: "!shadow-none !border-0 !bg-transparent !rounded-none",
    headerTitle: "text-[hsl(30,30%,15%)] font-bold",
    headerSubtitle: "text-[hsl(30,15%,45%)]",
    socialButtonsBlockButtonText: "text-[hsl(30,30%,15%)] font-medium",
    formFieldLabel: "text-[hsl(30,30%,15%)] font-semibold",
    footerActionLink: "text-[hsl(145,50%,25%)] hover:text-[hsl(145,50%,20%)]",
    footerActionText: "text-[hsl(30,15%,45%)]",
    dividerText: "text-[hsl(30,15%,45%)]",
    identityPreviewEditButton: "text-[hsl(145,50%,25%)]",
    formFieldSuccessText: "text-[hsl(145,50%,25%)]",
    alertText: "text-[hsl(10,70%,45%)]",
    logoBox: "h-12 flex justify-center mb-4",
    logoImage: "h-full w-auto",
    socialButtonsBlockButton: "border-[hsl(30,20%,88%)] bg-[hsl(40,20%,97%)]",
    formButtonPrimary: "bg-[hsl(45,95%,55%)] text-[hsl(30,40%,15%)] hover:bg-[hsl(45,90%,50%)]",
    formFieldInput: "bg-[hsl(40,20%,97%)] border-[hsl(30,20%,88%)] text-[hsl(30,30%,15%)]",
    footerAction: "border-t border-[hsl(30,20%,88%)] pt-4",
    dividerLine: "bg-[hsl(30,20%,88%)]",
    alert: "bg-[hsl(10,70%,95%)] border-[hsl(10,70%,45%)]",
    otpCodeFieldInput: "bg-[hsl(40,20%,97%)] border-[hsl(30,20%,88%)] text-[hsl(30,30%,15%)]",
    formFieldRow: "mb-4",
    main: "px-6 py-8",
  },
};

function SignInPage() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
      <SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} />
    </div>
  );
}

function SignUpPage() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
      <SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} />
    </div>
  );
}

function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const queryClient = useQueryClient();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const unsubscribe = addListener(({ user }) => {
      const userId = user?.id ?? null;
      if (prevUserIdRef.current !== userId) {
        queryClient.clear();
      }
      prevUserIdRef.current = userId;
    });
    return unsubscribe;
  }, [addListener, queryClient]);

  return null;
}

function useCurrentAppUser() {
  const { isLoaded, isSignedIn } = useAuth();
  const query = useGetCurrentUser({
    query: {
      enabled: isLoaded && isSignedIn,
      queryKey: ['me'],
      retry: false,
    },
  });

  return {
    ...query,
    authIsLoaded: isLoaded,
    isSignedIn,
  };
}

function SessionError({
  retry,
  signOut,
}: {
  retry: () => void;
  signOut: () => void;
}) {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
      <div className="w-full max-w-md rounded-lg border bg-card p-8 text-center shadow-sm">
        <h1 className="text-xl font-semibold text-foreground">We couldn't finish signing you in</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Your account is signed in, but the app could not load your profile.
        </p>
        <div className="mt-6 flex justify-center gap-3">
          <button
            type="button"
            onClick={retry}
            className="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
          >
            Try again
          </button>
          <button
            type="button"
            onClick={signOut}
            className="rounded border px-4 py-2 text-sm font-medium text-foreground"
          >
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}

function HomeRedirect() {
  const { data: user, isLoading, isError, refetch, authIsLoaded, isSignedIn } = useCurrentAppUser();
  const { signOut } = useClerk();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (user && !isLoading) {
      if (user.role === 'admin') {
        setLocation('/dashboard');
      } else {
        setLocation('/my/jobs');
      }
    }
  }, [user, isLoading, setLocation]);

  if (!authIsLoaded) {
    return <div className="flex h-[100dvh] items-center justify-center text-muted-foreground">Loading...</div>;
  }
  if (!isSignedIn) return <Home />;
  if (isError) {
    return (
      <SessionError
        retry={() => void refetch()}
        signOut={() => void signOut({ redirectUrl: basePath || '/' })}
      />
    );
  }
  return (
    <div className="flex h-[100dvh] w-full items-center justify-center">
      <div className="text-muted-foreground animate-pulse">Loading...</div>
    </div>
  );
}

function AdminRoute({ component: Component }: { component: any }) {
  const { data: user, isLoading, isError, refetch } = useCurrentAppUser();
  const { signOut } = useClerk();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (!isLoading && user?.role === 'contractor') {
      setLocation('/my/jobs');
    }
  }, [user, isLoading, setLocation]);

  if (isError) {
    return (
      <SessionError
        retry={() => void refetch()}
        signOut={() => void signOut({ redirectUrl: basePath || '/' })}
      />
    );
  }
  if (isLoading || !user) return <div className="flex h-screen items-center justify-center">Loading...</div>;
  if (user.role === 'contractor') return null;

  return (
    <AdminLayout>
      <Component />
    </AdminLayout>
  );
}

function ContractorRoute({ component: Component }: { component: any }) {
  const { data: user, isLoading, isError, refetch } = useCurrentAppUser();
  const { signOut } = useClerk();
  if (isError) {
    return (
      <SessionError
        retry={() => void refetch()}
        signOut={() => void signOut({ redirectUrl: basePath || '/' })}
      />
    );
  }
  if (isLoading || !user) return <div className="flex h-[100dvh] items-center justify-center">Loading...</div>;

  return (
    <ContractorLayout>
      <Component />
    </ContractorLayout>
  );
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();

  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      appearance={clerkAppearance}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      localization={{
        signIn: {
          start: {
            title: "Welcome back",
            subtitle: "Sign in to Bison Lawn Care",
          },
        },
      }}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <QueryClientProvider client={queryClient}>
        <ClerkQueryClientCacheInvalidator />
        <TooltipProvider>
          <RoutedErrorBoundary>
            <Switch>
              <Route path="/" component={HomeRedirect} />
              <Route path="/sign-in/*?" component={SignInPage} />
              <Route path="/sign-up/*?" component={SignUpPage} />

              {/* Admin Routes */}
              <Route path="/dashboard"><Show when="signed-in"><AdminRoute component={Dashboard} /></Show></Route>
              <Route path="/clients"><Show when="signed-in"><AdminRoute component={Clients} /></Show></Route>
              <Route path="/clients/:id"><Show when="signed-in"><AdminRoute component={ClientDetail} /></Show></Route>
              <Route path="/services"><Show when="signed-in"><AdminRoute component={Services} /></Show></Route>
              <Route path="/estimates"><Show when="signed-in"><AdminRoute component={Estimates} /></Show></Route>
              <Route path="/waiting-list"><Show when="signed-in"><AdminRoute component={WaitingList} /></Show></Route>
              <Route path="/dispatch"><Show when="signed-in"><AdminRoute component={Dispatch} /></Show></Route>
              <Route path="/invoices"><Show when="signed-in"><AdminRoute component={Invoices} /></Show></Route>
              <Route path="/tickets"><Show when="signed-in"><AdminRoute component={Tickets} /></Show></Route>
              <Route path="/automation"><Show when="signed-in"><AdminRoute component={Automation} /></Show></Route>
              <Route path="/team"><Show when="signed-in"><AdminRoute component={Team} /></Show></Route>

              {/* Contractor Routes */}
              <Route path="/my/jobs"><Show when="signed-in"><ContractorRoute component={MyJobs} /></Show></Route>
              <Route path="/my/route"><Show when="signed-in"><ContractorRoute component={MyRoute} /></Show></Route>

              <Route component={NotFound} />
            </Switch>
          </RoutedErrorBoundary>
        </TooltipProvider>
        <Toaster />
      </QueryClientProvider>
    </ClerkProvider>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return (
    <WouterRouter base={basePath}>
      <ClerkProviderWithRoutes />
    </WouterRouter>
  );
}

export default App;
