import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { X } from 'lucide-react';

import AuthContent from '@/features/auth/components/auth-content';
import AuthFooter from '@/features/auth/components/auth-footer';
import LoginForm from '@/features/auth/components/login-form';
import { authClient } from '@/lib/auth-client';

export const Route = createFileRoute('/(auth)/login')({
  component: LoginPage,
});

function LoginPage() {
  const navigate = useNavigate();
  const { data: session } = authClient.useSession();
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    if (session?.user?.id) {
      navigate({ to: '/home', replace: true });
    }
  }, [session, navigate]);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduceMotion(mq.matches);
    const handler = (e: MediaQueryListEvent) => setReduceMotion(e.matches);
    mq.addEventListener?.('change', handler);
    return () => mq.removeEventListener?.('change', handler);
  }, []);

  return (
    <>
      {!reduceMotion && (
        <div
          aria-hidden={true}
          className="login-animated-mesh absolute top-24 right-0 bottom-0 left-0 m-auto h-1/2 w-1/2"
        />
      )}
      <div aria-hidden className="absolute top-0 left-0 z-0 size-full bg-black/70 backdrop-blur-3xl" />

      <main className="relative flex h-full items-center justify-center">
        <Link
          to="/"
          aria-label="Close and go to home"
          className="text-foreground absolute top-2 left-2 rounded-full bg-white/[0.03] p-1 transition-colors duration-200 hover:bg-white/5 md:top-8"
        >
          <X size={18} />
        </Link>

        <div className="animate-fade-in relative bottom-[70px]">
          <AuthContent
            title="Login to FrameRate"
            description="If you have access to FrameRate, you can enter your email below."
          />

          <section>
            <LoginForm />
          </section>
        </div>
      </main>

      <AuthFooter
        text="Don't have an account yet?"
        linkText="Sign up"
        linkTo="/signup"
      />
    </>
  );
}
